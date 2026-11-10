import test from 'node:test';
import assert from 'node:assert/strict';

import { AccountPool } from '../src/direct/account-pool.mjs';
import { classifyProbeFailure } from '../src/direct/client.mjs';
import { AUTH_INVALID_COOLDOWN_MS } from '../src/direct/client.mjs';
import { AuthExpiredError, RateLimitError, TimeoutError, UpstreamError } from '../src/errors.mjs';

const logger = { info() {}, warn() {}, debug() {} };

const pool = (n) =>
  new AccountPool({
    tokens: Array.from({ length: n }, (_, i) => `probe-token-${i}-0123456789abcdef`),
    dataDir: 'test/.artifacts/data',
    logger,
  });

/* ------------------------------------------------------------------ *
 * 探活候选：只探「反正选不到」的号
 * ------------------------------------------------------------------ */

test('探活候选：健康的号不在里面（别浪费额度）', () => {
  const p = pool(2);
  assert.deepEqual(p.probeCandidates(), []);
});

test('探活候选：登录态失效的号一定要在里面', () => {
  const p = pool(2);
  p.markUnavailable(p.accounts[0], AUTH_INVALID_COOLDOWN_MS, '登录态失效', { authFailed: true });
  const candidates = p.probeCandidates();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].index, 0);
});

test('探活候选：冷却中的号也在里面（可以提前判定恢复）', () => {
  const p = pool(2);
  p.markLimited(p.accounts[1], 60_000);
  const candidates = p.probeCandidates();
  assert.deepEqual(
    candidates.map((a) => a.index),
    [1],
  );
});

test('探活候选：正在探活的号不会被第二轮重复抓走', () => {
  const p = pool(1);
  p.markLimited(p.accounts[0], 60_000);
  p.beginProbe(p.accounts[0]);
  assert.deepEqual(p.probeCandidates(), []);
  p.endProbe(p.accounts[0]);
  assert.equal(p.probeCandidates().length, 1);
});

test('探活候选：配了 inflight 上限时，在途打满的号不参与探活', () => {
  const p = new AccountPool({
    tokens: ['t-0-0123456789abcdef', 't-1-0123456789abcdef'],
    dataDir: 'test/.artifacts/data',
    logger,
    maxInflightPerAccount: 1,
  });
  const account = p.pick();
  p.markLimited(account, 60_000);
  account.cooldownUntil = Date.now() + 60_000; // 确保仍是"冷却中"
  assert.deepEqual(p.probeCandidates(), [], 'inflight 已打满，探活不该去抢');
  p.release(account);
  assert.equal(p.probeCandidates().length, 1);
});

/* ------------------------------------------------------------------ *
 * 探活结果：恢复必须是真的恢复
 * ------------------------------------------------------------------ */

test('探活成功：登录态失效的号被拉回可用状态，并记录恢复次数', () => {
  const p = pool(1);
  const account = p.accounts[0];
  p.markUnavailable(account, AUTH_INVALID_COOLDOWN_MS, '登录态失效', { authFailed: true });
  assert.equal(p.pick(), null, '前提：停用中，选不到');

  assert.equal(p.markProbeSuccess(account), true, '返回 true 表示这次是"恢复"');
  assert.equal(account.authFailed, false);
  assert.equal(account.cooldownUntil, 0);
  assert.equal(account.recovered, 1);
  assert.equal(account.probeFailures, 0);
  assert.equal(p.pick()?.index, 0, '恢复后必须能被真实请求选中');
});

test('探活成功但账号本来就健康：不算恢复，不虚报次数', () => {
  const p = pool(1);
  assert.equal(p.markProbeSuccess(p.accounts[0]), false);
  assert.equal(p.accounts[0].recovered, 0);
});

test('探活失败不延长停用：限流/抖动不能把好号钉死', () => {
  const p = pool(1);
  const account = p.accounts[0];
  p.markLimited(account, 60_000);
  const before = account.cooldownUntil;

  p.markProbeFailure(account, '探活失败：网络错误');
  assert.equal(account.cooldownUntil, before, '冷却时间必须原样不动');
  assert.equal(account.probeFailures, 1);
  assert.match(account.lastError, /探活失败/);
});

test('status 暴露探活字段，控制台才能显示"上次复检/已恢复"', () => {
  const p = pool(1);
  p.beginProbe(p.accounts[0]);
  p.markProbeFailure(p.accounts[0], 'x');
  const [status] = p.status();
  assert.equal(status.probing, true);
  assert.equal(status.probeFailures, 1);
  assert.equal(status.recovered, 0);
  assert.ok(status.lastProbeAt > 0);
});

/* ------------------------------------------------------------------ *
 * 失败分级：只有确定是登录态问题才维持停用
 * ------------------------------------------------------------------ */

test('失败分级：401/403 与 AuthExpiredError 判为 auth', () => {
  assert.equal(classifyProbeFailure(new AuthExpiredError()), 'auth');
  assert.equal(classifyProbeFailure(Object.assign(new Error('x'), { status: 401 })), 'auth');
  assert.equal(classifyProbeFailure(Object.assign(new Error('x'), { status: 403 })), 'auth');
  assert.equal(classifyProbeFailure({ code: 'deepseek_auth_required' }), 'auth');
});

test('失败分级：限流判为 limited，不能当成登录态失效', () => {
  assert.equal(classifyProbeFailure(new RateLimitError('太频繁')), 'limited');
  assert.equal(classifyProbeFailure(Object.assign(new Error('x'), { status: 429 })), 'limited');
  assert.equal(classifyProbeFailure({ code: 'deepseek_rate_limited' }), 'limited');
});

test('失败分级：超时 / 上游 5xx / 未知错误都判为 unknown', () => {
  assert.equal(classifyProbeFailure(new TimeoutError('超时')), 'unknown');
  assert.equal(classifyProbeFailure(new UpstreamError('bad gateway')), 'unknown');
  assert.equal(classifyProbeFailure(new Error('ECONNREFUSED')), 'unknown');
});
