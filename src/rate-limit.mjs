import { ApiError } from './errors.mjs';

/**
 * IP 级速率限制（令牌桶）。
 *
 * 为什么需要：这个服务会把网页版 DeepSeek 包装成 API，一旦 `HOST=0.0.0.0`
 * 且 `API_KEY` 为空（两者都是很常见的配置组合），任何人都能拿它当免费代理，
 * 直接把号池烧干、把账号打进风控。原来的实现只有"号池冷却"，那是**上游**限流，
 * 不是**入口**限流 —— 上游拒了才冷却，攻击者照样能把流量打进来。
 *
 * 设计取舍：
 * - **令牌桶**而不是固定窗口：允许短突发（agent 一次并行发几个工具轮次很正常），
 *   但仍然约束长期速率；
 * - **按桶总数上限淘汰**：IP 是不可信输入，攻击者可以伪造大量来源把 Map 撑爆
 *   （内存 DoS）。这里用 `maxBuckets` 做硬上限，满了先清过期的，再不够就淘汰
 *   最久未使用的；
 * - **只对需要"用上游额度"的路径限流**：`/healthz`、`/admin` 静态资源不限，
 *   否则健康检查会被自己限死。
 */

/** 默认：每分钟 60 次突发，稳态每秒补 1 个令牌 */
const DEFAULT_CAPACITY = 60;
const DEFAULT_REFILL_PER_SEC = 1;

export class RateLimiter {
  /**
   * @param {{ capacity?: number, refillPerSec?: number, maxBuckets?: number, enabled?: boolean }} opts
   */
  constructor({ capacity = DEFAULT_CAPACITY, refillPerSec = DEFAULT_REFILL_PER_SEC, maxBuckets = 10_000, enabled = true } = {}) {
    this.capacity = Math.max(1, capacity);
    this.refillPerSec = Math.max(0.001, refillPerSec);
    this.maxBuckets = Math.max(16, maxBuckets);
    this.enabled = enabled;
    /** @type {Map<string, { tokens: number, updatedAt: number }>} */
    this.buckets = new Map();
  }

  /** 每个令牌代表多少毫秒，用于算 Retry-After */
  get msPerToken() {
    return 1000 / this.refillPerSec;
  }

  /**
   * 消耗一个令牌。
   * @param {string} key 通常是客户端 IP
   * @returns {{ allowed: boolean, retryAfterMs: number, remaining: number }}
   */
  take(key, now = Date.now()) {
    if (!this.enabled) return { allowed: true, retryAfterMs: 0, remaining: this.capacity };

    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxBuckets) this.#evict(now);
      bucket = { tokens: this.capacity, updatedAt: now };
      this.buckets.set(key, bucket);
    } else {
      // 按经过的时间补充令牌
      const elapsed = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(this.capacity, bucket.tokens + (elapsed / 1000) * this.refillPerSec);
      bucket.updatedAt = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterMs: 0, remaining: Math.floor(bucket.tokens) };
    }

    const need = 1 - bucket.tokens;
    return { allowed: false, retryAfterMs: Math.ceil(need * this.msPerToken), remaining: 0 };
  }

  /** 清掉长期不用的桶；如果还满就淘汰最久未使用的 */
  #evict(now = Date.now()) {
    const staleBefore = now - 10 * 60_000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.updatedAt < staleBefore) this.buckets.delete(key);
    }
    if (this.buckets.size < this.maxBuckets) return;

    // 还是满：按 updatedAt 淘汰最老的 10%
    const sorted = [...this.buckets.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    const dropCount = Math.max(1, Math.ceil(sorted.length * 0.1));
    for (let i = 0; i < dropCount; i += 1) this.buckets.delete(sorted[i][0]);
  }

  /** 后台定期清理，避免长期运行后 Map 只增不减 */
  startSweep(intervalMs = 5 * 60_000) {
    const timer = setInterval(() => this.#evict(Date.now()), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  status() {
    return { enabled: this.enabled, capacity: this.capacity, refillPerSec: this.refillPerSec, buckets: this.buckets.size };
  }
}

/**
 * 取客户端 IP。
 *
 * 直接取 `socket.remoteAddress` 在有反向代理时永远是代理的地址，
 * 按 IP 限流就退化成了"全局限流"。所以：
 * - 默认**只认 socket 地址**（安全：客户端伪造 X-Forwarded-For 也没用）；
 * - 只有在配置了 `TRUST_PROXY` 时才读 `X-Forwarded-For` 的最左项；
 * - `TRUST_PROXY=loopback` 表示只在直连方是本地/私网时才信任头（本地反代场景）。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ trustProxy?: string }} [opts]
 */
export function clientIp(req, { trustProxy = '' } = {}) {
  const socketIp = normalizeIp(req.socket?.remoteAddress || '');
  const trust = String(trustProxy || '').trim().toLowerCase();
  if (!trust) return socketIp;

  const fromSocket = trust === 'loopback' ? isLoopbackOrPrivate(socketIp) : true;
  if (!fromSocket) return socketIp;

  const forwarded = req.headers['x-forwarded-for'] || req.headers['x-real-ip'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (!raw) return socketIp;

  // XFF 是 "client, proxy1, proxy2"，最左是被代理的真实客户端
  const first = String(raw).split(',')[0].trim();
  return first ? normalizeIp(first) : socketIp;
}

/** ::ffff:1.2.3.4 → 1.2.3.4；去掉 IPv6 zone */
function normalizeIp(ip) {
  let out = String(ip || '').trim();
  if (out.startsWith('[') && out.endsWith(']')) out = out.slice(1, -1);
  const zone = out.indexOf('%');
  if (zone >= 0) out = out.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(out);
  return mapped ? mapped[1] : out;
}

function isLoopbackOrPrivate(ip) {
  if (!ip) return false;
  if (ip === '::1' || ip.startsWith('127.')) return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.')) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m) {
    const second = Number(m[1]);
    return second >= 16 && second <= 31;
  }
  return ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80');
}

/**
 * 把限流结果转成错误（带 retryAfterMs，外层会写 Retry-After 头）。
 * @param {{ retryAfterMs: number }} result
 */
export function rateLimitedError(result) {
  const seconds = Math.max(1, Math.ceil((result.retryAfterMs || 1000) / 1000));
  const err = new ApiError(429, `请求过于频繁，请在 ${seconds}s 后重试`, {
    type: 'rate_limit_error',
    code: 'local_rate_limited',
  });
  err.retryAfterMs = result.retryAfterMs || seconds * 1000;
  return err;
}
