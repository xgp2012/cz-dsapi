import http from 'node:http';

/**
 * 一个假的 DeepSeek 网页：DOM 结构、class 名、流式节奏都照着真实页面来。
 * 用来验证 Playwright 驱动（输入 → 发送 → 流式读取 → 新对话）而不依赖网络和账号。
 *
 * 页面里的 reply() 会真的 fetch /api/v0/chat/completion（SSE），按事件把文本写进 DOM，
 * 这样驱动才能同时验证「DOM 流式展示」和「原始补全流兜底」两条链路。
 *
 * 场景开关（按 prompt 里的标记）：
 *   USE_TOOL                回答末尾带 DO 工具调用
 *   USE_TOOL_DROP_DOM       原始 SSE 里有 DO，但 DOM 故意丢掉尾部 DO 块（模拟 DOM 截断/回退）
 *   LATE_THINK              思考块晚 500ms 才出现
 *   CAPTURE_ONLY            只让原始 SSE 有内容，DOM 一个字符都不写（模拟 DOM 读不到 / 提前结束）
 *   DOM_ROLLBACK            答案完整出现后，DOM 又回退把尾部 DO 块吞掉（模拟重渲染缩短）
 *   RATE_LIMIT              原始流只回 event: hint（限流提示）
 *   DIVERGE_TRUNCATE        回答中途 DOM 停止更新（永久滞后），且 DOM 的 markdown 反向序列化与
 *                           模型原始文本不是前缀关系（空行数量/行尾空格差异）
 *   DIVERGE_LAG             同上，但生成结束后页面渲染追平（最终 DOM 含完整尾部）
 *   DOUBLE_COMPLETION       同一轮页面先发一次会被中断的 completion 请求，再重试一次完整请求；
 *                           只有第二次写入 DOM
 *   TAIL_AFTER_TOOL         回答先给 DO 工具调用，后面还有一段自然语言尾巴
 *   CAPTURE_FAIL            原始 SSE 内容发完但连接被掐断（response.text() 读失败），DOM 完整
 *   CAPTURE_FAIL_TRUNCATED  原始 SSE 只发一半就掐断，DOM 也只显示一半，且停止按钮一直不消失
 *                           （模拟页面卡在生成中：DOM 与原始流都不完整）
 *   FABRICATE_LOOP          先输出 DO 工具调用，再自己编造 RESULT，然后每 ~20ms 无限续写
 *                           （模拟「编造 RESULT 后停不下来」；点停止按钮才结束，次数暴露在
 *                           window.__FAKE_STOP_COUNT__）
 */
export function fakeDeepSeekPage() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>Fake DeepSeek</title>
<style>
  body { font: 14px system-ui; padding: 12px; }
  textarea { width: 520px; height: 80px; }
  #messages { margin-bottom: 12px; }
  .ds-assistant-message-main-content { border: 1px solid #eee; padding: 6px; margin: 6px 0; }
</style></head>
<body>
  <button id="new-chat">开启新对话</button>
  <div id="messages"></div>
  <div id="composer">
    <textarea placeholder="给 DeepSeek 发送消息"></textarea>
  </div>
<script>
(() => {
  const messages = document.getElementById('messages');
  const input = document.querySelector('textarea');
  const composer = document.getElementById('composer');
  const COMPLETION_URL = '/api/v0/chat/completion';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let stopButton = null;

  function showStop() {
    if (stopButton) return;
    stopButton = document.createElement('button');
    stopButton.setAttribute('aria-label', '停止生成');
    stopButton.textContent = '停止生成';
    composer.appendChild(stopButton);
  }
  function hideStop() {
    if (stopButton) stopButton.remove();
    stopButton = null;
  }

  // 极简 markdown 渲染：只处理标题 / 无序列表 / 段落，够驱动 page-scripts 的反向序列化
  function renderStructured(el, md) {
    el.innerHTML = '';
    const lines = String(md).split('\\n');
    let list = null;
    for (const line of lines) {
      if (!line.trim()) {
        list = null;
        continue;
      }
      const heading = /^(#{1,3})\\s+(.*)$/.exec(line);
      if (heading) {
        const h = document.createElement('h' + heading[1].length);
        h.textContent = heading[2].trim();
        el.appendChild(h);
        list = null;
        continue;
      }
      const item = /^[-*+]\\s+(.*)$/.exec(line);
      if (item) {
        if (!list) {
          list = document.createElement('ul');
          el.appendChild(list);
        }
        const li = document.createElement('li');
        li.textContent = item[1].trim();
        list.appendChild(li);
        continue;
      }
      const p = document.createElement('p');
      p.textContent = line.trim();
      el.appendChild(p);
      list = null;
    }
  }

  async function reply(prompt) {
    const index = messages.children.length + 1;
    const block = document.createElement('div');
    block.className = 'ds-assistant-message-main-content';
    const thinkWrap = document.createElement('div');
    thinkWrap.className = 'ds-think-content';
    const think = document.createElement('div');
    think.className = 'ds-markdown';
    thinkWrap.appendChild(think);
    const answer = document.createElement('div');
    answer.className = 'ds-markdown';
    block.appendChild(thinkWrap);
    block.appendChild(answer);
    messages.appendChild(block);

    showStop();

    const captureOnly = prompt.includes('CAPTURE_ONLY');
    const dropDom = prompt.includes('USE_TOOL_DROP_DOM');
    const lateThink = prompt.includes('LATE_THINK');
    const rateLimit = prompt.includes('RATE_LIMIT');
    const diverge = prompt.includes('DIVERGE_TRUNCATE');
    const divergeLag = prompt.includes('DIVERGE_LAG');
    const structured = diverge || divergeLag;
    const doubleCompletion = prompt.includes('DOUBLE_COMPLETION');
    // 页面卡在「生成中」：停止按钮一直不消失（模拟生成没结束但流已经断了）
    const stuck = prompt.includes('CAPTURE_FAIL_TRUNCATED');
    const fabricateLoop = prompt.includes('FABRICATE_LOOP');
    const loopController = new AbortController();
    if (fabricateLoop) {
      window.__FAKE_STOP_COUNT__ = window.__FAKE_STOP_COUNT__ || 0;
      if (stopButton) {
        stopButton.addEventListener('click', () => {
          window.__FAKE_STOP_COUNT__ += 1;
          loopController.abort();
          hideStop();
        });
      }
    }

    let currentEl = null;
    let thinkShown = '';
    let answerRaw = '';
    let domFrozen = false;

    function appendThink(chunk) {
      if (captureOnly) return;
      thinkShown += chunk;
      think.textContent = thinkShown;
    }

    function renderPlain() {
      // 模拟真实页面里文本节点被压平：换行/缩进都会变成空格
      answer.textContent = answerRaw;
      if (dropDom) {
        const at = answerRaw.indexOf('DO:');
        if (at >= 0) answer.textContent = answerRaw.slice(0, at);
      }
    }

    function appendAnswer(chunk) {
      if (captureOnly) return;
      answerRaw += chunk;
      if (structured) {
        if (domFrozen) return;
        // 模拟 DOM 渲染滞后：第二条列表项一出现，页面就停止更新（永久 or 生成结束后追平）
        const at = answerRaw.indexOf('- 第二');
        if (at >= 0) {
          const lineStart = answerRaw.indexOf('\\n- 第二');
          renderStructured(answer, answerRaw.slice(0, lineStart >= 0 ? lineStart : at));
          domFrozen = true;
          return;
        }
        renderStructured(answer, answerRaw);
        return;
      }
      renderPlain();
    }

    function applyFrame(data) {
      if (!data || typeof data !== 'object') return;
      if (data.p === 'response/fragments' && (data.o || 'APPEND') === 'APPEND') {
        for (const frag of data.v || []) {
          if (!frag || typeof frag !== 'object') continue;
          if (frag.type === 'THINK') {
            currentEl = think;
            if (frag.content) appendThink(frag.content);
          } else if (frag.type === 'RESPONSE') {
            currentEl = answer;
            if (frag.content) appendAnswer(frag.content);
          }
        }
        return;
      }
      if (data.p === 'response/fragments/-1/content' && typeof data.v === 'string') {
        if (currentEl === think) appendThink(data.v);
        else if (currentEl === answer) appendAnswer(data.v);
        return;
      }
      if (data.p === 'response/status') return;
      if (typeof data.v === 'string') {
        if (currentEl === think) appendThink(data.v);
        else if (currentEl === answer) appendAnswer(data.v);
      }
    }

    async function consumeSse(options) {
      const attempt = (options && options.attempt) || 1;
      const apply = !options || options.apply !== false;
      const res = await fetch(COMPLETION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: options && options.signal,
        body: JSON.stringify({
          prompt: prompt,
          index: index,
          mode: dropDom ? 'drop_dom' : 'normal',
          attempt: attempt,
        }),
      });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf('\\n\\n')) >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const dataLine = frame.split('\\n').find((line) => line.startsWith('data:'));
          if (!dataLine) continue;
          let payload;
          try {
            payload = JSON.parse(dataLine.slice(5).trim());
          } catch (err) {
            continue;
          }
          if (apply) applyFrame(payload);
        }
      }
    }

    // 模拟真实页面：思考块先空着，500ms 后才把思考内容挂进 DOM
    if (lateThink) await sleep(500);

    try {
      if (rateLimit) {
        // 限流场景：只消费一个 hint 事件，DOM 保持空白
        await fetch(COMPLETION_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: prompt, index: index, mode: 'rate_limit', attempt: 1 }),
        });
      } else if (fabricateLoop) {
        await consumeSse({ signal: loopController.signal });
      } else if (doubleCompletion) {
        // 第一次请求会被服务端中断（页面重试），只有第二次写入 DOM
        try {
          await consumeSse({ attempt: 1, apply: false });
        } catch (err) {
          /* 第一次中断是预期行为 */
        }
        await consumeSse({ attempt: 2 });
      } else {
        await consumeSse();
      }

      // DOM 渲染在生成结束后追平：最终 DOM 一定以流式期间的文本为前缀扩展
      if (divergeLag) {
        domFrozen = false;
        renderStructured(answer, answerRaw);
      }

      if (prompt.includes('DOM_ROLLBACK')) {
        // 模拟网页重渲染：答案已经完整显示过，结尾的 DO 块又被 DOM 吞掉
        await sleep(250);
        const at = answerRaw.indexOf('DO:');
        answer.textContent = at >= 0 ? answerRaw.slice(0, at) : answerRaw;
      }
    } catch (err) {
      // 端点异常时退化成固定回答，别让整条驱动链路因为 fake 服务抖动挂掉
      if (!captureOnly && !answerRaw) {
        answer.textContent = '回答#' + index;
      }
    } finally {
      // 卡住场景保留停止按钮，模拟「页面仍在生成」的错觉
      if (!stuck) hideStop();
    }
  }

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    const prompt = input.value;
    input.value = '';
    reply(prompt);
  });

  document.getElementById('new-chat').addEventListener('click', () => {
    messages.innerHTML = '';
    input.value = '';
    input.focus();
    hideStop();
  });
})();
</script>
</body></html>`;
}

export function fakeSignInPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>登录</title></head>
<body><h1>请登录 DeepSeek</h1><button>使用手机号登录</button></body></html>`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 假页面对应场景的「模型原始输出」 */
function answerFor(text, index) {
  if (text.includes('DIVERGE_TRUNCATE')) {
    // 故意带多余空行和行尾空格：DOM 反向序列化会压缩，两边不是前缀关系
    return '## 小标题\n\n\n- 第一项  \n- 第二项\n\n最后一段总结。';
  }
  if (text.includes('DIVERGE_LAG')) {
    return '## 小标题\n\n\n- 第一项  \n- 第二项\n\n最后一段总结。';
  }
  if (text.includes('TAIL_AFTER_TOOL')) {
    return '执行一下\nDO:{"name":"exec_shell","args":{"command":"uname -a"}}\n\n执行完成，内核版本如上。';
  }
  if (text.includes('DOUBLE_COMPLETION')) {
    return '第一段\n\n第二次请求的完整回答，只应出现一次。';
  }
  if (text.includes('CAPTURE_FAIL_TRUNCATED')) return '捕获失败时这段回答只写了一半';
  if (text.includes('FABRICATE_LOOP')) {
    return '好的\nDO:{"name":"exec_shell","args":{"command":"uname -a"}}\nRESULT:{"name":"exec_shell","result":"假结果"}\n';
  }
  if (text.includes('CAPTURE_FAIL')) return '捕获失败但 DOM 里有完整回答。';
  if (text.includes('USE_TOOL')) {
    return '执行命令\nDO:{"name":"exec_shell","args":{"command":"uname -a"}}';
  }
  if (text.includes('CAPTURE_ONLY')) return '原始流里的回答';
  return `回答#${Number(index) || 1}`;
}

/** 按真实补全协议产出一段 SSE：初始快照 → THINK 片段 → RESPONSE 片段 → FINISHED */
async function streamCompletion(res, { prompt = '', index = 1, attempt = 1 } = {}) {
  const text = String(prompt);
  const attemptNo = Number(attempt) || 1;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  const send = (payload) => {
    if (closed || res.writableEnded) return false;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  };

  if (text.includes('RATE_LIMIT')) {
    const hint = {
      type: 'error',
      content: '消息发送过于频繁，请稍后重试',
      clear_response: true,
      finish_reason: 'rate_limit_reached',
    };
    res.write(`event: hint\ndata: ${JSON.stringify(hint)}\n\n`);
    res.end();
    return;
  }

  // 场景：页面重试前的那次请求被中断（半截流）；捕获失败场景则是发完后/半途掐断连接
  const doubleRetry = text.includes('DOUBLE_COMPLETION') && attemptNo === 1;
  const captureFailTruncated = text.includes('CAPTURE_FAIL_TRUNCATED');
  const captureFail = text.includes('CAPTURE_FAIL') && !captureFailTruncated;

  const thinking = '先想一想';
  const answer = answerFor(text, index);

  const abortMidway = (cutChars) => {
    const partial = answer.slice(0, cutChars);
    send({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: partial }] });
    res.destroy(); // 直接掐断 TCP 连接：response.text() 会 reject
  };

  send({ v: { response: { message_id: 'fake-message-1', fragments: [] } } });
  await sleep(3);
  send({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'THINK', content: '' }] });
  for (const ch of thinking) {
    if (!send({ p: 'response/fragments/-1/content', v: ch })) return;
    await sleep(3);
  }

  if (doubleRetry) {
    // 第一次请求：只给半段就断，页面随后重试
    abortMidway(Math.max(2, Math.ceil(answer.length / 3)));
    return;
  }
  if (captureFailTruncated) {
    abortMidway(Math.max(2, Math.ceil(answer.length / 2)));
    return;
  }

  send({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: '' }] });
  // DIVERGE 场景：DOM 在第二条列表项之前就停止更新；这里让模型「停顿」1.2s 再继续，
  // 用来复现「DOM 文本稳定 > SETTLE_MS 但生成其实还在继续」的提前结束丢流边界
  const pauseAt = text.includes('DIVERGE') ? answer.indexOf('- 第二') : -1;
  for (let i = 0; i < answer.length; i += 1) {
    if (pauseAt > 0 && i === pauseAt) await sleep(1200);
    if (!send({ p: 'response/fragments/-1/content', v: answer[i] })) return;
    await sleep(2);
  }

  // FABRICATE_LOOP：先把带 RESULT 的回答发完，然后每 20ms 无限续写，
  // 直到客户端停止/断开（最多 60s）——模拟「编造 RESULT 后停不下来」
  if (text.includes('FABRICATE_LOOP')) {
    const deadline = Date.now() + 60_000;
    while (!closed && !res.destroyed && Date.now() < deadline) {
      await sleep(20);
      if (!send({ p: 'response/fragments/-1/content', v: ' 继续写...' })) return;
    }
    if (!res.destroyed) res.end();
    return;
  }

  if (captureFail) {
    // 内容都发出去了，但连接被掐断：DOM 能拿到完整文本，response.text() 失败
    res.destroy();
    return;
  }

  send({ p: 'response/status', o: 'SET', v: 'FINISHED' });
  if (!res.writableEnded) res.end();
}

function readJson(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 5_000_000) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

export async function startFakeDeepSeek() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/sign_in')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fakeSignInPage());
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fakeDeepSeekPage());
    }
    if (url.pathname === '/api/v0/chat/completion') {
      return readJson(req)
        .then((body) => streamCompletion(res, body))
        .catch(() => {
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('fake completion error');
        });
    }
    res.writeHead(404).end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
