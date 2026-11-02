/**
 * 后台接口 / 流式调用的封装。
 *
 * - adminApi()  走 /admin/api/*，需要管理鉴权（服务端配置了 API_KEY 时）；
 * - request()   通用 JSON 请求，测试页直接打 /v1 用；
 * - streamChat() 直接消费 /v1 的 SSE，用来在测试页里逐字显示。
 */

const KEY_STORAGE = 'fuckds-admin-api-key';

export class HttpError extends Error {
  constructor(message, status = 0, payload = null) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.payload = payload;
  }
}

let unauthorizedHandler = null;

/** 全局 401 回调：App 用它弹出「输入 API Key」对话框 */
export function setUnauthorizedHandler(handler) {
  unauthorizedHandler = handler;
}

export function getApiKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

export function setApiKey(value) {
  try {
    if (value) localStorage.setItem(KEY_STORAGE, value);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* 隐私模式之类，忽略 */
  }
}

export function adminApi(path, { method = 'GET', body, signal } = {}) {
  return request(`/admin/api${path}`, { method, body, signal });
}

export async function request(url, { method = 'GET', body, signal } = {}) {
  const headers = { Accept: 'application/json' };
  const key = getApiKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new HttpError('无法连接服务，请确认 fuckds 正在运行', 0);
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!res.ok) {
    if (res.status === 401 && unauthorizedHandler) unauthorizedHandler();
    throw new HttpError(data?.error?.message || `${res.status} ${res.statusText}`, res.status, data);
  }
  return data;
}

/**
 * 流式聊天：直接消费 /v1/chat/completions 的 SSE。
 * @returns {Promise<{ toolCalls: object[], finishReason: string|null }>}
 */
export async function streamChat(body, { signal, onDelta, onReasoning, onFinish } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  const key = getApiKey();
  if (key) headers.Authorization = `Bearer ${key}`;

  const res = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    let message = `${res.status} ${res.statusText}`;
    try {
      message = JSON.parse(text)?.error?.message || message;
    } catch {
      /* 保留状态码文案 */
    }
    if (res.status === 401 && unauthorizedHandler) unauthorizedHandler();
    throw new HttpError(message, res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolCalls = [];
  let finishReason = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue;
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        if (delta.reasoning_content) onReasoning?.(delta.reasoning_content);
        if (delta.content) onDelta?.(delta.content);
        for (const call of delta.tool_calls || []) {
          const slot = toolCalls[call.index] ?? (toolCalls[call.index] = { name: '', arguments: '' });
          if (call.function?.name) slot.name += call.function.name;
          if (call.function?.arguments) slot.arguments += call.function.arguments;
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    }
  }

  const calls = toolCalls.filter(Boolean);
  onFinish?.(calls, finishReason);
  return { toolCalls: calls, finishReason };
}
