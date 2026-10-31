import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 账号池。
 *
 * DeepSeek 网页是按「窗口内消息条数」限流的，不是按发送间隔，
 * 所以多准备几个 userToken，撞限流就换下一个，比干等冷却快得多。
 *
 * 每个账号有独立的：门禁（冷却）、PoW 预解、会话预建、设备 ID。
 */
export class AccountPool {
  constructor({ tokens, dataDir, logger }) {
    this.log = logger;
    this.dataDir = dataDir;
    this.accounts = tokens.map((token, index) => ({
      index,
      token,
      deviceId: loadDeviceId(dataDir, token),
      powNext: null,
      sessionPool: [],
      cooldownUntil: 0,
      limitedCount: 0,
      lastUsedAt: 0,
      requests: 0,
    }));
    this.cursor = 0;
    if (this.accounts.length > 1) this.log.info(`账号池已加载 ${this.accounts.length} 个 token`);
  }

  get size() {
    return this.accounts.length;
  }

  /** 轮询取一个不在冷却的账号；全都在冷却就返回 null */
  pick(now = Date.now()) {
    for (let i = 0; i < this.accounts.length; i += 1) {
      const account = this.accounts[(this.cursor + i) % this.accounts.length];
      if (account.cooldownUntil <= now) {
        this.cursor = (account.index + 1) % this.accounts.length;
        account.lastUsedAt = now;
        account.requests += 1;
        return account;
      }
    }
    return null;
  }

  /** 最近的可用时间 */
  nextAvailableAt() {
    if (!this.accounts.length) return 0;
    return Math.min(...this.accounts.map((a) => a.cooldownUntil));
  }

  markLimited(account, ms) {
    account.cooldownUntil = Date.now() + ms;
    account.limitedCount += 1;
    const seconds = Math.round(ms / 100) / 10;
    this.log.warn(
      `账号 #${account.index + 1} 触发限流，冷却 ${seconds}s（池内还有 ${
        this.accounts.filter((a) => a !== account && a.cooldownUntil <= Date.now()).length
      } 个可用）`,
    );
  }

  markHealthy(account) {
    account.cooldownUntil = 0;
  }

  status() {
    const now = Date.now();
    return this.accounts.map((a) => ({
      index: a.index + 1,
      token: maskToken(a.token),
      available: a.cooldownUntil <= now,
      cooldownMs: Math.max(0, a.cooldownUntil - now),
      requests: a.requests,
      limited: a.limitedCount,
      powReady: Boolean(a.powNext),
      sessionsReady: a.sessionPool.length,
    }));
  }

  close() {
    for (const account of this.accounts) {
      account.powNext = null;
      account.sessionPool = [];
    }
  }
}

export function maskToken(token) {
  if (!token) return '(空)';
  if (token.length <= 12) return `${token.slice(0, 3)}***`;
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

function loadDeviceId(dataDir, token) {
  const id = crypto.createHash('sha256').update(token).digest('hex').slice(0, 10);
  const file = path.join(dataDir, `device-${id}.json`);
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof saved.deviceId === 'string' && saved.deviceId.length > 8) return saved.deviceId;
  } catch {
    /* 新建 */
  }
  const deviceId = crypto.randomUUID();
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ deviceId }, null, 2)}\n`, { mode: 0o600 });
  } catch {
    /* 写不了就算了 */
  }
  return deviceId;
}
