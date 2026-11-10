/**
 * 账号后台探活。
 *
 * 解决的问题（原来这些全是**人工**动作）：
 *
 *   1. token 过期 → 账号被钉死在 `authFailed` 24 小时（AUTH_INVALID_COOLDOWN_MS），
 *      号池全失效时请求直接 503「请重新 auth」。用户必须自己发现、自己重跑
 *      `npm run auth`、自己重启进程。
 *   2. 限流冷却到期后没人验证账号是否真的恢复，只能等下一条真实请求去撞。
 *   3. 账号「悄悄变差」（偶发上游报错、设备画像被风控）没有任何观测。
 *
 * 这个循环做三件事，全部是**非侵入**的：
 *   - 定时挑 **当前不可能被请求选中** 的号（停用 / 冷却中）做一次轻量探活，
 *     成功就 `markProbeSuccess` 自动恢复，失败按 `classifyProbeFailure` 分级；
 *   - 探活完全不和正常流量抢号，也不消耗消息额度（走到预建会话为止）；
 *   - 只在**状态发生变化**时打日志 / 触发回调，不做轮询式刷屏。
 *
 * 设计上的几个刻意的保守选择：
 *   - 单轮只探一个号：探活自己变成风控来源是最坏的结果；
 *   - `unref()`：不阻止进程退出，`npm run down` 不会被它挂住；
 *   - 引擎不支持 `probe()`（browser 引擎、UnconfiguredEngine）时整个模块静默失效，
 *     不需要调用方做特判。
 */

export const DEFAULT_PROBE_INTERVAL_MS = 10 * 60_000;
const MIN_PROBE_INTERVAL_MS = 60_000;

/**
 * @param {object} opts
 * @param {object} opts.engine      引擎实例（需同时具备 probe() 与 pool）
 * @param {object} opts.config      loadConfig() 的结果
 * @param {object} opts.logger
 * @param {(event: object) => void} [opts.onEvent] 状态变化回调（失效 / 恢复）
 */
export function createAccountMonitor({ engine, config, logger, onEvent } = {}) {
  const log = logger;
  const intervalMs = Math.max(
    MIN_PROBE_INTERVAL_MS,
    Number(config?.runtime?.accountProbeIntervalMs) || DEFAULT_PROBE_INTERVAL_MS,
  );

  let timer = null;
  let running = false;
  let stopped = false;
  /** 上一轮的快照，用来「只在变化时报告」 */
  let lastSnapshot = new Map();
  let rounds = 0;
  let probes = 0;
  let recoveries = 0;

  /** 引擎是否具备探活能力：缺任何一项就当没这个模块 */
  function supported() {
    return Boolean(engine && typeof engine.probe === 'function' && engine.pool?.probeCandidates);
  }

  function snapshot() {
    const map = new Map();
    for (const account of engine.pool.accounts) {
      map.set(account.index, {
        authFailed: Boolean(account.authFailed),
        available: account.cooldownUntil <= Date.now(),
        lastError: account.lastError,
      });
    }
    return map;
  }

  /** 对比快照，把「新失效 / 新恢复」报出去 */
  function reportChanges() {
    if (typeof onEvent !== 'function') {
      lastSnapshot = snapshot();
      return;
    }
    const next = snapshot();
    for (const [index, now] of next) {
      const before = lastSnapshot.get(index);
      if (!before) continue;
      // 失效：之前可用，现在不可用
      if (before.available && !now.available) {
        onEvent({
          type: 'unavailable',
          index: index + 1,
          authFailed: now.authFailed,
          reason: now.lastError,
        });
      }
      // 恢复：之前不可用，现在可用
      if (!before.available && now.available) {
        onEvent({ type: 'recovered', index: index + 1 });
      }
    }
    lastSnapshot = next;
  }

  async function tick() {
    if (stopped || !supported()) return;
    const candidates = engine.pool.probeCandidates();
    if (!candidates.length) {
      reportChanges();
      return;
    }

    // 单轮只探一个：探活自己不能成为风控来源
    const account = candidates[0];
    rounds += 1;
    probes += 1;
    const before = snapshot().get(account.index);
    const result = await engine.probe(account).catch((err) => ({
      ok: false,
      kind: 'unknown',
      detail: err?.message || String(err),
    }));

    if (result.ok && before && !before.available) {
      recoveries += 1;
      // 恢复事件由 reportChanges 统一发，这里只记日志
      log.info(`账号 #${account.index + 1} 已由后台探活自动恢复，无需人工重启`);
    } else if (!result.ok && result.kind === 'auth' && before && !before.authFailed) {
      // 新判定为失效：这是最需要人知道的事件
      log.warn(
        `账号 #${account.index + 1} 登录态失效（探活判定）。其余账号会继续服务；` +
          '恢复方式：在控制台「账号」页重新粘贴 token，或直接清 localStorage 后重新登录取新 token',
      );
    }
    reportChanges();
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => {
      tick()
        .catch((err) => log.warn('账号探活异常（忽略）:', err?.message || String(err)))
        .finally(() => schedule());
    }, intervalMs);
    // 不阻止进程退出：npm run down / 优雅关闭不该被这个定时器挂住
    timer.unref?.();
  }

  return {
    start() {
      if (!supported()) {
        log.debug('当前引擎不支持后台探活（只有直连引擎有多账号），已跳过');
        return false;
      }
      if (timer || stopped) return false;
      lastSnapshot = snapshot();
      log.info(
        `账号后台探活已启用：每 ${Math.round(intervalMs / 1000)}s 复检一个停用/冷却中的账号` +
          '（只复检不可用的号，不占正常流量、不消耗消息额度）',
      );
      schedule();
      return true;
    },

    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },

    /** 手动跑一轮（控制台「立即复检」用） */
    async probeNow() {
      if (!supported()) return { ok: false, detail: '当前引擎不支持探活' };
      const candidates = engine.pool.probeCandidates({ includeHealthy: true });
      if (!candidates.length) return { ok: true, probed: 0, detail: '没有可探活的账号' };
      const results = [];
      for (const account of candidates) {
        probes += 1;
        results.push({ index: account.index + 1, ...(await engine.probe(account)) });
      }
      reportChanges();
      return { ok: results.every((r) => r.ok), probed: results.length, results };
    },

    status() {
      return {
        enabled: Boolean(timer),
        supported: supported(),
        intervalMs,
        rounds,
        probes,
        recoveries,
        accounts: supported()
          ? engine.pool.accounts.map((a) => ({
              index: a.index + 1,
              authFailed: a.authFailed,
              probing: a.probing,
              lastProbeAt: a.lastProbeAt || null,
              probeFailures: a.probeFailures,
              recovered: a.recovered,
            }))
          : [],
      };
    },
  };
}
