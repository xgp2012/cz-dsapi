import test from 'node:test';
import assert from 'node:assert/strict';

import { Semaphore } from '../src/browser/semaphore.mjs';

/**
 * 信号量并发与取消语义。
 *
 * 历史 bug：排队项只有 resolve 没有 reject，客户端断开后仍然占着队位，
 * QUEUE_LIMIT 被死请求灌满 → 正常请求全部 429 queue_full。
 */

test('基本互斥：并发 acquire 时 active 不超过上限', async () => {
  const sem = new Semaphore(2, 10);
  const releases = await Promise.all([sem.acquire(), sem.acquire()]);
  assert.equal(sem.active, 2);

  let settled = false;
  const third = sem.acquire().then((r) => {
    settled = true;
    return r;
  });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false, '超过上限的第三个请求必须排队');

  releases[0]();
  const r3 = await third;
  assert.equal(sem.active, 2);
  r3();
  releases[1]();
  assert.equal(sem.active, 0);
});

test('abort：排队中取消会 reject，且不会污染队列', async () => {
  const sem = new Semaphore(1, 5);
  const release = await sem.acquire();

  const controller = new AbortController();
  const queued = sem.acquire({ signal: controller.signal });
  assert.equal(sem.pending, 1);

  controller.abort(new Error('client disconnected'));
  await assert.rejects(queued, (err) => err.code === 'client_closed');
  assert.equal(sem.pending, 0, '取消后不应继续占用队位');

  release();
  assert.equal(sem.active, 0);
});

test('abort 后不泄漏名额：释放时跳过已取消项', async () => {
  const sem = new Semaphore(1, 5);
  const first = await sem.acquire();

  // 三个排队者，中间那个取消
  const c2 = new AbortController();
  const cancelled = sem.acquire({ signal: c2.signal });
  const third = sem.acquire();

  c2.abort();
  await assert.rejects(cancelled);

  first();
  // 第三个必须拿到名额（而不是被已取消的空槽吃掉）
  const r3 = await third;
  assert.equal(sem.active, 1);
  r3();
  assert.equal(sem.active, 0);
});

test('queue_full：队列满时返回 429', async () => {
  const sem = new Semaphore(1, 1);
  const release = await sem.acquire();
  const queued = sem.acquire();

  await assert.rejects(sem.acquire(), (err) => {
    assert.equal(err.status, 429);
    assert.equal(err.code, 'queue_full');
    return true;
  });

  release();
  (await queued)();
});

test('queue_full 后取消一个排队者，队列应重新可以进人', async () => {
  const sem = new Semaphore(1, 1);
  const release = await sem.acquire();

  const c = new AbortController();
  const queued = sem.acquire({ signal: c.signal });
  c.abort();
  await assert.rejects(queued);

  // 队列已空，应该能再进一个
  const next = sem.acquire();
  release();
  const r = await next;
  r();
});

test('已 aborted 的 signal 直接 reject，不入队', async () => {
  const sem = new Semaphore(1, 5);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sem.acquire({ signal: controller.signal }), (err) => err.code === 'client_closed');
  assert.equal(sem.pending, 0);
  assert.equal(sem.active, 0);
});

test('排队超时会 reject 且不占名额', async () => {
  const sem = new Semaphore(1, 5);
  const release = await sem.acquire();
  await assert.rejects(sem.acquire({ timeoutMs: 20 }), (err) => err.code === 'queue_timeout');
  assert.equal(sem.pending, 0);
  release();
  assert.equal(sem.active, 0);
});

test('release 是幂等的，重复调用不会多放一个', async () => {
  const sem = new Semaphore(1, 5);
  const release = await sem.acquire();
  const waiting = sem.acquire();
  release();
  release(); // 第二次必须无效
  const r = await waiting;
  assert.equal(sem.active, 1, '重复 release 不应把 active 减成 0 从而多放行');
  r();
  assert.equal(sem.active, 0);
});
