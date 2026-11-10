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
      /**
       * 后台探活（见 src/account-monitor.mjs）：
       * 账号被停用后不是死等 24h 或人工重启，而是由探活循环定期复检、
       * 成功就自动恢复。这四个字段全部由探活循环写入。
       */
      probing: false,
      lastProbeAt: 0,
      recovered: 0,
      probeFailures: 0,
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

  /* ------------------------------------------------------------------ *
   * 后台探活：给「手工恢复」补上自动路径
   * ------------------------------------------------------------------ */

  /**
   * 挑出值得探活的账号。
   *
   * 只挑**当前不可能被请求选中**的号，这样探活永远不会和正常流量抢同一个号
   * （抢了会白白多消耗一份限流额度，还可能把好号打成冷却）：
   *   - 登录态失效停用的（这是主要的自愈目标，否则要等 24h 或人工重启）
   *   - 冷却中的（探活成功说明它其实已经恢复，可以提前结束冷却）
   *
   * 已经健康的号不探活：它们由真实请求负责验证，多探一次纯浪费额度。
   */
  probeCandidates({ now = Date.now(), includeHealthy = false } = {}) {
    return this.accounts.filter((account) => {
      if (account.probing) return false;
      if (this.maxInflightPerAccount > 0 && account.inflight >= this.maxInflightPerAccount) return false;
      const needsProbe = account.authFailed || account.cooldownUntil > now;
      return includeHealthy || needsProbe;
    });
  }

  /** 标记探活开始，防止同一账号被两轮探活同时抓走 */
  beginProbe(account, now = Date.now()) {
    account.probing = true;
    account.lastProbeAt = now;
  }

  endProbe(account) {
    account.probing = false;
  }

  /**
   * 探活成功：账号从停用/冷却里恢复。
   * 复用 markHealthy 的语义（清冷却、清 authFailed），并把这次恢复记在账号上，
   * 便于 /admin 与日志回答「这个号是不是自己恢复的」。
   */
  markProbeSuccess(account) {
    const wasFailed = account.authFailed || account.cooldownUntil > Date.now();
    this.markHealthy(account);
    account.probeFailures = 0;
    if (wasFailed) {
      account.recovered += 1;
      return true;
    }
    return false;
  }

  /**
   * 探活失败：只累计次数，**不动冷却与 authFailed**。
   *
   * 失败要分级，不能一律判死：限流（说明 token 有效，只是此刻额度用完）
   * 和网络抖动都不该延长停用，否则一次探活抖动就能把好号永久锁在冷却里。
   * 具体的分级判定在 DirectEngine.probe() 里做，这里只负责记账。
   */
  markProbeFailure(account, reason) {
    account.probeFailures += 1;
    if (reason) account.lastError = reason;
    return account.probeFailures;
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
      probing: a.probing,
      lastProbeAt: a.lastProbeAt || null,
      probeFailures: a.probeFailures,
      recovered: a.recovered,
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
