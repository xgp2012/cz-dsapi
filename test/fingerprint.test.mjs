import test from 'node:test';
import assert from 'node:assert/strict';

import { padPowDuration, typingDelay, typingDelayFor } from '../src/direct/fingerprint.mjs';

/**
 * 时序伪装参数的首字延迟影响。
 *
 * 这些不是「随便加个延迟」的常量，改它们直接决定首字快慢，
 * 所以把区间和语义都钉死，避免以后被顺手调小/调大。
 */

test('typingDelayFor：冷路径（新建会话）保持原区间 120–480ms', () => {
  for (let i = 0; i < 500; i += 1) {
    const delay = typingDelayFor({ warm: false });
    assert.ok(delay >= 120 && delay < 480, `冷路径延迟 ${delay} 越界`);
  }
});

test('typingDelayFor：热路径（复用预热会话）显著更短，但不为零', () => {
  for (let i = 0; i < 500; i += 1) {
    const delay = typingDelayFor({ warm: true });
    // 不为零：0 延迟比固定值更像机器；比冷路径短：该路径上「用户在打字」不成立
    assert.ok(delay >= 20 && delay < 90, `热路径延迟 ${delay} 越界`);
  }
  // 上限必须严格小于冷路径下限，否则这个分支就没有存在意义
  assert.ok(90 < 120, '热路径上界必须低于冷路径下界');
});

test('typingDelayFor：缺省参数等价于冷路径', () => {
  for (let i = 0; i < 200; i += 1) {
    const delay = typingDelayFor();
    assert.ok(delay >= 120 && delay < 480, `缺省延迟 ${delay} 应落在冷路径区间`);
  }
});

test('typingDelay：独立函数仍返回 120–480ms 区间', () => {
  for (let i = 0; i < 200; i += 1) {
    const delay = typingDelay();
    assert.ok(delay >= 120 && delay < 480, `typingDelay ${delay} 越界`);
  }
});

test('padPowDuration：只补不削，已超时就返回 0', () => {
  // 已经花了 10s，远超 120–520ms 的目标窗口 → 不再补
  assert.equal(padPowDuration(Date.now() - 10_000), 0);
  // 刚开始 → 必须补，补完总耗时落在窗口内
  for (let i = 0; i < 300; i += 1) {
    const startedAt = Date.now();
    const pad = padPowDuration(startedAt);
    const total = Date.now() - startedAt + pad;
    assert.ok(pad >= 0, 'pad 不能为负');
    assert.ok(total >= 120 && total <= 520, `补齐后总耗时 ${total} 应落在 120–520ms`);
  }
});

test('padPowDuration：起点用请求入口时刻（含真实网络耗时），不是 PoW 求解时刻', () => {
  // 这条锁定一个曾经被改错的行为：把起点挪到 PoW 求解处，会让
  // 「建会话 + 拉 challenge」的真实 RTT 不再抵扣补齐时长，
  // 网络快的机器每个请求白垫约 100ms。网络耗时抵扣补齐是收益不是 bug。
  const networkMs = 250; // 建会话 + challenge RTT
  const pad = padPowDuration(Date.now() - networkMs);
  // 已经消耗 250ms：要么不补，要么只补到窗口内的差额，不可能再补满一整个窗口
  assert.ok(pad <= 520 - networkMs + 50, `网络耗时应当抵扣补齐时长，实际 pad=${pad}`);
});
