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

function appendToLast(state, text) {
  if (!text) return;
  const fragment = lastFragment(state);
  if (!fragment) return;
  fragment.content = (fragment.content || '') + text;
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
  return state.fragments
    .filter((f) => f && f.type === type)
    .map((f) => f.content || '')
    .join('');
}

export const contentOf = (state) => collectText(state, 'RESPONSE');
export const reasoningOf = (state) => collectText(state, 'THINK');

/** 把 SSE 文本流切成一个个 data JSON，逐帧回调 */
export function createSseParser(onData, onEvent) {
  let buffer = '';

  return {
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        this.handleFrame(raw);
      }
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
      if (buffer.trim()) {
        this.handleFrame(buffer);
        buffer = '';
      }
    },
  };
}
