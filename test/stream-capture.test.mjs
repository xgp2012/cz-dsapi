import test from 'node:test';
import assert from 'node:assert/strict';

import { createCompletionCapture, parseCompletionBodies } from '../src/browser/stream-capture.mjs';

const COMPLETION_URL = 'https://chat.deepseek.com/api/v0/chat/completion?session=1';

const frame = (payload, event) =>
  `${event ? `event: ${event}\n` : ''}data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;

/** 构造一段真实格式的 SSE：初始快照 + THINK 片段 + RESPONSE 片段 + FINISHED */
function buildSse({ thinking = '', answer = '', finish = true, appendChars = false } = {}) {
  let out = '';
  out += frame({ v: { response: { message_id: 'm-1', fragments: [] } } });
  if (thinking) {
    if (appendChars) {
      out += frame({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'THINK', content: '' }] });
      for (const ch of thinking) out += frame({ p: 'response/fragments/-1/content', v: ch });
    } else {
      out += frame({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'THINK', content: thinking }] });
    }
  }
  if (answer) {
    if (appendChars) {
      out += frame({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: '' }] });
      for (const ch of answer) out += frame({ p: 'response/fragments/-1/content', v: ch });
    } else {
      out += frame({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: answer }] });
    }
  }
  if (finish) out += frame({ p: 'response/status', o: 'SET', v: 'FINISHED' });
  return out;
}

const responseStub = (body) => ({
  url: () => COMPLETION_URL,
  status: () => 200,
  text: async () => body,
});

/** 只实现 capture 用到的 on/off 的假页面 */
function makePageStub() {
  const handlers = new Map();
  return {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
    },
    off(event, fn) {
      handlers.get(event)?.delete(fn);
    },
    emitResponse(response) {
      for (const fn of handlers.get('response') || []) fn(response);
    },
    listenerCount() {
      return handlers.get('response')?.size || 0;
    },
  };
}

/* ------------------------------------------------------------------ *
 * parseCompletionBodies：纯函数解析
 * ------------------------------------------------------------------ */

test('原始 SSE：解析出正文和思考', () => {
  const parsed = parseCompletionBodies([buildSse({ thinking: '先想一想', answer: '你好世界' })]);
  assert.equal(parsed.text, '你好世界');
  assert.equal(parsed.reasoning, '先想一想');
  assert.deepEqual(parsed.hints, []);
  assert.equal(parsed.rateLimited, false);
});

test('原始 SSE：逐字符追加（response/fragments/-1/content）也能拼出完整文本', () => {
  const parsed = parseCompletionBodies([buildSse({ thinking: '想', answer: '回答', appendChars: true })]);
  assert.equal(parsed.text, '回答');
  assert.equal(parsed.reasoning, '想');
});

test('原始 SSE：兼容未带空行的最后一帧（flush）', () => {
  const body = `${frame({ v: { response: { fragments: [{ type: 'RESPONSE', content: '尾巴' }] } } }, null)}`;
  const noTrailing = body.trimEnd(); // 去掉结尾空行
  const parsed = parseCompletionBodies([noTrailing]);
  assert.equal(parsed.text, '尾巴');
});

test('原始 SSE：坏 JSON / keep-alive 不抛错，且不影响已有文本', () => {
  const body =
    'data: {"v":{"response":{"fragments":[{"type":"RESPONSE","content":"好"}]}}}\n\n' +
    'data: 这不是 JSON\n\n' +
    ': keep-alive\n\n' +
    'data: {"p":"response/fragments/-1/content","v":"的"}\n\n' +
    'data: {"broken": \n\n';
  const parsed = parseCompletionBodies([body]);
  assert.equal(parsed.text, '好的');
});

test('原始 SSE：event: hint 限流被收集并标记 rateLimited', () => {
  const hint = {
    type: 'error',
    content: '消息发送过于频繁，请稍后重试',
    clear_response: true,
    finish_reason: 'rate_limit_reached',
  };
  const body = frame(hint, 'hint') + 'event: ready\ndata: {}\n\n';
  const parsed = parseCompletionBodies([body]);
  assert.equal(parsed.text, '');
  assert.equal(parsed.rateLimited, true);
  assert.equal(parsed.hints.length, 1);
  assert.match(parsed.hints[0].content, /频繁/);
  assert.equal(parsed.hints[0].finishReason, 'rate_limit_reached');
});

test('原始 SSE：多段 body 只取最可信的一段，不拼接（第一次中断、第二次完整）', () => {
  // 页面重试：第一段是半截（没有 FINISHED），第二段是完整回答
  const interrupted = buildSse({ answer: '前半段', finish: false });
  const complete = buildSse({ answer: '完整回答' });
  const parsed = parseCompletionBodies([interrupted, complete]);
  assert.equal(parsed.text, '完整回答', '不能拼成「前半段完整回答」');
});

test('原始 SSE：两段都完整时取更完整的一版，且不重复', () => {
  const first = buildSse({ answer: '半截' });
  const second = buildSse({ answer: '半截之后的完整回答' });
  const parsed = parseCompletionBodies([first, second]);
  assert.equal(parsed.text, '半截之后的完整回答');
});

test('原始 SSE：没有 FINISHED 的 body 之间取最长的一段，不拼接', () => {
  const first = buildSse({ answer: '短', finish: false });
  const second = buildSse({ answer: '更长的一段回答', finish: false });
  const parsed = parseCompletionBodies([first, second]);
  assert.equal(parsed.text, '更长的一段回答');
});

test('原始 SSE：非数组 / 空 body 返回空结果', () => {
  assert.deepEqual(parseCompletionBodies(null), { text: '', reasoning: '', hints: [], rateLimited: false });
  assert.deepEqual(parseCompletionBodies([]), { text: '', reasoning: '', hints: [], rateLimited: false });
  assert.deepEqual(parseCompletionBodies(['', null, 42]), {
    text: '',
    reasoning: '',
    hints: [],
    rateLimited: false,
  });
});

/* ------------------------------------------------------------------ *
 * createCompletionCapture：response 抓取 / 等待策略 / dispose
 * ------------------------------------------------------------------ */

test('capture：抓到补全响应后解析出权威文本', async () => {
  const page = makePageStub();
  const capture = createCompletionCapture(page, { logger: null });
  capture.start();
  page.emitResponse(responseStub(buildSse({ thinking: '想一想', answer: '你好' })));

  const result = await capture.collect({ timeoutMs: 2000 });
  assert.equal(result.text, '你好');
  assert.equal(result.reasoning, '想一想');
  assert.equal(result.bodies.length, 1);
  assert.equal(result.complete, true);
  assert.equal(result.rateLimited, false);
  capture.dispose();
  assert.equal(page.listenerCount(), 0);
});

test('capture：没有补全响应时 400ms 左右快速返回空，不拖慢测试', async () => {
  const page = makePageStub();
  const capture = createCompletionCapture(page, { logger: null });
  capture.start();

  const startedAt = Date.now();
  const result = await capture.collect({ timeoutMs: 5000 });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.text, '');
  assert.equal(result.bodies.length, 0);
  assert.equal(result.complete, false);
  assert.ok(elapsed >= 300, `应该真的等过 grace，实际 ${elapsed}ms`);
  assert.ok(elapsed < 1500, `不应该等满 timeout，实际 ${elapsed}ms`);
  capture.dispose();
});

test('capture：collect 等待期间才出现的响应也能抓到（grace 窗口内）', async () => {
  const page = makePageStub();
  const capture = createCompletionCapture(page, { logger: null });
  capture.start();
  setTimeout(() => page.emitResponse(responseStub(buildSse({ answer: '晚到的回答' }))), 150);

  const result = await capture.collect({ timeoutMs: 2000 });
  assert.equal(result.text, '晚到的回答');
  capture.dispose();
});

test('capture：忽略非补全接口的响应', async () => {
  const page = makePageStub();
  const capture = createCompletionCapture(page, { logger: null });
  capture.start();
  page.emitResponse({ url: () => 'https://chat.deepseek.com/api/v0/users/current', text: async () => '{}' });

  const result = await capture.collect({ timeoutMs: 600 });
  assert.equal(result.text, '');
  assert.equal(result.bodies.length, 0);
  capture.dispose();
});

test('capture：response.text() 失败时不抛错，complete=false', async () => {
  const page = makePageStub();
  const capture = createCompletionCapture(page, { logger: null });
  capture.start();
  page.emitResponse({
    url: () => COMPLETION_URL,
    text: async () => {
      throw new Error('boom');
    },
  });

  const result = await capture.collect({ timeoutMs: 1000 });
  assert.equal(result.text, '');
  assert.equal(result.bodies.length, 0);
  assert.equal(result.complete, false);
  capture.dispose();
});

test('capture：限流 hint 被标记，不抛错', async () => {
  const page = makePageStub();
  const capture = createCompletionCapture(page, { logger: null });
  capture.start();
  const hint = {
    type: 'error',
    content: '消息发送过于频繁，请稍后重试',
    finish_reason: 'rate_limit_reached',
  };
  page.emitResponse(responseStub(frame(hint, 'hint')));

  const result = await capture.collect({ timeoutMs: 1000 });
  assert.equal(result.text, '');
  assert.equal(result.rateLimited, true);
  assert.equal(result.hints.length, 1);
  capture.dispose();
});

test('capture：timeoutMs=0 时立即返回空（不等待）', async () => {
  const page = makePageStub();
  const capture = createCompletionCapture(page, { logger: null });
  capture.start();

  const startedAt = Date.now();
  const result = await capture.collect({ timeoutMs: 0 });
  assert.equal(result.text, '');
  assert.equal(result.complete, false);
  assert.ok(Date.now() - startedAt < 100, 'timeoutMs=0 不能变成默认等待');
  capture.dispose();
});

test('capture：同一轮两段响应只解析完整的那段，不重复拼接', async () => {
  const page = makePageStub();
  const capture = createCompletionCapture(page, { logger: null });
  capture.start();
  // 第一次请求被中断（没有 FINISHED），页面重试后第二段完整
  page.emitResponse(responseStub(buildSse({ answer: '第一次的半截回答', finish: false })));
  page.emitResponse(responseStub(buildSse({ answer: '第二次的完整回答' })));

  const result = await capture.collect({ timeoutMs: 2000 });
  assert.equal(result.text, '第二次的完整回答');
  assert.equal(result.complete, true);
  assert.equal(result.bodies.length, 2);
  capture.dispose();
});

test('capture：一段 body 读失败、另一段完整时仍然 complete=true', async () => {
  const page = makePageStub();
  const capture = createCompletionCapture(page, { logger: null });
  capture.start();
  page.emitResponse({
    url: () => COMPLETION_URL,
    text: async () => {
      throw new Error('response.text: Target page, context or browser has been closed');
    },
  });
  page.emitResponse(responseStub(buildSse({ answer: '重试后的完整回答' })));

  const result = await capture.collect({ timeoutMs: 2000 });
  assert.equal(result.text, '重试后的完整回答');
  assert.equal(result.complete, true);
  assert.equal(result.failed, 1);
  capture.dispose();
});

test('capture：body 都收不到 FINISHED 时 complete=false（判定为可能截断）', async () => {
  const page = makePageStub();
  const capture = createCompletionCapture(page, { logger: null });
  capture.start();
  page.emitResponse(responseStub(buildSse({ answer: '只发了一半', finish: false })));

  const result = await capture.collect({ timeoutMs: 1000 });
  assert.equal(result.text, '只发了一半');
  assert.equal(result.complete, false);
  capture.dispose();
});

test('capture：hasResponse / pendingCount 能反映原始流是否还在收', async () => {
  const page = makePageStub();
  const capture = createCompletionCapture(page, { logger: null });
  capture.start();
  assert.equal(capture.hasResponse(), false);
  assert.equal(capture.pendingCount(), 0);

  let release;
  const bodyPromise = new Promise((resolve) => {
    release = resolve;
  });
  page.emitResponse({ url: () => COMPLETION_URL, text: () => bodyPromise });
  assert.equal(capture.hasResponse(), true);
  assert.equal(capture.pendingCount(), 1);

  release(buildSse({ answer: '收完了' }));
  const result = await capture.collect({ timeoutMs: 2000 });
  assert.equal(result.text, '收完了');
  assert.equal(capture.pendingCount(), 0);
  capture.dispose();
});

test('capture：dispose 后移除监听，不再收集', async () => {
  const page = makePageStub();
  const capture = createCompletionCapture(page, { logger: null });
  capture.start();
  capture.dispose();
  assert.equal(page.listenerCount(), 0);

  page.emitResponse(responseStub(buildSse({ answer: '不应该被看到' })));
  const result = await capture.collect({ timeoutMs: 200 });
  assert.equal(result.text, '');
  assert.equal(result.bodies.length, 0);
});
