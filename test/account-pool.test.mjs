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

test('maskToken', () => {
  assert.equal(maskToken(''), '(空)');
  assert.equal(maskToken('short'), 'sho***');
  assert.match(maskToken('abcdefghijklmnopqrstuvwxyz'), /^abcd…wxyz$/);
});
