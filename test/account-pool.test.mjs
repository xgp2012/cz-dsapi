import test from 'node:test';
import assert from 'node:assert/strict';

import { AccountPool, maskToken } from '../src/direct/account-pool.mjs';

const logger = { info() {}, warn() {}, debug() {} };

const pool = (n) =>
  new AccountPool({
    tokens: Array.from({ length: n }, (_, i) => `token-${i}-0123456789abcdef`),
    dataDir: 'test/.artifacts/data',
    logger,
  });

test('轮询：依次使用每个账号', () => {
  const p = pool(3);
  assert.deepEqual([p.pick().index, p.pick().index, p.pick().index], [0, 1, 2]);
  assert.equal(p.pick().index, 0);
});

test('限流账号会被跳过，换下一个', () => {
  const p = pool(2);
  const first = p.pick();
  p.markLimited(first, 60_000);
  const next = p.pick();
  assert.equal(next.index, 1);
  assert.equal(first.cooldownUntil > Date.now(), true);
});

test('全部限流时 pick 返回 null，并能给出恢复时间', () => {
  const p = pool(2);
  p.markLimited(p.pick(), 1_000);
  p.markLimited(p.pick(), 5_000);
  assert.equal(p.pick(), null);
  const wait = p.nextAvailableAt() - Date.now();
  assert.ok(wait > 0 && wait <= 5_100, `wait=${wait}`);
});

test('冷却结束后重新可用', () => {
  const p = pool(1);
  const account = p.pick();
  p.markLimited(account, 30);
  assert.equal(p.pick(), null);
  account.cooldownUntil = Date.now() - 1;
  assert.equal(p.pick(), account);
});

test('status 只暴露打码后的 token', () => {
  const p = pool(1);
  p.pick();
  const [info] = p.status();
  assert.equal(info.index, 1);
  assert.equal(info.requests, 1);
  assert.ok(!info.token.includes('0123456789abcdef'));
  assert.match(info.token, /…/);
});

test('账号级失败会停用该账号，后续 pick 直接跳过（不需要客户端重发）', () => {
  const p = pool(2);
  const bad = p.pick();
  p.markUnavailable(bad, 60_000, '登录态失效', { authFailed: true });

  // 同一个进程里下一次 pick 就应该直接选另一个号
  assert.equal(p.hasAvailable(), true);
  assert.equal(p.pick().index, 1);
  assert.equal(bad.authFailed, true);
  assert.equal(bad.lastError, '登录态失效');
  assert.equal(bad.errorCount, 1);
});

test('全部登录态失效：pick 返回 null，allAuthFailed 为真，status 带原因', () => {
  const p = pool(2);
  for (let i = 0; i < 2; i += 1) {
    p.markUnavailable(p.pick(), 60_000, '登录态失效', { authFailed: true });
  }
  assert.equal(p.pick(), null);
  assert.equal(p.allAuthFailed(), true);
  const [first] = p.status();
  assert.equal(first.available, false);
  assert.equal(first.authFailed, true);
  assert.match(first.lastError, /登录态失效/);
});

test('markHealthy 清掉停用状态', () => {
  const p = pool(1);
  const account = p.pick();
  p.markUnavailable(account, 60_000, '上游报错');
  p.markHealthy(account);
  assert.equal(account.cooldownUntil, 0);
  assert.equal(account.authFailed, false);
  assert.equal(account.lastError, null);
  assert.equal(p.pick(), account);
});

test('maskToken', () => {
  assert.equal(maskToken(''), '(空)');
  assert.equal(maskToken('short'), 'sho***');
  assert.match(maskToken('abcdefghijklmnopqrstuvwxyz'), /^abcd…wxyz$/);
});

/* ------------------------------------------------------------------ *
 * 并发：在途上限与名额归还
 *
 * 历史问题：pick() 是纯轮询，没有任何在途限制 —— 所有并发请求会被压到
 * 同一个"看起来有空"的账号上，其它号闲着；该号的 PoW 预解 / 会话预建被抢空，
 * 风控也集中在同一个号上。
 * ------------------------------------------------------------------ */

test('并发：maxInflightPerAccount 限制单账号，请求自动摊到别的号', () => {
  const p = new AccountPool({
    tokens: ['a-0123456789', 'b-0123456789'],
    dataDir: 'test/.artifacts/data',
    logger,
    maxInflightPerAccount: 1,
  });

  const first = p.pick();
  assert.equal(first.inflight, 1);

  const second = p.pick();
  assert.ok(second, '第二个账号应该可用');
  assert.notEqual(second.index, first.index, '有在途上限时必须换号，而不是继续压同一个');

  assert.equal(p.pick(), null, '所有号都达到在途上限时应该返回 null');
  assert.equal(p.hasAvailable(), false, '达到在途上限的号不算"可用"');
});

test('并发：release 之后名额重新可用', () => {
  const p = new AccountPool({
    tokens: ['a-0123456789'],
    dataDir: 'test/.artifacts/data',
    logger,
    maxInflightPerAccount: 1,
  });

  const account = p.pick();
  assert.equal(p.pick(), null);
  p.release(account);
  assert.equal(account.inflight, 0);
  assert.equal(p.pick(), account, '释放后应该能再次取到');
});

test('并发：重复 release 不会把 inflight 减成负数', () => {
  const p = new AccountPool({
    tokens: ['a-0123456789'],
    dataDir: 'test/.artifacts/data',
    logger,
    maxInflightPerAccount: 2,
  });

  const account = p.pick();
  p.release(account);
  p.release(account);
  p.release(account);
  assert.equal(account.inflight, 0, 'inflight 为负会让上限判断失效');
});

test('并发：release(null) 不炸', () => {
  const p = pool(1);
  p.release(null);
  p.release(undefined);
});

test('并发：maxInflightPerAccount=0 表示不限制', () => {
  const p = pool(1);
  for (let i = 0; i < 5; i += 1) assert.ok(p.pick(), `第 ${i + 1} 次应该都能取到`);
  assert.equal(p.accounts[0].inflight, 5);
});

test('并发的 PoW 预解池：是数组且计数进 status', () => {
  const p = pool(1);
  const account = p.accounts[0];
  assert.deepEqual(account.powPool, [], '预解池应该是数组（单个 Promise 在并发下会被抢空）');
  assert.equal(account.powPending, null);

  account.powPool.push({ header: 'h', expireAt: Date.now() + 60_000 });
  const [info] = p.status();
  assert.equal(info.powReady, 1, 'status.powReady 应该是池子大小');
  assert.equal(info.inflight, 0);
});

test('并发：close 清空预解/会话并把 inflight 归零', () => {
  const p = pool(1);
  const account = p.accounts[0];
  account.powPool.push({ header: 'h', expireAt: Date.now() + 60_000 });
  account.sessionPool.push('s1');
  p.pick();

  p.close();

  assert.equal(account.powPool.length, 0);
  assert.equal(account.powPending, null);
  assert.equal(account.sessionPool.length, 0);
  assert.equal(account.inflight, 0);
});

test('设备画像：同一 token 在重建号池后设备 ID 保持不变', () => {
  const tokens = ['stable-0123456789abcdef'];
  const make = () => new AccountPool({ tokens, dataDir: 'test/.artifacts/data', logger });
  const first = make().accounts[0].deviceId;
  const again = make().accounts[0].deviceId;
  assert.ok(first && first.length > 8, 'deviceId 应该是有效值');
  assert.equal(again, first, '设备画像必须长期稳定，否则请求特征会跳变');
});
