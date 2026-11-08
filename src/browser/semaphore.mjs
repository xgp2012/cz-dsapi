import { ApiError, UpstreamError } from '../errors.mjs';

/**
 * 简单信号量，带排队上限（超了直接 429，避免请求把内存堆爆）。
 *
 * 与最初版本的差别（都是踩过的坑）：
 * 1. **支持 AbortSignal**：客户端在排队期间断开时必须立刻出队并 reject。
 *    原实现排队项只有 resolve 没有 reject，断开的请求会一直占着队位，
 *    几十个死请求就能把 QUEUE_LIMIT 灌满，让正常请求全部 429。
 * 2. **释放时跳过已取消的排队项**：光把请求标成取消不够，如果队首是个已取消的
 *    空槽，`active` 仍然会被它消耗掉（名额泄漏）。
 * 3. **可选排队超时**：避免请求无限期挂在队里。
 */
export class Semaphore {
  constructor(limit, queueLimit = Infinity) {
    this.limit = Math.max(1, limit);
    this.queueLimit = queueLimit;
    this.active = 0;
    /** @type {{ grant: () => void, cancelled: boolean }[]} */
    this.queue = [];
  }

  /** 正在排队等待的数量（不含已取消的） */
  get pending() {
    return this.queue.filter((entry) => !entry.cancelled).length;
  }

  /**
   * @param {{ signal?: AbortSignal, timeoutMs?: number }} [options]
   * @returns {Promise<() => void>} 释放函数（幂等）
   */
  acquire({ signal, timeoutMs } = {}) {
    if (signal?.aborted) {
      return Promise.reject(clientClosed(signal));
    }

    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseFn());
    }

    if (this.queue.length >= this.queueLimit) {
      return Promise.reject(
        new ApiError(429, `队列已满（并发 ${this.limit}，排队上限 ${this.queueLimit}），请稍后重试`, {
          type: 'rate_limit_error',
          code: 'queue_full',
        }),
      );
    }

    return new Promise((resolve, reject) => {
      const entry = {
        cancelled: false,
        grant: () => {},
      };

      const cleanup = () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (timer) clearTimeout(timer);
      };

      const onAbort = () => {
        if (entry.cancelled) return;
        entry.cancelled = true;
        cleanup();
        // 不主动从 queue 里删：由 releaseFn 跳过，避免下标错乱。
        // 但队列全是取消项时也允许后来者进来，所以这里顺手压一下队列长度。
        this.queue = this.queue.filter((e) => e !== entry);
        reject(clientClosed(signal));
      };

      let timer = null;
      if (timeoutMs && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          if (entry.cancelled) return;
          entry.cancelled = true;
          cleanup();
          this.queue = this.queue.filter((e) => e !== entry);
          reject(
            new ApiError(429, `排队等待超时（${timeoutMs}ms），服务繁忙`, {
              type: 'rate_limit_error',
              code: 'queue_timeout',
            }),
          );
        }, timeoutMs);
        timer.unref?.();
      }

      entry.grant = () => {
        if (entry.cancelled) return;
        cleanup();
        this.active += 1;
        resolve(this.releaseFn());
      };

      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(entry);
    });
  }

  releaseFn() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      // 跳过所有已取消的排队项：它们不占名额，也不该被"释放"掉一个 active
      let next = this.queue.shift();
      while (next && next.cancelled) next = this.queue.shift();
      if (next) next.grant();
    };
  }
}

function clientClosed(signal) {
  const err = new UpstreamError('客户端已断开', { status: 499, code: 'client_closed' });
  if (signal?.reason) err.cause = signal.reason;
  return err;
}
