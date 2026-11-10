import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPatch,
  collectText,
  contentOf,
  createSseParser,
  createStreamState,
  createTextTracker,
  materializeFragment,
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

test('追加走增量缓冲：读取前 content 允许滞后，读时合并且幂等', () => {
  const state = createStreamState();
  applyPatch(state, { v: { response: { fragments: [{ type: 'RESPONSE', content: '起' }] } } });

  // 连续追加很多帧，模拟长回答：content 本身不该被反复整段复制
  let expected = '起';
  for (let i = 0; i < 200; i += 1) {
    applyPatch(state, { v: 'x' });
    expected += 'x';
  }

  const fragment = state.fragments[0];
  assert.ok(Array.isArray(fragment._parts), '追加应该先进增量缓冲，而不是直接拼字符串');

  // 第一次读：合并
  assert.equal(contentOf(state), expected);
  assert.equal(fragment._parts, undefined, '合并后必须清掉增量缓冲');

  // 第二次读：幂等，不能重复追加
  assert.equal(contentOf(state), expected);
  assert.equal(contentOf(state), expected);
});

test('materializeFragment：对来自快照的片段是空操作', () => {
  const fragment = { type: 'RESPONSE', content: '快照内容' };
  materializeFragment(fragment);
  assert.equal(fragment.content, '快照内容');
  assert.equal(fragment._parts, undefined);
});

test('增量缓冲 + 快照替换：追踪器不丢字也不重复', () => {
  const state = createStreamState();
  applyPatch(state, { v: { response: { fragments: [{ id: 1, type: 'RESPONSE', content: 'AB' }] } } });
  const tracker = createTextTracker();
  let sent = tracker(state.fragments, 'RESPONSE');
  assert.equal(sent, 'AB');

  // 常态追加：只返回新增量
  applyPatch(state, { v: 'CD' });
  const delta = tracker(state.fragments, 'RESPONSE');
  assert.equal(delta, 'CD');
  sent += delta;

  // 快照整体替换成更长的同前缀内容：不能重复发出已有的部分
  applyPatch(state, {
    v: { response: { fragments: [{ id: 2, type: 'RESPONSE', content: 'ABCDE' }] } },
  });
  const more = tracker(state.fragments, 'RESPONSE');
  assert.equal(more, 'E');
  assert.equal(sent + more, 'ABCDE');
});

test('追踪器：片段被中间改写时返回 null，交给调用方回退全文', () => {
  const state = createStreamState();
  applyPatch(state, {
    v: { response: { fragments: [{ id: 1, type: 'RESPONSE', content: 'ABC' }] } },
  });
  const tracker = createTextTracker();
  assert.equal(tracker(state.fragments, 'RESPONSE'), 'ABC');

  // 内容变短（改写而非追加）→ 无法增量
  applyPatch(state, {
    v: { response: { fragments: [{ id: 2, type: 'RESPONSE', content: 'XY' }] } },
  });
  assert.equal(tracker(state.fragments, 'RESPONSE'), null);
});

test('SSE 切帧：超长单帧分成很多块也能解析（不随长度二次退化）', () => {
  const got = [];
  const parser = createSseParser((data) => got.push(data));
  const big = 'x'.repeat(20_000);
  const raw = `data: {"v":"${big}"}\n\ndata: {"v":"尾"}\n\n`;

  // 每次只喂 13 字节，强制跨块
  for (let i = 0; i < raw.length; i += 13) parser.push(raw.slice(i, i + 13));

  assert.equal(got.length, 2);
  assert.equal(got[0].v, big);
  assert.equal(got[1].v, '尾');
});

test('SSE flush：未以空行结尾的残帧也要处理', () => {
  const got = [];
  const parser = createSseParser((data) => got.push(data));
  parser.push('data: {"v":"半"}');
  assert.equal(got.length, 0, '没有帧结束符时不该提前回调');
  parser.flush();
  assert.deepEqual(got, [{ v: '半' }]);
});
