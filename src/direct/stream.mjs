/**
 * DeepSeek 网页版补全接口的流式协议解析。
 *
 * 服务端每帧是一个 JSON「补丁」：
 *   {"v": {"response": {...}}}                       // 初始快照（含 fragments）
 *   {"p":"response/fragments","o":"APPEND","v":[..]}  // 新增片段（THINK / RESPONSE）
 *   {"p":"response/fragments/-1/content","v":"是"}    // 追加到最后一段（o 缺省 = APPEND）
 *   {"v":"声"}                                        // 同上，省略路径
 *   {"p":"response/status","o":"SET","v":"FINISHED"}  // 结束
 */

export function createStreamState() {
  return {
    fragments: [],
    status: null,
    usage: null,
    messageId: null,
  };
}

function lastFragment(state) {
  return state.fragments[state.fragments.length - 1];
}

/**
 * 给最后一段追加文本。
 *
 * 不能写 `fragment.content += text`：长回答里每帧都会把整段内容复制一遍，
 * 是继「SSE buffer 拼接」和「全文 join」之后的第三处二次开销，而且它发生在
 * 最热的路径上（每个 delta 一帧）。这里把增量记进 `_parts`，等到真正读取
 * `content` 时才合并；合并是幂等的，读多少次都不会重复追加。
 *
 * `_parts` 是内部字段，但 `fragments` 会被快照整体替换（见 applyPatch 的
 * 无路径分支），所以 `_parts` 只在「自己累加过」的片段上存在，缺省即「没有
 * 待合并的增量」，对来自快照的片段天然安全。
 */
function appendToLast(state, text) {
  if (!text) return;
  const fragment = lastFragment(state);
  if (!fragment) return;
  if (Array.isArray(fragment._parts)) fragment._parts.push(text);
  else fragment._parts = [text];
}

/** 把待合并的增量并进 content（幂等：合并后清掉 _parts） */
export function materializeFragment(fragment) {
  if (!fragment || !Array.isArray(fragment._parts)) return fragment;
  const pending = fragment._parts;
  fragment._parts = undefined;
  if (!pending.length) return fragment;
  fragment.content = (fragment.content || '') + pending.join('');
  return fragment;
}

export function applyPatch(state, patch) {
  if (!patch || typeof patch !== 'object') return;

  // 不带路径：要么是新快照，要么是给最后一段追加文本
  if (patch.p === undefined) {
    if (typeof patch.v === 'string') {
      appendToLast(state, patch.v);
      return;
    }
    if (patch.v && typeof patch.v === 'object') {
      const response = patch.v.response;
      if (response) {
        state.messageId = response.message_id ?? state.messageId;
        if (Array.isArray(response.fragments)) state.fragments = response.fragments;
        if (response.status) state.status = response.status;
      }
      return;
    }
    return;
  }

  const path = String(patch.p);
  const op = patch.o || 'APPEND';

  if (op === 'BATCH') {
    // BATCH 里的子补丁路径是相对于 batch 路径的，比如 response + accumulated_token_usage
    const base = path.endsWith('/') ? path : `${path}/`;
    for (const sub of patch.v || []) {
      applyPatch(state, sub && sub.p ? { ...sub, p: base + sub.p } : sub);
    }
    return;
  }

  if (path === 'response/fragments' && op === 'APPEND') {
    if (Array.isArray(patch.v)) state.fragments.push(...patch.v);
    return;
  }

  if (path === 'response/fragments/-1/content') {
    appendToLast(state, typeof patch.v === 'string' ? patch.v : '');
    return;
  }

  if (path === 'response/status') {
    state.status = patch.v;
    return;
  }

  if (path === 'response/accumulated_token_usage') {
    state.usage = patch.v;
    return;
  }

  // 其它路径（elapsed_secs、references…）对输出没影响，忽略
}

/** 按片段类型汇总文本 */
export function collectText(state, type) {
  let out = '';
  for (const f of state.fragments) {
    if (!f || f.type !== type) continue;
    materializeFragment(f);
    out += f.content || '';
  }
  return out;
}

export const contentOf = (state) => collectText(state, 'RESPONSE');
export const reasoningOf = (state) => collectText(state, 'THINK');

/**
 * 增量文本追踪器：direct/client.mjs 原来每个上游补丁都要把全部
 * fragments filter + map + join 一遍，再和已发文本做 startsWith。
 * 输出越长，每帧成本越高（O(总长度)），长回答后期每个 token 都要
 * 复制、拼接一遍全文，GC 和延迟一起涨。
 *
 * 追踪器只返回“相对上次的新增量”，不拼全文：
 * - 追加是常态：只有最后一段在变（对象引用相同，内容是旧内容的前缀），
 *   或新增了一段 —— 这两种情况只 join 新增的那一小段；
 * - 快照替换了整个 fragments 数组时，逐段比对字符串（快照极少出现，
 *   且字符串比较不分配新全文）；
 * - 中间某段被改短/改写（不再是追加语义）时返回 null，调用方回退到
 *   全文 join + startsWith 的旧逻辑，正确性不受影响。
 *
 * @returns {(fragments: object[], type: string) => string | null}
 *   新增量；null 表示无法增量，调用方应回退全文计算。
 */
export function createTextTracker() {
  let parts = []; // 上次见到的该类型片段对象（按顺序）
  let contents = []; // 与 parts 对应的内容字符串（已合并的权威内容）

  return (fragments, type) => {
    const next = [];
    for (const f of fragments) {
      if (f && f.type === type) next.push(f);
    }
    if (next.length < parts.length) return null;

    let delta = '';
    let changed = false;
    for (let i = 0; i < parts.length; i += 1) {
      const oldContent = contents[i];
      const frag = next[i];
      // 片段自己累加过增量时，本批新增量就在 _parts 里：直接用 join 得到增量，
      // 不必为了「看一眼变没变」把整段内容合并出来（合并是 O(旧内容长度)）。
      const pending = frag === parts[i] && Array.isArray(frag._parts) ? frag._parts : null;
      if (pending) {
        if (!pending.length) continue;
        materializeFragment(frag);
        const newContent = frag.content || '';
        if (newContent.length < oldContent.length) return null; // 回退：无法增量
        delta += pending.join('');
        changed = true;
        continue;
      }
      const newContent = frag.content || '';
      if (newContent === oldContent) continue;
      if (newContent.length < oldContent.length) return null; // 回退：无法增量
      if (frag === parts[i] && i === parts.length - 1) {
        // 常态：同一对象、最后一段，applyPatch 只做追加（content = 旧 + 新），
        // 所以旧内容一定是新内容的前缀，不必再花 O(旧长度) 做 startsWith
        // 比较 —— 这一步正是原来全文 join / startsWith 的二次开销来源。
        delta += newContent.slice(oldContent.length);
        changed = true;
        continue;
      }
      // 对象换了（快照替换）或非最后一段长了：验证一次前缀，快照极少出现。
      if (newContent.startsWith(oldContent)) {
        delta += newContent.slice(oldContent.length);
        changed = true;
        continue;
      }
      return null; // 中间改写：无法增量
    }
    for (let i = parts.length; i < next.length; i += 1) {
      materializeFragment(next[i]);
      delta += next[i].content || '';
      changed = true;
    }
    // 即使 delta 为空也要更新快照，否则下次会误判
    parts = next.slice();
    // 批量取内容：合并过增量的片段本次已是最新值，剩余部分只读 content。
    contents = next.map((f) => f.content || '');
    return changed ? delta : '';
  };
}

/** 把 SSE 文本流切成一个个 data JSON，逐帧回调 */
export function createSseParser(onData, onEvent) {
  // 待解析的剩余文本。原实现是 `buffer += chunk`，每次 push 都要复制整个剩余串；
  // 现在只拼接「残留尾巴 + 新 chunk」，而残留尾巴在正常情况下是半帧（几十字节），
  // 消费完立刻被 slice 掉，所以单次 push 的成本与帧数线性、与历史长度无关。
  let pending = '';

  return {
    push(chunk) {
      if (!chunk) return;
      pending = pending ? pending + chunk : chunk;
      let offset = 0;
      let index;
      while ((index = pending.indexOf('\n\n', offset)) >= 0) {
        const raw = pending.slice(offset, index);
        offset = index + 2;
        this.handleFrame(raw);
      }
      if (offset > 0) pending = pending.slice(offset);
    },
    handleFrame(raw) {
      if (!raw.trim()) return;
      let event = null;
      const dataLines = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7).trim();
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
        else if (line.startsWith('data:')) dataLines.push(line.slice(5));
      }
      if (event && onEvent) onEvent(event);
      if (!dataLines.length) return;
      const payload = dataLines.join('\n').trim();
      if (!payload) return;
      try {
        onData(JSON.parse(payload), event);
      } catch {
        // 非 JSON（keep-alive 之类）忽略
      }
    },
    flush() {
      const rest = pending;
      if (rest.trim()) {
        this.handleFrame(rest);
      }
      pending = '';
    },
  };
}
