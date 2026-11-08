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
  constructor({ tokens, dataDir, logger, maxInflightPerAccount = 0 }) {
    this.log = logger;
    this.dataDir = dataDir;
    /**
     * 每个账号同时在途的请求上限（0 = 不限）。
     *
     * 不加限制时，纯轮询会把**所有**并发请求压到同一个账号上（游标转一圈还是它，
     * 因为它一直"有空"），于是该账号的 PoW 预解/会话预建被抢空、风控集中命中，
     * 而其它账号闲着。有上限时请求会自动摊到还没打满的账号上。
     */
    this.maxInflightPerAccount = Math.max(0, Number(maxInflightPerAccount) || 0);
    this.accounts = tokens.map((token, index) => ({
      index,
      token,
      deviceId: loadDeviceId(dataDir, token),
      /** 预解好的 PoW：数组，每个请求取走一个（并发时才能各自拿到，只留一个会立刻被抢空） */
      powPool: [],
      powPending: null,
      sessionPool: [],
      /** 在途请求数，配合 maxInflightPerAccount 做摊分 */
      inflight: 0,
      cooldownUntil: 0,
      limitedCount: 0,
      errorCount: 0,
      lastError: null,
      /** 登录态失效：换 token / 重启进程之前这个号不会再被选中 */
      authFailed: false,
      lastUsedAt: 0,
      requests: 0,
    }));
    this.cursor = 0;
    if (this.accounts.length > 1) this.log.info(`账号池已加载 ${this.accounts.length} 个 token`);
  }

  get size() {
    return this.accounts.length;
  }

  /** 这个账号现在能不能接新活 */
  #usable(account, now) {
    if (account.cooldownUntil > now) return false;
    if (this.maxInflightPerAccount > 0 && account.inflight >= this.maxInflightPerAccount) return false;
    return true;
  }

  /** 轮询取一个可用账号；全都不可用就返回 null */
  pick(now = Date.now()) {
    for (let i = 0; i < this.accounts.length; i += 1) {
      const account = this.accounts[(this.cursor + i) % this.accounts.length];
      if (this.#usable(account, now)) {
        this.cursor = (account.index + 1) % this.accounts.length;
        account.lastUsedAt = now;
        account.requests += 1;
        account.inflight += 1;
        return account;
      }
    }
    return null;
  }

  /**
   * 归还一个账号（请求结束时调用，与 pick 成对）。
   * 必须在 finally 里调，否则 inflight 只增不减，最终把账号永久锁死。
   */
  release(account) {
    if (!account) return;
    account.inflight = Math.max(0, account.inflight - 1);
  }

  /** 最近的可用时间 */
  nextAvailableAt() {
    if (!this.accounts.length) return 0;
    return Math.min(...this.accounts.map((a) => a.cooldownUntil));
  }

  /** 池里还有没有立刻能用的账号（只看状态，不消耗轮询游标） */
  hasAvailable(now = Date.now()) {
    return this.accounts.some((a) => this.#usable(a, now));
  }

  /** 是否所有账号都因为登录态失效被停用 */
  allAuthFailed() {
    return this.accounts.length > 0 && this.accounts.every((a) => a.authFailed);
  }

  markLimited(account, ms) {
    account.cooldownUntil = Math.max(account.cooldownUntil, Date.now() + ms);
    account.limitedCount += 1;
    account.lastError = '触发限流';
    const seconds = Math.round(ms / 100) / 10;
    this.log.warn(
      `账号 #${account.index + 1} 触发限流，冷却 ${seconds}s（池内还有 ${
        this.accounts.filter((a) => a !== account && a.cooldownUntil <= Date.now()).length
      } 个可用）`,
    );
  }

  /**
   * 账号级失败（登录态失效 / 上游报错）导致的停用。
   * 冷却期内这个号不会被选中，避免每次请求先撞一次坏号、要靠客户端重发才能换号。
   */
  markUnavailable(account, ms, reason, { authFailed = false } = {}) {
    account.cooldownUntil = Math.max(account.cooldownUntil, Date.now() + ms);
    account.errorCount += 1;
    account.lastError = reason;
    if (authFailed) account.authFailed = true;
    const seconds = Math.round(ms / 100) / 10;
    this.log.warn(
      `账号 #${account.index + 1} 不可用（${reason}），停用 ${seconds}s（池内还有 ${
        this.accounts.filter((a) => a !== account && a.cooldownUntil <= Date.now()).length
      } 个可用）`,
    );
  }

  markHealthy(account) {
    account.cooldownUntil = 0;
    account.authFailed = false;
    account.lastError = null;
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
      errors: a.errorCount,
      lastError: a.lastError,
      authFailed: a.authFailed,
      inflight: a.inflight,
      powReady: a.powPool.length,
      sessionsReady: a.sessionPool.length,
    }));
  }

  close() {
    for (const account of this.accounts) {
      account.powPool = [];
      account.powPending = null;
      account.sessionPool = [];
      account.inflight = 0;
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
