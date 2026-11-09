#!/usr/bin/env node
/**
 * 端到端功能验证：真起 cz-dsapi 服务 + 假 DeepSeek 上游，逐项检查每个对外功能。
 *
 *   node test/e2e/run.mjs            # 全部
 *   node test/e2e/run.mjs --only auth
 *
 * 与 test/ 下的单测互补：单测验证模块行为，这里验证「整条链路」——
 * HTTP 入口 → 归一化 → prompt 组装 → direct 引擎 → 假上游 → 解析 → 输出协议。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > -1 ? process.argv[i + 1] : null;
})();

/* ------------------------------------------------------------------ *
 * 结果收集
 * ------------------------------------------------------------------ */
const results = [];
function check(name, ok, extra = '') {
  results.push({ name, ok, extra });
  const mark = ok ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✖\x1b[0m';
  console.log(`${mark} ${name}${extra ? `  \x1b[90m${extra}\x1b[0m` : ''}`);
}

/* ------------------------------------------------------------------ *
 * 起假上游
 * ------------------------------------------------------------------ */
function startUpstream() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(here, 'fake-upstream.mjs')], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: { ...process.env, FAKE_PORT: '0' },
    });
    let buf = '';
    child.stdout.on('data', (c) => {
      buf += c;
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        try {
          resolve({ url: JSON.parse(buf.slice(0, nl)).url, child });
        } catch (err) {
          reject(err);
        }
      }
    });
    child.on('error', reject);
    setTimeout(() => reject(new Error('假上游启动超时')), 10_000).unref();
  });
}

/* ------------------------------------------------------------------ *
 * 起 cz-dsapi 本体（独立进程，走真实 index.mjs 启动链）
 * ------------------------------------------------------------------ */
/** 拿一个空闲端口（PORT=0 时 index.mjs 的日志会打印 0，没法据此发现真实端口） */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startCzDsapi(env, { tokens = ['e2e-token-1', 'e2e-token-2'], dataDir: givenDir } = {}) {
  const port = await freePort();
  const dataDir = givenDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cz-dsapi-e2e-'));
  fs.writeFileSync(
    path.join(dataDir, 'auth.json'),
    JSON.stringify({ token: tokens[0], tokens }),
  );
  const child = spawn(process.execPath, [path.join(root, 'src', 'index.mjs')], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      HOST: '127.0.0.1',
      PORT: String(port),
      LOG_LEVEL: 'warn',
      SAVE_ARTIFACTS: 'false',
      WARMUP: 'false',
      DEEPSEEK_COLD_START: 'false',
      DEEPSEEK_HUMAN_TIMING: 'false',
      RATE_LIMIT_ENABLED: 'false',
      ...env,
      PORT: String(port),
    },
  });
  let buf = '';
  child.stdout.on('data', (c) => {
    buf += c;
  });
  child.stderr.on('data', (c) => {
    buf += c;
  });

  const url = `http://127.0.0.1:${port}`;
  // 轮询 /healthz 直到就绪（不依赖日志解析）
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`cz-dsapi 提前退出:\n${buf}`);
    try {
      const r = await request(`${url}/healthz`);
      if (r.status === 200) return { url, child, dataDir, log: () => buf };
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) throw new Error(`cz-dsapi 启动超时:\n${buf}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const stop = (child) =>
  new Promise((resolve) => {
    if (!child || child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 4000).unref();
  });

/* ------------------------------------------------------------------ *
 * HTTP 小工具
 * ------------------------------------------------------------------ */
function request(url, { method = 'GET', headers = {}, body, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (raw) return resolve({ status: res.statusCode, headers: res.headers, text });
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
          resolve({ status: res.statusCode, headers: res.headers, data, text });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 读 SSE 直到流结束，返回解析好的 chunk 列表 */
function readSse(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          Accept: 'text/event-stream',
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        let raw = '';
        res.on('data', (c) => {
          chunks.push(c);
          raw += c.toString('utf8');
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, chunks, raw }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function parseOpenAiSse(raw) {
  const events = [];
  for (const frame of raw.split('\n\n')) {
    const line = frame.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') {
      events.push({ done: true });
      continue;
    }
    try {
      events.push(JSON.parse(payload));
    } catch {
      /* 忽略 */
    }
  }
  return events;
}

function parseAnthropicSse(raw) {
  const events = [];
  let name = null;
  for (const frame of raw.split('\n\n')) {
    for (const line of frame.split('\n')) {
      if (line.startsWith('event: ')) name = line.slice(7).trim();
      else if (line.startsWith('data: ')) {
        try {
          events.push({ event: name, data: JSON.parse(line.slice(6)) });
        } catch {
          /* 忽略 */
        }
      }
    }
  }
  return events;
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */
const CASES = [];
const add = (name, fn) => CASES.push([name, fn]);

/* ---- 1. 健康检查 / 元信息 ---- */
add('health', async ({ srv }) => {
  const r = await request(`${srv.url}/healthz`);
  check('GET /healthz 返回 200', r.status === 200, `${r.status}`);
  check('/healthz ok=true', r.data?.ok === true);
  check('/healthz engine=direct', r.data?.engine === 'direct', String(r.data?.engine));
  check('/healthz hasToken=true', r.data?.hasToken === true);
  check('/healthz 不泄露 token 明文', !r.text.includes('e2e-token-1'));
  check('/healthz accounts 数量=2', r.data?.accounts?.length === 2, String(r.data?.accounts?.length));
});

add('landing', async ({ srv }) => {
  const r = await request(`${srv.url}/`, { raw: true });
  check('GET / 返回 HTML', r.status === 200 && /<html/i.test(r.text), `${r.status}`);
  check('首页不泄露 API Key', !/e2e-secret-key/.test(r.text));
});

add('models', async ({ srv, apiKey }) => {
  const r = await request(`${srv.url}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  check('GET /v1/models 返回 200', r.status === 200, `${r.status}`);
  const ids = (r.data?.data ?? []).map((m) => m.id);
  check('/v1/models 有模型列表', ids.length > 0, ids.join(','));
  const one = await request(`${srv.url}/v1/models/deepseek-flash`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  check('GET /v1/models/:id 返回 200', one.status === 200, `${one.status}`);
  const missing = await request(`${srv.url}/v1/models/nope`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  check('未知模型返回 404', missing.status === 404, `${missing.status}`);
});

/* ---- 2. 鉴权 ---- */
add('auth', async ({ srv, apiKey }) => {
  const noKey = await request(`${srv.url}/v1/chat/completions`, {
    method: 'POST',
    body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] },
  });
  check('无 API Key 的对话请求被拒 401', noKey.status === 401, `${noKey.status}`);
  check('错误体符合 OpenAI 格式', typeof noKey.data?.error?.message === 'string');

  const badKey = await request(`${srv.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-key' },
    body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] },
  });
  check('错误 API Key 被拒 401', badKey.status === 401, `${badKey.status}`);

  const modelsNoKey = await request(`${srv.url}/v1/models`);
  check('/v1/models 需鉴权', modelsNoKey.status === 401, `${modelsNoKey.status}`);

  const anthropicBad = await request(`${srv.url}/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': 'nope', 'anthropic-version': '2023-06-01' },
    body: { model: 'deepseek-flash', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
  });
  check('Anthropic 错误体格式（x-api-key 错误）', anthropicBad.status === 401 && anthropicBad.data?.type === 'error',
    JSON.stringify(anthropicBad.data).slice(0, 80));

  const okKey = await request(`${srv.url}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  check('正确 API Key 放行', okKey.status === 200);
});

/* ---- 3. OpenAI 非流式 ---- */
add('openai-nonstream', async ({ apiKey, up }) => {
  // 独立实例：避免和 errors 等用例并行启动时互相干扰（PoW 预取/账号池都是进程内的）
  const srv = await startCzDsapi(
    { ENGINE: 'direct', API_KEY: apiKey, DEEPSEEK_BASE_URL: up.url, POW_BIN: path.join(root, 'bin', 'ds-pow') },
    { tokens: ['nonstream-token'] },
  );
  try {
    await request(`${up.url}/__reset`);
    const r = await request(`${srv.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: { model: 'deepseek-flash', messages: [{ role: 'user', content: '你好' }] },
    });
    check('非流式返回 200', r.status === 200, `${r.status}`);
    check('object=chat.completion', r.data?.object === 'chat.completion', String(r.data?.object));
    check('有 content', (r.data?.choices?.[0]?.message?.content ?? '').length > 0,
      JSON.stringify(r.data?.choices?.[0]?.message?.content?.slice(0, 40)));
    check('finish_reason=stop', r.data?.choices?.[0]?.finish_reason === 'stop', String(r.data?.choices?.[0]?.finish_reason));
    check('有 usage', r.data?.usage?.total_tokens > 0, JSON.stringify(r.data?.usage));
    const st = (await request(`${up.url}/__stats`)).data;
    check('上游收到建会话请求', st.sessions > 0, `sessions=${st.sessions}`);
    check('上游收到 PoW 挑战请求', st.challenges > 0, `challenges=${st.challenges}`);
    check('completion 带 x-ds-pow-response', st.completionHeaders?.pow === true);
    check('completion 带 authorization', st.completionHeaders?.auth === true);
    check('completion 带 x-device-id', st.completionHeaders?.deviceId === true);
    check('请求头是 Chrome UA', /Chrome\/\d+/.test(st.completionHeaders?.ua ?? ''), (st.completionHeaders?.ua ?? '').slice(0, 40));
    const headerKeys = (st.completionHeaders?.keys ?? []).map((k) => k.toLowerCase());
    check('请求头带 sec-ch-ua（User-Agent Client Hints）', headerKeys.includes('sec-ch-ua'),
      `keys=${headerKeys.slice(0, 8).join(',')}...`);
    check('请求头带 sec-ch-ua-mobile / sec-ch-ua-platform',
      headerKeys.includes('sec-ch-ua-mobile') && headerKeys.includes('sec-ch-ua-platform'));
    check('请求头带 sec-fetch-* / priority（Fetch Metadata）',
      headerKeys.includes('sec-fetch-mode') && headerKeys.includes('priority'));
    check('PoW 答案被上游验证通过', st.powVerified > 0 && st.powBad === 0, `verified=${st.powVerified} bad=${st.powBad}`);
    check('prompt 含 ## User 段', st.lastPrompt.includes('## User'), `${st.lastPrompt.length} 字符`);
  } finally {
    await stop(srv.child);
  }
});

/* ---- 4. OpenAI 流式 ---- */
add('openai-stream', async ({ srv, apiKey, up }) => {
  await request(`${up.url}/__reset`);
  // LONG 场景：上游逐字推 ~2 万字符，验证增量确实是多帧、且拼起来与最终结果一致（I6）
  const r = await readSse(`${srv.url}/v1/chat/completions`, {
    model: 'deepseek-flash',
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'user', content: 'LONG 你好' }],
  }, { Authorization: `Bearer ${apiKey}` });

  const events = parseOpenAiSse(r.raw);
  const content = events
    .map((e) => e.choices?.[0]?.delta?.content ?? '')
    .join('');
  const frames = events.filter((e) => e.choices?.[0]?.delta?.content);
  check('流式返回 200', r.status === 200, `${r.status}`);
  check('Content-Type 是 text/event-stream', String(r.headers['content-type']).includes('text/event-stream'));
  check('首帧带 role=assistant', events.some((e) => e.choices?.[0]?.delta?.role === 'assistant'));
  check('流式内容非空', content.length > 0, `${content.length} 字符`);
  check('确实是多帧增量', frames.length > 1, `${frames.length} 个增量帧`);
  check('增量拼接无重复无丢失', content.startsWith('第0行：') && content.includes('第399行：') && content.length < 30_000,
    `${content.length} 字符`);
  check('有 finish_reason=stop', events.some((e) => e.choices?.[0]?.finish_reason === 'stop'));
  check('include_usage 生效', events.some((e) => e.usage && e.usage.total_tokens > 0));
  check('以 [DONE] 结束', events[events.length - 1]?.done === true);

  // 短回答场景：验证内容与上游逐字一致（此时过滤器可能攒成单帧，属正常）
  await request(`${up.url}/__reset`);
  const r2 = await readSse(`${srv.url}/v1/chat/completions`, {
    model: 'deepseek-flash',
    stream: true,
    messages: [{ role: 'user', content: '你好' }],
  }, { Authorization: `Bearer ${apiKey}` });
  const c2 = parseOpenAiSse(r2.raw).map((e) => e.choices?.[0]?.delta?.content ?? '').join('');
  check('短回答流式内容与上游一致', c2 === '收到，这是假上游的回答。', JSON.stringify(c2));
});

/* ---- 5. 思考内容顺序（I5）---- */
add('reasoning', async ({ srv, apiKey, up }) => {
  await request(`${up.url}/__reset`);
  const r = await readSse(`${srv.url}/v1/chat/completions`, {
    model: 'deepseek-reasoner',
    stream: true,
    messages: [{ role: 'user', content: 'THINK 解释一下' }],
  }, { Authorization: `Bearer ${apiKey}` });
  const events = parseOpenAiSse(r.raw);
  const firstContent = events.findIndex((e) => e.choices?.[0]?.delta?.content);
  const firstReasoning = events.findIndex((e) => e.choices?.[0]?.delta?.reasoning_content);
  const reasoning = events.map((e) => e.choices?.[0]?.delta?.reasoning_content ?? '').join('');
  check('有 reasoning_content', reasoning.length > 0, JSON.stringify(reasoning.slice(0, 30)));
  check('reasoning 排在 content 之前', firstReasoning >= 0 && firstReasoning < firstContent,
    `reasoning@${firstReasoning} content@${firstContent}`);

  const st = (await request(`${up.url}/__stats`)).data;
  check('deepseek-reasoner 打开 thinking_enabled', st.lastThinking === true, String(st.lastThinking));
});

/* ---- 6. 工具调用（I3）---- */
add('tools', async ({ srv, apiKey, up }) => {
  await request(`${up.url}/__reset`);
  const tools = [
    {
      type: 'function',
      function: {
        name: 'exec_shell',
        description: 'Exec shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
      },
    },
  ];
  const r = await request(`${srv.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'TOOL 执行 uname' }], tools },
  });
  const calls = r.data?.choices?.[0]?.message?.tool_calls ?? [];
  check('解析出 tool_calls', calls.length === 1, `${calls.length}`);
  check('工具名正确', calls[0]?.function?.name === 'exec_shell', String(calls[0]?.function?.name));
  let args = null;
  try {
    args = JSON.parse(calls[0]?.function?.arguments ?? '{}');
  } catch {
    args = null;
  }
  check('参数是合法 JSON 且值正确', args?.command === 'uname -a', String(calls[0]?.function?.arguments));
  check('finish_reason=tool_calls', r.data?.choices?.[0]?.finish_reason === 'tool_calls',
    String(r.data?.choices?.[0]?.finish_reason));
  check('正文里没有残留 DSML 标记', !String(r.data?.choices?.[0]?.message?.content ?? '').includes('DSML'),
    JSON.stringify(r.data?.choices?.[0]?.message?.content));
  const st = (await request(`${up.url}/__stats`)).data;
  check('prompt 里有 ## Tool_functions 段', st.lastPrompt.includes('## Tool_functions'));
  check('## Tool_functions 里有工具名', st.lastPrompt.includes('exec_shell'));

  // 流式工具调用
  await request(`${up.url}/__reset`);
  const rs = await readSse(`${srv.url}/v1/chat/completions`, {
    model: 'deepseek-flash',
    stream: true,
    messages: [{ role: 'user', content: 'TOOL 执行 uname' }],
    tools,
  }, { Authorization: `Bearer ${apiKey}` });
  const ev = parseOpenAiSse(rs.raw);
  const tc = ev.flatMap((e) => e.choices?.[0]?.delta?.tool_calls ?? []);
  check('流式 tool_calls 非空', tc.length === 1, `${tc.length}`);
  check('流式 tool_calls 带 index/id/name', tc[0]?.index === 0 && Boolean(tc[0]?.id) && tc[0]?.function?.name === 'exec_shell',
    JSON.stringify(tc[0]).slice(0, 100));
  check('流式 finish_reason=tool_calls', ev.some((e) => e.choices?.[0]?.finish_reason === 'tool_calls'));
});

/* ---- 7. 工具结果回传（I2：历史里不能有原始语法）---- */
add('tool-history', async ({ srv, apiKey, up }) => {
  await request(`${up.url}/__reset`);
  const r = await request(`${srv.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: {
      model: 'deepseek-flash',
      messages: [
        { role: 'user', content: 'ECHO 查一下内核版本' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec_shell', arguments: '{"command":"uname -a"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'Linux box 6.8.0' },
      ],
    },
  });
  check('带工具结果的多轮请求成功', r.status === 200, `${r.status}`);
  const st = (await request(`${up.url}/__stats`)).data;
  check('prompt 里有 ## Tool_calls 段', st.lastPrompt.includes('## Tool_calls'));
  check('prompt 里有 ## Tool_call_result 段', st.lastPrompt.includes('## Tool_call_result'));
  check('工具结果写进了 prompt', st.lastPrompt.includes('Linux box 6.8.0'));
  // 协议提示词（SPECIAL_TOKENS_HEADER）本来就会教模型 DSML 格式，所以 "## Tool_call_result"
  // 这类段落常量出现在提示词里是正常的。I2 真正禁止的是把上一轮的工具调用**原文**回写进历史。
  check('工具调用没有以 DSML 原文回写（I2）', !st.lastPrompt.includes('<｜DSML｜'));
  check('工具调用以 ## Tool_calls 的 JSON 形式回写（I2）', /## Tool_calls:/.test(st.lastPrompt));
  check('历史里没有回写 RESULT 伪造语法（I2）', !/^RESULT:/m.test(st.lastPrompt));
});

/* ---- 8. 上下文拼接 ---- */
add('context', async ({ srv, apiKey, up }) => {
  await request(`${up.url}/__reset`);
  const r = await request(`${srv.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: {
      model: 'deepseek-flash',
      messages: [
        { role: 'system', content: '你是只回答数字的助手' },
        { role: 'user', content: 'ECHO 记住 731' },
        { role: 'assistant', content: '好的 731' },
        { role: 'user', content: 'ECHO 刚才的数字是多少' },
      ],
    },
  });
  const content = r.data?.choices?.[0]?.message?.content ?? '';
  check('多轮上下文被拼成单个 prompt', r.status === 200 && content.length > 0, JSON.stringify(content.slice(0, 60)));
  const st = (await request(`${up.url}/__stats`)).data;
  check('## System 段存在', st.lastPrompt.includes('## System'));
  check('system 内容在 prompt 里', st.lastPrompt.includes('你是只回答数字的助手'));
  check('历史 assistant 段存在', st.lastPrompt.includes('## Assistant'));
  check('最后一段是 User', st.lastPrompt.lastIndexOf('## User') > st.lastPrompt.lastIndexOf('## Assistant'));
});

/* ---- 9. 编造协议（I4：只清洗，不中止不重试）---- */
add('fabricate', async ({ srv, apiKey, up }) => {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'exec_shell',
        description: 'x',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      },
    },
  ];

  // 场景 A：伪造段标题 ## Tool_call_result —— isFabricatedBlock 会认的「编造协议」
  await request(`${up.url}/__reset`);
  let started = Date.now();
  let r = await request(`${srv.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'FABRICATE_SECTION 执行命令' }], tools },
  });
  let elapsed = Date.now() - started;
  let content = r.data?.choices?.[0]?.message?.content ?? '';
  let calls = r.data?.choices?.[0]?.message?.tool_calls ?? [];
  check('伪造段标题时请求正常返回', r.status === 200, `${r.status} ${elapsed}ms`);
  check('伪造段标题不中止、仍给出工具调用（I4）', calls.length === 1, `${calls.length}`);
  check('伪造的 ## Tool_call_result 被清洗', !content.includes('## Tool_call_result'), JSON.stringify(content.slice(0, 60)));
  // 只清洗伪造的标题行本身；其后正文照常保留（stripToolMarkup 的既定语义：去掉协议行、保留正文）
  check('伪造段标题被清洗，但正文保留', content.includes('内核版本') && !content.includes('## Tool_call_result'),
    JSON.stringify(content.slice(0, 80)));
  check('原生 tool token 也被正确解析成 tool_calls', calls.length === 1 && calls[0]?.function?.name === 'exec_shell',
    JSON.stringify(calls).slice(0, 100));

  // 场景 B：纯 RESULT:{json}（散文 "Result: xxx" 不算编造，所以这里用真 JSON）
  await request(`${up.url}/__reset`);
  started = Date.now();
  r = await request(`${srv.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'FABRICATE 执行命令' }], tools },
  });
  elapsed = Date.now() - started;
  content = r.data?.choices?.[0]?.message?.content ?? '';
  calls = r.data?.choices?.[0]?.message?.tool_calls ?? [];
  check('RESULT:{json} 时请求正常返回', r.status === 200, `${r.status} ${elapsed}ms`);
  check('RESULT:{json} 不中止、仍给出工具调用（I4）', calls.length === 1, `${calls.length}`);
  check('RESULT 行本身从正文中剔除', !/^RESULT\s*[:：]/m.test(content), JSON.stringify(content.slice(0, 80)));
  check('模型编造的工具结果 JSON 不在正文里', !content.includes('假结果'), JSON.stringify(content.slice(0, 80)));
  check('上游无限续写在超时前被截断', elapsed < 60_000, `${elapsed}ms`);
});

/* ---- 10. 限流 / 登录态失效 ---- */
/* ---- 10. 限流 / 登录态失效（用独立实例：这些场景会把账号打进冷却）---- */
add('errors', async ({ apiKey, up }) => {
  // 每个场景一个全新实例，避免「限流冷却」串到下一个检查
  // （冷却 / 登录态失效都会把账号停用 60s 以上，这是设计行为，不是 bug）
  const runOne = async (prompt, tokens) => {
    const inst = await startCzDsapi(
      { ENGINE: 'direct', API_KEY: apiKey, DEEPSEEK_BASE_URL: up.url, POW_BIN: path.join(root, 'bin', 'ds-pow') },
      { tokens },
    );
    try {
      const r = await request(`${inst.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: { model: 'deepseek-flash', messages: [{ role: 'user', content: prompt }] },
      });
      return r;
    } finally {
      await stop(inst.child);
    }
  };

  await request(`${up.url}/__reset`);
  const rl = await runOne('RATE_LIMIT 你好', ['rl-token']);
  check('上游限流时返回 429', rl.status === 429, `${rl.status} ${JSON.stringify(rl.data).slice(0, 80)}`);
  check('429 带 Retry-After', Boolean(rl.headers['retry-after']), String(rl.headers['retry-after']));

  await request(`${up.url}/__reset`);
  const af = await runOne('AUTH_FAIL 你好', ['af-token']);
  // AuthExpiredError 映射到 503（服务端凭据问题），不是 401（客户端凭据问题）
  check('登录态失效返回 503 + upstream_error', af.status === 503 && af.data?.error?.type === 'upstream_error',
    `${af.status} ${JSON.stringify(af.data).slice(0, 90)}`);

  // 参数错误不需要打到上游，用主实例即可
  const srv2 = await startCzDsapi(
    { ENGINE: 'direct', API_KEY: apiKey, DEEPSEEK_BASE_URL: up.url, POW_BIN: path.join(root, 'bin', 'ds-pow') },
    { tokens: ['param-token'] },
  );
  try {
    const bad = await request(`${srv2.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: { model: 'deepseek-flash', messages: [] },
    });
    check('空 messages 返回 400', bad.status === 400, `${bad.status}`);
    check('400 错误体有 error.message', typeof bad.data?.error?.message === 'string');

    const notFound = await request(`${srv2.url}/v1/nope`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: {},
    });
    check('未知路径返回 404', notFound.status === 404, `${notFound.status}`);
  } finally {
    await stop(srv2.child);
  }
});

/* ---- 11. 旧版 /v1/completions ---- */
add('legacy', async ({ srv, apiKey }) => {
  const r = await request(`${srv.url}/v1/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: { model: 'deepseek-flash', prompt: '你好' },
  });
  check('/v1/completions 返回 200', r.status === 200, `${r.status}`);
  check('object=text_completion', r.data?.object === 'text_completion', String(r.data?.object));
  check('choices[0].text 非空', (r.data?.choices?.[0]?.text ?? '').length > 0,
    JSON.stringify(r.data?.choices?.[0]?.text?.slice(0, 40)));
});

/* ---- 12. Anthropic Messages ---- */
add('anthropic', async ({ srv, apiKey, up }) => {
  await request(`${up.url}/__reset`);
  const h = { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };

  const r = await request(`${srv.url}/v1/messages`, {
    method: 'POST',
    headers: h,
    body: { model: 'deepseek-flash', max_tokens: 128, messages: [{ role: 'user', content: '你好' }] },
  });
  check('Anthropic 非流式 200', r.status === 200, `${r.status}`);
  check('type=message', r.data?.type === 'message', String(r.data?.type));
  check('role=assistant', r.data?.role === 'assistant');
  check('content 是 block 数组', Array.isArray(r.data?.content) && r.data.content[0]?.type === 'text',
    JSON.stringify(r.data?.content).slice(0, 80));
  check('有 usage.input_tokens/output_tokens', Number.isFinite(r.data?.usage?.input_tokens) && Number.isFinite(r.data?.usage?.output_tokens),
    JSON.stringify(r.data?.usage));
  check('stop_reason=end_turn', r.data?.stop_reason === 'end_turn', String(r.data?.stop_reason));

  // 流式
  await request(`${up.url}/__reset`);
  const rs = await readSse(`${srv.url}/v1/messages`, {
    model: 'deepseek-flash',
    max_tokens: 128,
    stream: true,
    messages: [{ role: 'user', content: '你好' }],
  }, h);
  const ev = parseAnthropicSse(rs.raw);
  const names = ev.map((e) => e.event);
  const text = ev.filter((e) => e.event === 'content_block_delta').map((e) => e.data?.delta?.text ?? '').join('');
  check('Anthropic 流式 200', rs.status === 200, `${rs.status}`);
  check('事件顺序 message_start → content_block_start → delta → stop',
    names[0] === 'message_start' && names.includes('content_block_start') && names.includes('content_block_delta') && names.includes('message_stop'),
    names.slice(0, 6).join(','));
  check('Anthropic 流式文本非空', text.length > 0, JSON.stringify(text.slice(0, 40)));
  check('事件名与 payload.type 一致', ev.every((e) => !e.data?.type || e.data.type === e.event || e.event === 'ping'),
    names.slice(0, 3).join(','));

  // Anthropic 工具调用
  await request(`${up.url}/__reset`);
  const rt = await request(`${srv.url}/v1/messages`, {
    method: 'POST',
    headers: h,
    body: {
      model: 'deepseek-flash',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'TOOL 执行 uname' }],
      tools: [{ name: 'exec_shell', description: 'Exec', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } }],
    },
  });
  const toolBlock = (rt.data?.content ?? []).find((b) => b.type === 'tool_use');
  check('Anthropic tool_use block', Boolean(toolBlock), JSON.stringify(rt.data?.content).slice(0, 100));
  check('Anthropic tool_use name/input 正确',
    toolBlock?.name === 'exec_shell' && toolBlock?.input?.command === 'uname -a',
    JSON.stringify(toolBlock).slice(0, 120));
  check('stop_reason=tool_use', rt.data?.stop_reason === 'tool_use', String(rt.data?.stop_reason));

  // count_tokens
  const ct = await request(`${srv.url}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: h,
    body: { model: 'deepseek-flash', messages: [{ role: 'user', content: '你好世界' }] },
  });
  check('count_tokens 返回 200', ct.status === 200, `${ct.status}`);
  check('count_tokens.input_tokens > 0', ct.data?.input_tokens > 0, String(ct.data?.input_tokens));
});

/* ---- 13. 图片 ---- */
add('images', async ({ srv, apiKey, up }) => {
  await request(`${up.url}/__reset`);
  // 1x1 PNG
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const r = await request(`${srv.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: {
      model: 'deepseek-flash',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这张图是什么' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
          ],
        },
      ],
    },
  });
  check('带图片的请求成功', r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 80)}`);
  const st = (await request(`${up.url}/__stats`)).data;
  check('图片被上传成附件', st.uploads >= 1, `uploads=${st.uploads}`);
  check('ref_file_ids 传给了上游', st.lastRefFileIds.length >= 1, JSON.stringify(st.lastRefFileIds));
  check('图片不进 prompt 正文', !st.lastPrompt.includes(png.slice(0, 30)));
  check('文字部分仍在 prompt 里', st.lastPrompt.includes('这张图是什么'));
});

/* ---- 14. 超长 prompt 溢出成附件 ---- */
/* ---- 14. 超长 prompt 溢出成附件 ---- */
add('overflow', async ({ apiKey, up }) => {
  const srv = await startCzDsapi(
    { ENGINE: 'direct', API_KEY: apiKey, DEEPSEEK_BASE_URL: up.url, POW_BIN: path.join(root, 'bin', 'ds-pow') },
    { tokens: ['overflow-token'] },
  );
  const send = (systemChars) =>
    request(`${srv.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: {
        model: 'deepseek-flash',
        messages: [{ role: 'system', content: '长'.repeat(systemChars) }, { role: 'user', content: 'ECHO 总结一下' }],
      },
    });
  try {
    // 阈值内：不应产生附件，正文原样带上
    await request(`${up.url}/__reset`);
    const small = await send(50_000);
    check('5 万字符（阈值内）正常返回', small.status === 200, `${small.status}`);
    let st = (await request(`${up.url}/__stats`)).data;
    check('阈值内不产生附件', st.uploads === 0 && st.lastRefFileIds.length === 0,
      `uploads=${st.uploads} refs=${JSON.stringify(st.lastRefFileIds)}`);
    check('阈值内正文完整带上历史', st.lastPrompt.length > 50_000, `${st.lastPrompt.length} 字符`);

    // 超阈值：较早的历史应移进 .txt 附件，正文落回上限内
    await request(`${up.url}/__reset`);
    const big = await send(140_000);
    check('14 万字符（超阈值）不报 413、成功返回', big.status === 200,
      `${big.status} ${JSON.stringify(big.data).slice(0, 100)}`);
    st = (await request(`${up.url}/__stats`)).data;
    check('超长上下文转成了附件', st.uploads >= 1 && st.lastRefFileIds.length >= 1,
      `uploads=${st.uploads} refs=${JSON.stringify(st.lastRefFileIds)}`);
    check('正文 prompt 落回上限内', st.lastPrompt.length <= 100_000, `${st.lastPrompt.length} 字符`);
    check('正文最后一段仍是用户问题', /## User:\s*ECHO 总结一下\s*$/.test(st.lastPrompt),
      JSON.stringify(st.lastPrompt.slice(-80)));
  } finally {
    await stop(srv.child);
  }
});

/* ---- 15. 限流入口 ---- */
add('ratelimit', async ({ srv, apiKey, up }) => {
  // 该用例用独立进程（需要 RATE_LIMIT_ENABLED=true 且额度很小）
  const inst = await startCzDsapi({
    ENGINE: 'direct',
    API_KEY: apiKey,
    DEEPSEEK_BASE_URL: up.url,
    POW_BIN: path.join(root, 'bin', 'ds-pow'),
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_PER_MINUTE: '3',
    RATE_LIMIT_REFILL_PER_SEC: '0.01',
  });
  try {
    const codes = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await request(`${inst.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: { model: 'deepseek-flash', messages: [{ role: 'user', content: '你好' }] },
      });
      codes.push(r.status);
      // 速率被限时不要再连打，否则会把上游冷却也打出来（那是引擎行为，不是入口限流）
      if (r.status === 429) break;
    }
    check('额度内请求被放行', codes[0] === 200, codes.join(','));
    check('超出突发额度后返回 429', codes.includes(429), codes.join(','));

    const limited = await request(`${inst.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: { model: 'deepseek-flash', messages: [{ role: 'user', content: '你好' }] },
    });
    check('429 响应体是限流错误', limited.status === 429 && /限流|too many|rate/i.test(JSON.stringify(limited.data)),
      `${limited.status} ${JSON.stringify(limited.data).slice(0, 100)}`);

    const h = await request(`${inst.url}/healthz`);
    check('/healthz 不受限流影响', h.status === 200, `${h.status}`);
    const m = await request(`${inst.url}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
    check('/v1/models 不受限流影响', m.status === 200, `${m.status}`);
  } finally {
    await stop(inst.child);
  }
});

/* ---- 16. 管理端 API ---- */
add('admin', async ({ srv, apiKey }) => {
  const noKey = await request(`${srv.url}/admin/api/overview`);
  check('管理接口需 API Key', noKey.status === 401, `${noKey.status}`);

  const ov = await request(`${srv.url}/admin/api/overview`, { headers: { Authorization: `Bearer ${apiKey}` } });
  check('GET /admin/api/overview 200', ov.status === 200, `${ov.status}`);
  check('overview 有配置概要', ov.data?.config?.port !== undefined);
  check('overview token 打码', (ov.data?.savedTokens ?? []).every((t) => !t.includes('e2e-token-1') || t.includes('*')),
    JSON.stringify(ov.data?.savedTokens));

  const acc = await request(`${srv.url}/admin/api/accounts`, { headers: { Authorization: `Bearer ${apiKey}` } });
  check('GET /admin/api/accounts 200', acc.status === 200, `${acc.status}`);
  check('账号池里有 2 个运行中账号', (acc.data?.runtime ?? []).length === 2, String(acc.data?.runtime?.length));

  const cfg = await request(`${srv.url}/admin/api/config`, { headers: { Authorization: `Bearer ${apiKey}` } });
  check('GET /admin/api/config 200', cfg.status === 200, `${cfg.status}`);
  check('config 返回可编辑项', Array.isArray(cfg.data?.fields) || Array.isArray(cfg.data?.schema),
    Object.keys(cfg.data ?? {}).join(','));

  const logs = await request(`${srv.url}/admin/api/logs?lines=10`, { headers: { Authorization: `Bearer ${apiKey}` } });
  check('GET /admin/api/logs 200', logs.status === 200, `${logs.status}`);

  const page = await request(`${srv.url}/admin/`, { raw: true });
  check('GET /admin/ 返回控制台页面', page.status === 200 && /<html/i.test(page.text), `${page.status}`);
});

/* ---- 17. CORS / OPTIONS ---- */
add('cors', async ({ srv }) => {
  const r = await request(`${srv.url}/v1/chat/completions`, { method: 'OPTIONS', raw: true });
  check('OPTIONS 预检返回 204', r.status === 204, `${r.status}`);
  check('带 CORS 头', Boolean(r.headers['access-control-allow-origin']), String(r.headers['access-control-allow-origin']));
});

/* ---- 18. PoW 拒绝后重解 ---- */
add('pow-retry', async ({ apiKey, up }) => {
  await request(`${up.url}/__reset`);
  // 40301 一次后要现场重新求解；用独立实例保证统计干净
  const inst = await startCzDsapi(
    { ENGINE: 'direct', API_KEY: apiKey, DEEPSEEK_BASE_URL: up.url, POW_BIN: path.join(root, 'bin', 'ds-pow') },
    { tokens: ['pow-retry-token'] },
  );
  try {
    const r = await request(`${inst.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: { model: 'deepseek-flash', messages: [{ role: 'user', content: 'POW_REJECT 你好' }] },
    });
    check('PoW 被拒（40301）后重新求解并成功', r.status === 200, `${r.status} ${JSON.stringify(r.data).slice(0, 80)}`);
    const st = (await request(`${up.url}/__stats`)).data;
    check('上游确实拒绝过一次 PoW', st.powRejected === 1, `powRejected=${st.powRejected}`);
    check('重新取了新挑战', st.challenges >= 2, `challenges=${st.challenges}`);
  } finally {
    await stop(inst.child);
  }
});

/* ---- 19. 客户端断开 ---- */
add('abort', async ({ srv, apiKey }) => {
  const started = Date.now();
  const aborted = await new Promise((resolve) => {
    const u = new URL(`${srv.url}/v1/chat/completions`);
    const payload = Buffer.from(JSON.stringify({
      model: 'deepseek-flash',
      stream: true,
      messages: [{ role: 'user', content: 'LONG 你好' }],
    }));
    const req = http.request(
      {
        hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, Authorization: `Bearer ${apiKey}` },
      },
      (res) => {
        res.once('data', () => {
          req.destroy();
          resolve(true);
        });
      },
    );
    req.on('error', () => resolve(true));
    req.write(payload);
    req.end();
    setTimeout(() => resolve(false), 15_000).unref();
  });
  check('客户端断开能正常中断', aborted === true, `${Date.now() - started}ms`);
  await new Promise((r) => setTimeout(r, 500));
  const h = await request(`${srv.url}/healthz`);
  check('断开后服务仍健康', h.status === 200 && h.data?.ok === true);
  check('断开后 inflight 归零', h.data?.busy === 0, String(h.data?.busy));
});

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
const apiKey = 'e2e-secret-key-123456';

console.log('\n启动假 DeepSeek 上游…');
const up = await startUpstream();
console.log(`  上游: ${up.url}`);

let srv;
try {
  console.log('启动 cz-dsapi（ENGINE=direct）…');
  srv = await startCzDsapi({
    ENGINE: 'direct',
    API_KEY: apiKey,
    DEEPSEEK_BASE_URL: up.url,
    POW_BIN: path.join(root, 'bin', 'ds-pow'),
  });
  console.log(`  服务: ${srv.url}\n`);

  const ctx = { srv, up, apiKey };
  // 串行执行：每个用例都会启动独立进程，并发跑会让 PoW/CPU 争抢并把假上游的全局状态搅乱
  for (const [name, fn] of CASES) {
    if (only && only !== name) continue;
    console.log(`\x1b[1m--- ${name} ---\x1b[0m`);
    try {
      await fn(ctx);
    } catch (err) {
      check(`${name} 用例异常`, false, err.message);
    }
  }
} catch (err) {
  console.error('启动失败:', err.message);
  process.exitCode = 1;
} finally {
  await stop(srv?.child);
  await stop(up.child);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${'='.repeat(60)}`);
console.log(`用例: ${results.length}  通过: ${results.length - failed.length}  失败: ${failed.length}`);
if (failed.length) {
  console.log('\n失败项:');
  for (const f of failed) console.log(`  ✖ ${f.name} ${f.extra}`);
}
process.exit(failed.length ? 1 : 0);
