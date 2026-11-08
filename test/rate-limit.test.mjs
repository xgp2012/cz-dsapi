import test from 'node:test';
import assert from 'node:assert/strict';

import { RateLimiter, clientIp } from '../src/rate-limit.mjs';

/**
 * 入口限流（按客户端 IP 的令牌桶）。
 *
 * 背景：只有号池冷却是"上游拒了才冷却"，攻击者照样能把流量打进来。
 * HOST=0.0.0.0 + 空 API_KEY 时，任何人不限速就能白嫖号池。
 */

test('令牌桶：容量内放行，超出拒绝并给出 retryAfterMs', () => {
  const limiter = new RateLimiter({ capacity: 3, refillPerSec: 1 });
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i += 1) {
    assert.equal(limiter.take('1.2.3.4', t0).allowed, true, `第 ${i + 1} 次应放行`);
  }
  const denied = limiter.take('1.2.3.4', t0);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs > 0, '必须告诉客户端多久后重试');
});

test('令牌桶：按时间补充令牌', () => {
  const limiter = new RateLimiter({ capacity: 2, refillPerSec: 1 });
  const t0 = 1_000_000;
  limiter.take('ip', t0);
  limiter.take('ip', t0);
  assert.equal(limiter.take('ip', t0).allowed, false);
  // 1 秒后补回 1 个
  assert.equal(limiter.take('ip', t0 + 1000).allowed, true);
  // 再立刻要一个就没了
  assert.equal(limiter.take('ip', t0 + 1000).allowed, false);
});

test('令牌桶：不同 IP 互不影响', () => {
  const limiter = new RateLimiter({ capacity: 1, refillPerSec: 1 });
  const t0 = 1_000_000;
  assert.equal(limiter.take('a', t0).allowed, true);
  assert.equal(limiter.take('a', t0).allowed, false);
  assert.equal(limiter.take('b', t0).allowed, true, '一个 IP 被限不该影响别的 IP');
});

test('令牌桶：关闭时不限流', () => {
  const limiter = new RateLimiter({ capacity: 1, enabled: false });
  for (let i = 0; i < 100; i += 1) {
    assert.equal(limiter.take('x', 1_000_000).allowed, true);
  }
});

test('令牌桶：桶数量有上限，不会因伪造 IP 撑爆内存', () => {
  const limiter = new RateLimiter({ capacity: 5, maxBuckets: 20 });
  const t0 = 1_000_000;
  for (let i = 0; i < 500; i += 1) limiter.take(`10.0.${Math.floor(i / 256)}.${i % 256}`, t0);
  assert.ok(limiter.buckets.size <= 20, `桶数量应该被限制在 20 以内，实际 ${limiter.buckets.size}`);
});

test('clientIp：默认只认 socket 地址，不信 X-Forwarded-For', () => {
  const req = {
    socket: { remoteAddress: '::ffff:203.0.113.9' },
    headers: { 'x-forwarded-for': '1.2.3.4' },
  };
  assert.equal(clientIp(req), '203.0.113.9', '没配 TRUST_PROXY 时伪造 XFF 必须无效');
});

test('clientIp：TRUST_PROXY=loopback 时，本地反代才采信 XFF', () => {
  const behindProxy = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'x-forwarded-for': '198.51.100.7, 127.0.0.1' },
  };
  assert.equal(clientIp(behindProxy, { trustProxy: 'loopback' }), '198.51.100.7');

  // 直连方是公网地址时，不采信头（避免任意客户端自报 IP）
  const direct = {
    socket: { remoteAddress: '203.0.113.9' },
    headers: { 'x-forwarded-for': '1.2.3.4' },
  };
  assert.equal(clientIp(direct, { trustProxy: 'loopback' }), '203.0.113.9');
});

test('clientIp：任意 trustProxy 值时采信 XFF', () => {
  const req = {
    socket: { remoteAddress: '10.0.0.5' },
    headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.5' },
  };
  assert.equal(clientIp(req, { trustProxy: '1' }), '198.51.100.7');
});

test('clientIp：IPv6 环回与 zone id 归一化', () => {
  assert.equal(clientIp({ socket: { remoteAddress: '::1' }, headers: {} }), '::1');
  assert.equal(clientIp({ socket: { remoteAddress: 'fe80::1%eth0' }, headers: {} }), 'fe80::1');
});
