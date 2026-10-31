import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPatch,
  collectText,
  contentOf,
  createSseParser,
  createStreamState,
  reasoningOf,
} from '../src/direct/stream.mjs';

const frame = (payload) => JSON.stringify(payload);

test('初始快照 + 追加补丁 → 思考与正文分开', () => {
  const state = createStreamState();

  applyPatch(
    state,
    JSON.parse(
      frame({
        v: {
          response: {
            message_id: 2,
            status: 'WIP',
            fragments: [{ id: 2, type: 'THINK', content: '我们需要' }],
          },
        },
      }),
    ),
  );

  applyPatch(state, { p: 'response/fragments/-1/content', o: 'APPEND', v: '回答' });
  applyPatch(state, { v: '中文' });
  applyPatch(state, {
    p: 'response/fragments',
    o: 'APPEND',
    v: [{ id: 3, type: 'RESPONSE', content: '回声' }],
  });
  applyPatch(state, { p: 'response/fragments/-1/content', v: '是' });
  applyPatch(state, { v: '声波' });

  assert.equal(reasoningOf(state), '我们需要回答中文');
  assert.equal(contentOf(state), '回声是声波');
  assert.equal(collectText(state, 'THINK'), '我们需要回答中文');
});

test('BATCH 和状态补丁', () => {
  const state = createStreamState();
  applyPatch(state, { v: { response: { status: 'WIP', fragments: [] } } });
  applyPatch(state, {
    p: 'response',
    o: 'BATCH',
    v: [{ p: 'accumulated_token_usage', v: 81 }, { p: 'quasi_status', v: 'FINISHED' }],
  });
  applyPatch(state, { p: 'response/status', o: 'SET', v: 'FINISHED' });
  assert.equal(state.usage, 81);
  assert.equal(state.status, 'FINISHED');
});

test('SSE 切帧：处理跨 chunk 的半帧', () => {
  const events = [];
  const payloads = [];
  const parser = createSseParser(
    (data, event) => {
      payloads.push(data);
      if (event) events.push(event);
    },
    (event) => events.push(`e:${event}`),
  );

  const raw =
    'event: ready\ndata: {"a":1}\n\n' +
    'data: {"v":"你"}\n\n' +
    'data: {"v":"好"}\n\n' +
    'event: close\ndata: {}\n\n';

  // 按 7 字节切块，模拟网络分片
  for (let i = 0; i < raw.length; i += 7) parser.push(raw.slice(i, i + 7));

  assert.deepEqual(payloads.map((p) => JSON.stringify(p)), ['{"a":1}', '{"v":"你"}', '{"v":"好"}', '{}']);
  assert.ok(events.includes('e:ready'));
  assert.ok(events.includes('e:close'));
});

test('hint 事件（限流）能拿到事件名和内容', () => {
  const got = [];
  const parser = createSseParser((data, event) => got.push({ data, event }));
  parser.push(
    'event: hint\ndata: {"type":"error","content":"消息发送过于频繁，请稍后重试","clear_response":true,"finish_reason":"rate_limit_reached"}\n\n',
  );
  assert.equal(got.length, 1);
  assert.equal(got[0].event, 'hint');
  assert.equal(got[0].data.finish_reason, 'rate_limit_reached');
  assert.match(got[0].data.content, /频繁/);
});

test('未知路径不影响文本', () => {
  const state = createStreamState();
  applyPatch(state, { v: { response: { fragments: [{ type: 'RESPONSE', content: 'a' }] } } });
  applyPatch(state, { p: 'response/fragments/-1/elapsed_secs', o: 'SET', v: 1.2 });
  applyPatch(state, { p: 'response/whatever', o: 'SET', v: 'x' });
  assert.equal(contentOf(state), 'a');
});
