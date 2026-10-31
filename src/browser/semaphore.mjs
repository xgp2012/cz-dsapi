import { ApiError } from '../errors.mjs';

/** 简单信号量，带排队上限（超了直接 429，避免请求把内存堆爆） */
export class Semaphore {
  constructor(limit, queueLimit = Infinity) {
    this.limit = limit;
    this.queueLimit = queueLimit;
    this.active = 0;
    this.queue = [];
  }

  get pending() {
    return this.queue.length;
  }

  acquire() {
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
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve(this.releaseFn());
      });
    });
  }

  releaseFn() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      const next = this.queue.shift();
      if (next) next();
    };
  }
}
