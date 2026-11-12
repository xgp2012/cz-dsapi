import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { ApiError } from '../errors.mjs';
import { escapeHtml, readJsonBody, requireApiKey, sendHtml, sendJson } from '../http.mjs';
import { loadTokens, maskToken, normalizeUserToken, saveTokens } from '../auth.mjs';
import { createEngine } from '../engine.mjs';
import { modelsResponse } from '../openai/response.mjs';
import { SETTINGS_FILENAME, loadSettings, saveSettings, settingsWritable } from '../settings-store.mjs';

/**
 * 后台管理接口 + 静态页面托管。
 *
 * 设计目标：把所有「要开终端敲命令」的日常操作搬到网页上——
 * 看状态、换 token（号池）、校验登录态、试调用、看日志、改配置、重启。
 *
 * 安全边界：
 * - 静态页面本身不敏感，可以公开；
 * - /admin/api/* 在配置了 API_KEY 时要求同样的 key，否则只依赖 HOST 是回环地址
 *   （和服务本体的鉴权策略一致，默认 127.0.0.1 只监听本机）。
 */

/**
 * 判断当前进程是**怎么跑起来的**，决定「重启」走哪条路径。
 *
 * 三种形态的启动入口完全不同：
 *
 *   'source'    源码运行（`npm start` / `node src/index.mjs`）
 *               → execPath 是 node，可以带脚本参数，交给 scripts/server-ctl.mjs
 *   'packaged'  打包而成的单 exe（Node SEA）
 *               → execPath 是 cz-dsapi.exe，不接受脚本参数，只能重新拉起自己
 *   'docker'    容器里（`node src/index.mjs` 作为 1 号进程）
 *               → execPath 也是 node，**但绝不能走 server-ctl**
 *
 * 为什么容器必须单独判：`scripts/server-ctl.mjs` 是为源码运行写的，
 * 在容器里每一环都不成立 ——
 *   - `down` 会 SIGTERM 掉 **1 号进程**（容器主进程），容器当场退出，
 *     `up` 那段根本没机会执行，Docker 只会看到一个"无故退出"的容器；
 *   - `listenerPids()` / `supervisorOf()` 依赖 `pgrep` / `ps`，slim 镜像里没有；
 *   - `restart` 的语义是"交给外部重新拉起"，而容器里没有外部 ——
 *     PID 1 死了就是死了。
 * 所以容器里沿用 packaged 的路径：自己 spawn 一个新进程，再优雅退出。
 *
 * 容器判定同时接受两个信号（任一成立即可），避免漏判：
 *   - `/.dockerenv` 存在（Docker 官方行为，最直接）
 *   - `CZDSAPI_DOCKER=1`（镜像里显式设置，给非标准运行时兜底）
 */
export function detectRuntimeMode({ execPath = process.execPath, env = process.env, existsSync = fs.existsSync } = {}) {
  // 打包 exe：execPath 不再是 node。
  // CZDSAPI_ROOT 是打包入口显式设置的（SEA 里 import.meta.dirname 不可用），最可靠。
  if (env.CZDSAPI_ROOT) return 'packaged';
  if (!/node(\.exe)?$/i.test(path.basename(execPath))) return 'packaged';

  // 容器：必须在"看起来像源码运行"之前判断，否则会去调根本不存在的 server-ctl
  if (env.CZDSAPI_DOCKER === '1') return 'docker';
  try {
    if (existsSync('/.dockerenv')) return 'docker';
  } catch {
    /* 权限问题之类，当作不是 */
  }

  return 'source';
}

/**
 * 允许在后台里修改的配置项（保存到 data/settings.json，重启后生效）。
 *
 * 覆盖原则：**凡是用户有理由调的都放进来**，只排除两类——
 *
 *   1. 路径/环境类（POW_BIN、CHROMIUM_EXECUTABLE、CZDSAPI_ROOT、DATA_DIR）：
 *      网页上改成不存在的路径只会让服务下次启动直接失败，
 *      而且这类值天然属于"部署时决定"，该由环境变量管。
 *   2. 令牌类（DEEPSEEK_USER_TOKEN*）：有独立的「账号」页专门管理，不在这里重复。
 *
 * 顺序按「最常调 → 最少调」排，因为页面是按这个顺序渲染的。
 */
const ENV_SCHEMA = [
  { key: 'ENGINE', group: '基础', label: '引擎', type: 'select', options: ['direct', 'auto', 'browser'], help: 'direct 直连最快；browser 用 Playwright 驱动真实网页' },
  { key: 'DEEPSEEK_THINKING', group: '基础', label: '深度思考', type: 'select', options: ['always', 'auto', 'never'], help: 'always 默认打开；请求里传 thinking:false 可单次关闭' },
  { key: 'DEEPSEEK_SEARCH', group: '基础', label: '智能搜索', type: 'boolean', help: '让网页版默认打开「智能搜索」' },
  { key: 'DEFAULT_MODEL', group: '基础', label: '默认模型名', type: 'text', help: '请求没写 model 时使用的名字' },
  { key: 'LOG_LEVEL', group: '基础', label: '日志级别', type: 'select', options: ['error', 'warn', 'info', 'debug', 'trace'] },
  { key: 'CONCURRENCY', group: '运行与并发', label: '并发数', type: 'number', min: 1, max: 64 },
  { key: 'QUEUE_LIMIT', group: '运行与并发', label: '排队上限', type: 'number', min: 1, max: 4096 },
  { key: 'REQUEST_TIMEOUT_MS', group: '运行与并发', label: '单次超时（毫秒）', type: 'number', min: 1000 },
  { key: 'FIRST_TOKEN_TIMEOUT_MS', group: '运行与并发', label: '首字超时（毫秒）', type: 'number', min: 1000 },
  { key: 'MAX_PROMPT_CHARS', group: '长上下文', label: '输入框上限（字符）', type: 'number', min: 1000 },
  { key: 'MAX_ATTACHMENT_CHARS', group: '长上下文', label: '附件上限（字符）', type: 'number', min: 1000 },
  { key: 'OVERFLOW_TO_ATTACHMENT', group: '长上下文', label: '超长转附件', type: 'boolean', help: '关掉后超长上下文直接返回 413' },
  { key: 'WARMUP', group: '其它', label: '启动时预热', type: 'boolean' },
  { key: 'SAVE_ARTIFACTS', group: '其它', label: '保存调试产物', type: 'boolean' },
  { key: 'ACCOUNT_COOLDOWN_MS', group: '号池与限流', label: '限流冷却（毫秒）', type: 'number', min: 1000 },
  { key: 'HOST', group: '服务与鉴权', label: '监听地址', type: 'text', help: '改完重启才生效，建议保持 127.0.0.1' },
  { key: 'PORT', group: '服务与鉴权', label: '监听端口', type: 'number', min: 1, max: 65535, help: '改完重启才生效' },
  { key: 'API_KEY', group: '服务与鉴权', label: 'API Key', type: 'password', help: '设置后 API 和后台接口都会要求鉴权，留空表示不鉴权' },
  {
    key: 'ACCOUNT_PROBE_INTERVAL_MS',
    group: '号池与限流',
    label: '账号探活间隔（毫秒）',
    type: 'number',
    min: 60000,
    help: '每隔多久复检一个停用/冷却中的账号；探活通过就自动恢复。0 = 关闭',
  },

  /* ------------------------ 号池与限流 ------------------------ */
  { key: 'MAX_INFLIGHT_PER_ACCOUNT', group: '号池与限流', label: '单号并发上限', type: 'number', min: 0, help: '0 = 不限（纯轮询）；多号时把并发摊开，避免全压一个号撞风控' },
  { key: 'MAX_COOLDOWN_WAIT_MS', group: '号池与限流', label: '冷却最长等待（毫秒）', type: 'number', min: 0, help: '超过就直接返回 429，不再等' },
  { key: 'RATE_LIMIT_ENABLED', group: '号池与限流', label: '入口限流', type: 'boolean', help: '按客户端 IP 的令牌桶，流量还没打到上游就先挡' },
  { key: 'RATE_LIMIT_PER_MINUTE', group: '号池与限流', label: '限流突发数（每分钟）', type: 'number', min: 1 },
  { key: 'RATE_LIMIT_REFILL_PER_SEC', group: '号池与限流', label: '限流补充速率（每秒）', type: 'number', min: 0 },
  { key: 'RATE_LIMIT_MAX_BUCKETS', group: '号池与限流', label: '限流桶上限', type: 'number', min: 1, help: '限制内存里保留多少个客户端 IP 的桶' },
  { key: 'TRUST_PROXY', group: '服务与鉴权', label: '信任代理头', type: 'text', help: '反代场景填 loopback；留空则只认 socket 地址（伪造 XFF 无效）' },
  { key: 'CORS_ORIGIN', group: '服务与鉴权', label: '允许跨域来源', type: 'text', help: '* 适合大多数 SDK；收紧成具体域名更安全' },

  /* ------------------------ 发送与节奏 ------------------------ */
  { key: 'SEND_INTERVAL_MS', group: '运行与并发', label: '发送间隔（毫秒）', type: 'number', min: 0, help: '浏览器引擎的账号级限流，太密会触发「发送过于频繁」' },
  { key: 'DIRECT_SEND_INTERVAL_MS', group: '运行与并发', label: '直连发送间隔（毫秒）', type: 'number', min: 0, help: '直连不做间隔，靠号池绕限流' },
  { key: 'POLL_INTERVAL_MS', group: '运行与并发', label: '轮询间隔（毫秒）', type: 'number', min: 10 },
  { key: 'SETTLE_MS', group: '运行与并发', label: '结束判定稳定期（毫秒）', type: 'number', min: 0, help: '文本稳定多久算生成结束' },
  { key: 'REASONING_HOLD_MS', group: '运行与并发', label: '思考内容保持（毫秒）', type: 'number', min: 0, help: '保证 reasoning 一定排在 content 前面' },
  { key: 'RATE_LIMIT_BACKOFF_MS', group: '运行与并发', label: '限流退避（毫秒）', type: 'number', min: 0 },
  { key: 'IDLE_SHUTDOWN_MS', group: '运行与并发', label: '空闲关闭浏览器（毫秒）', type: 'number', min: 0, help: '0 = 不关闭' },
  { key: 'SHUTDOWN_TIMEOUT_MS', group: '运行与并发', label: '关闭超时（毫秒）', type: 'number', min: 1000, help: '容器默认 stop 宽限 10s，建议保持小于它' },
  { key: 'POW_WORKERS', group: '号池与限流', label: 'PoW 并行度', type: 'number', min: 0, help: '0 = 用 CPU 核数；高并发时可调小避免抢核' },

  /* ------------------------ 直连特征伪装 ------------------------ */
  { key: 'DEEPSEEK_BASE_URL', group: '直连特征', label: '上游地址', type: 'text', help: '一般不需要改' },
  { key: 'DEEPSEEK_DEVICE_PROFILE', group: '直连特征', label: '设备画像', type: 'select', options: ['chrome-win', 'chrome-android'], help: '选定后请长期固定，来回切换会被识别成设备漂移' },
  { key: 'DEEPSEEK_COLD_START', group: '直连特征', label: '冷启动序列', type: 'boolean', help: '启动时先拉配置、校验设备，让账号有「网页打开过」的痕迹' },
  { key: 'DEEPSEEK_HUMAN_TIMING', group: '直连特征', label: '行为时序伪装', type: 'boolean', help: '把 PoW 耗时补到接近真浏览器，并在发送前随机停顿' },
  { key: 'DEEPSEEK_MANAGE_TOGGLES', group: '直连特征', label: '主动拨动开关', type: 'boolean', help: '按请求要求把网页上的深度思考/智能搜索拨到对应状态' },

  /* ------------------------ 浏览器引擎 ------------------------ */
  { key: 'BROWSER_HEADLESS', group: '浏览器引擎', label: '无头模式', type: 'boolean' },
  { key: 'BROWSER_USER_AGENT', group: '浏览器引擎', label: '浏览器 UA', type: 'text' },
  { key: 'BROWSER_WIDTH', group: '浏览器引擎', label: '窗口宽', type: 'number', min: 200 },
  { key: 'BROWSER_HEIGHT', group: '浏览器引擎', label: '窗口高', type: 'number', min: 200 },
  { key: 'BROWSER_LOCALE', group: '浏览器引擎', label: '语言', type: 'text' },
  { key: 'BROWSER_SLOW_MO', group: '浏览器引擎', label: '操作减速（毫秒）', type: 'number', min: 0, help: '调试用，每步操作的人为延迟' },
  { key: 'BROWSER_NAV_TIMEOUT_MS', group: '浏览器引擎', label: '页面导航超时（毫秒）', type: 'number', min: 1000 },
  { key: 'BROWSER_ARGS', group: '浏览器引擎', label: '额外启动参数', type: 'text', help: '空格分隔，如 --proxy-server=http://127.0.0.1:7890' },
  { key: 'BROWSER_CAPTURE', group: '浏览器引擎', label: '抓取原始流', type: 'boolean', help: '用模型原始输出当权威文本；关掉退回纯 DOM 提取（可能丢工具调用）' },
  { key: 'BROWSER_CAPTURE_WAIT_MS', group: '浏览器引擎', label: '原始流收尾等待（毫秒）', type: 'number', min: 0 },
];

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const MAX_TOKENS_PER_REQUEST = 32;

export function createAdminHandler({ config, logger, web, server }) {
  const log = logger.child('admin');
  const rootDir = config.rootDir;
  const distDir = path.join(rootDir, 'web', 'dist');
  const envFile = path.join(rootDir, '.env');
  const authFile = config.authFile;
  const serverLog = path.join(config.dataDir, 'server.log');
  const ctlScript = path.join(rootDir, 'scripts', 'server-ctl.mjs');

  /** 同一时间只跑一批 token 校验，避免把账号打爆 */
  let verifying = false;
  /** 同一时间只跑一批号池复检（探活），理由同上 */
  let probeRunning = false;

  /** @returns {Promise<boolean>} 是否已经处理（false 交给上层 404） */
  return async function handleAdmin(req, res, url) {
    if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return false;

    if (url.pathname === '/admin') {
      res.writeHead(301, { Location: '/admin/' });
      res.end();
      return true;
    }

    if (url.pathname.startsWith('/admin/api/')) {
      requireApiKey(req, config, { message: '需要 API Key' });
      try {
        await handleApi(req, res, url);
      } catch (err) {
        const apiError = err instanceof ApiError ? err : new ApiError(500, err.message);
        if (!(err instanceof ApiError)) log.error('后台接口失败:', err);
        sendJson(res, apiError.status, { error: { message: apiError.message, status: apiError.status } });
      }
      return true;
    }

    serveStatic(req, res, url);
    return true;
  };

  /* ------------------------------------------------------------------ *
   * API
   * ------------------------------------------------------------------ */

  async function handleApi(req, res, url) {
    const route = `${req.method} ${url.pathname}`;

    if (route === 'GET /admin/api/overview') {
      return sendJson(res, 200, buildOverview());
    }

    if (route === 'GET /admin/api/accounts') {
      return sendJson(res, 200, buildAccounts());
    }

    if (route === 'POST /admin/api/accounts/verify') {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      return sendJson(res, 200, await verifyTokens(body.tokens));
    }

    /**
     * 立即复检运行中的号池（不创建新引擎，直接用当前进程里的账号）。
     * 和 accounts/verify 的区别：那个校验的是「你刚粘进来的 token」，
     * 这个复检的是「进程里正跑着的账号」，用来验证自动恢复有没有生效。
     */
    if (route === 'POST /admin/api/accounts/probe') {
      if (probeRunning) throw new ApiError(409, '已有复检任务在进行，请稍后再试');
      probeRunning = true;
      try {
        const startedAt = Date.now();
        const results = [];
        const candidates = web.pool?.probeCandidates?.({ includeHealthy: true }) ?? [];
        for (const account of candidates) {
          results.push({ index: account.index + 1, ...(await web.probe(account)) });
        }
        return sendJson(res, 200, {
          ok: results.every((r) => r.ok),
          probed: results.length,
          ms: Date.now() - startedAt,
          results,
          message: results.length
            ? undefined
            : '当前引擎不支持账号复检（只有直连引擎有多账号号池）',
        });
      } finally {
        probeRunning = false;
      }
    }

    if (route === 'POST /admin/api/accounts') {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      return sendJson(res, 200, saveAccounts(body));
    }

    if (route === 'POST /admin/api/accounts/remove') {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      return sendJson(res, 200, removeAccount(body));
    }

    if (route === 'GET /admin/api/config') {
      return sendJson(res, 200, buildConfig());
    }

    if (route === 'PUT /admin/api/config') {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      return sendJson(res, 200, saveConfig(body));
    }

    if (route === 'GET /admin/api/logs') {
      const lines = clampInt(url.searchParams.get('lines'), 50, 5000, 300);
      return sendJson(res, 200, readLogTail(lines));
    }

    if (route === 'POST /admin/api/restart') {
      return sendJson(res, 200, await restartServer());
    }

    throw new ApiError(404, `未知接口: ${route}`, { code: 'not_found' });
  }

  function buildOverview() {
    const status = web.status();
    const saved = loadTokens(config);
    const models = modelsResponse(config).data.map((m) => m.id);
    return {
      ok: true,
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      now: new Date().toISOString(),
      ...status,
      models,
      savedTokens: saved.map(maskToken),
      savedCount: saved.length,
      config: {
        host: config.server.host,
        port: config.server.port,
        engine: config.engine,
        thinking: config.deepseek.thinking,
        search: config.deepseek.search,
        concurrency: config.runtime.concurrency,
        queueLimit: config.runtime.queueLimit,
        requestTimeoutMs: config.runtime.requestTimeoutMs,
        maxPromptChars: config.runtime.maxPromptChars,
        overflowToAttachment: config.runtime.overflowToAttachment,
        warmup: config.runtime.warmup,
        logLevel: config.logLevel,
        apiKeySet: Boolean(config.server.apiKey),
        deviceProfile: config.deepseek.deviceProfile,
        powBin: config.direct.powBin,
      },
      files: {
        authFile,
        logFile: serverLog,
        envFile,
        dataDir: config.dataDir,
        distDir,
        distBuilt: fs.existsSync(path.join(distDir, 'index.html')),
      },
      node: process.version,
    };
  }

  function buildAccounts() {
    const status = web.status();
    const saved = loadTokens(config);
    let savedAt = null;
    try {
      savedAt = JSON.parse(fs.readFileSync(authFile, 'utf8')).savedAt ?? null;
    } catch {
      savedAt = null;
    }
    return {
      runtime: status.accounts ?? [],
      poolSize: status.accounts?.length ?? 0,
      saved: saved.map((token, index) => ({ index: index + 1, token: maskToken(token) })),
      savedAt,
      authFile,
      engine: status.engine,
      token: status.token,
      probeIntervalMs: config.runtime.accountProbeIntervalMs ?? 0,
      // 有几个号正躺在「停用/冷却」里，控制台可以据此提示"可点立即复检"
      needsProbe: (status.accounts ?? []).filter((a) => a.authFailed || !a.available).length,
    };
  }

  function parseTokenInput(input) {
    const list = Array.isArray(input)
      ? input
      : String(input ?? '')
          .split(/[\s,;]+/)
          .filter(Boolean);
    if (!list.length) throw new ApiError(400, '没有提供 token');
    if (list.length > MAX_TOKENS_PER_REQUEST) {
      throw new ApiError(400, `一次最多提交 ${MAX_TOKENS_PER_REQUEST} 个 token`);
    }
    return list.map((raw, index) => {
      try {
        return normalizeUserToken(String(raw));
      } catch (err) {
        throw new ApiError(400, `第 ${index + 1} 个 token 不合法：${err.message}`);
      }
    });
  }

  function saveAccounts(body) {
    const tokens = parseTokenInput(body?.tokens);
    const mode = body?.mode === 'append' ? 'append' : 'replace';
    const existing = mode === 'append' ? loadTokens(config) : [];
    const merged = [...new Set([...existing, ...tokens])];
    saveTokens(config, merged);
    log.info(`号池已更新：${merged.length} 个 token（${mode}）`);
    return {
      ok: true,
      mode,
      savedCount: merged.length,
      tokens: merged.map(maskToken),
      authFile,
      restartRequired: true,
      message: '已写入 data/auth.json。运行中的进程仍在使用旧号池，重启服务后生效。',
    };
  }

  function removeAccount(body) {
    const index = Number.parseInt(body?.index, 10);
    const tokens = loadTokens(config);
    if (!Number.isFinite(index) || index < 1 || index > tokens.length) {
      throw new ApiError(400, `要删除的序号不合法：${body?.index}`);
    }
    const removed = tokens.splice(index - 1, 1);
    if (!tokens.length) {
      throw new ApiError(400, '这是最后一个 token，删掉后号池就空了。可用「替换全部」写入新 token。');
    }
    saveTokens(config, tokens);
    log.info(`已删除号池第 ${index} 个 token`);
    return {
      ok: true,
      removed: removed.map(maskToken),
      savedCount: tokens.length,
      restartRequired: true,
      message: '已从 data/auth.json 删除，重启服务后生效。',
    };
  }

  async function verifyTokens(rawTokens) {
    const tokens = parseTokenInput(rawTokens);
    if (verifying) throw new ApiError(409, '已有校验任务在进行，请稍后再试');
    verifying = true;
    const results = [];
    try {
      for (const token of tokens) {
        results.push({ token: maskToken(token), ...(await verifyOne(token)) });
      }
    } finally {
      verifying = false;
    }
    return { ok: results.every((r) => r.ok), results };
  }

  async function verifyOne(token) {
    let engine;
    const startedAt = Date.now();
    try {
      // 用同一个引擎实现校验：能走 checkLogin 就走，否则发一条最短的消息
      engine = createEngine({
        config: {
          ...config,
          deepseek: { ...config.deepseek, tokens: [token], token },
        },
        logger: logger.child('verify'),
      });
      if (typeof engine.checkLogin === 'function') {
        const login = await engine.checkLogin();
        return {
          ok: Boolean(login.ok),
          detail: login.ok ? '登录态有效' : login.captcha ? '遇到人机验证' : 'token 无效或已过期',
          ms: Date.now() - startedAt,
        };
      }
      const result = await engine.chat({
        prompt: '# Messages:\n## System:\n你是校验程序。\n## User:\n只回复两个字：正常',
        thinking: false,
      });
      return {
        ok: true,
        detail: `调用成功，返回：${String(result.text ?? '').slice(0, 20)}`,
        ms: Date.now() - startedAt,
      };
    } catch (err) {
      if (err?.code === 'deepseek_rate_limited') {
        return { ok: true, detail: '账号被限流，token 本身可能有效', ms: Date.now() - startedAt };
      }
      return { ok: false, detail: err.message, ms: Date.now() - startedAt };
    } finally {
      await engine?.close?.().catch(() => {});
    }
  }

  /**
   * 配置页数据。
   *
   * 取值顺序要与 config.mjs 的优先级一致：网页设置 > 环境变量 > .env > 默认。
   * 这里 currentEffective() 已经是「进程内实际生效值」—— 而进程内的值
   * 就是 config.mjs 按上述优先级算出来的，所以直接用它做回退即可。
   * 优先显示 settings.json 里的值（用户显式保存过的），语义上最接近「我设的」。
   */
  function buildConfig() {
    const saved = loadSettings(config.settingsFile);
    const values = {};
    for (const item of ENV_SCHEMA) {
      const current = saved.values[item.key] ?? currentEffective(item.key);
      values[item.key] = current === undefined || current === null ? '' : String(current);
    }
    const writable = settingsWritable(config.settingsFile);
    return {
      // 兼容旧字段名：前端和历史调用方还在读 envFile
      envFile: config.settingsFile,
      settingsFile: config.settingsFile,
      exists: fs.existsSync(config.settingsFile),
      // 配置目录不可写时前端禁用表单并说明原因，而不是让用户点保存才吃到 409
      writable,
      writableHint: writable
        ? null
        : `配置目录不可写：${path.dirname(config.settingsFile)}。容器里请确认已挂载数据卷 -v cz-dsapi-data:/app/data`,
      runtimeMode: detectRuntimeMode(),
      // 设置文件损坏时提醒用户（此时会静默回落到环境变量，不说会让人困惑）
      broken: saved.broken,
      schema: ENV_SCHEMA,
      values,
      restartKeys: [
        'ENGINE',
        'HOST',
        'PORT',
        'API_KEY',
        'CONCURRENCY',
        'MAX_PROMPT_CHARS',
        'DEEPSEEK_THINKING',
        'DEEPSEEK_SEARCH',
        'LOG_LEVEL',
        'ACCOUNT_PROBE_INTERVAL_MS',
      ],
      note: writable
        ? `修改会保存到 ${SETTINGS_FILENAME}（数据目录），重启服务后生效。`
        : `配置目录不可写，无法保存。容器里请确认已挂载数据卷。`,
    };
  }

  /**
   * 保存网页设置。
   *
   * 写入 data/settings.json（**不再写 .env**），原因见 settings-store.mjs 顶部：
   * .env 在容器里既写不进去，就算写进去了也会被环境变量盖住 —— 静默失效。
   *
   * 合并而非覆盖：只写本次提交的项，其余已有设置保留。
   * 显式清空（值为空串）则从文件里删掉该键，回落到环境变量 / 默认值 ——
   * 否则用户永远没法「恢复默认」，只能手改文件。
   */
  function saveConfig(body) {
    const incoming = body?.values;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      throw new ApiError(400, 'values 必须是对象');
    }

    const target = config.settingsFile;
    if (!settingsWritable(target)) {
      throw new ApiError(
        409,
        `配置目录不可写：${path.dirname(target)}\n` +
          '容器里请确认已挂载可写的数据卷：-v cz-dsapi-data:/app/data',
        { code: 'settings_not_writable' },
      );
    }

    const updates = {};
    for (const item of ENV_SCHEMA) {
      if (!(item.key in incoming)) continue;
      const raw = incoming[item.key];

      // API_KEY 在页面上是掩码显示（见 currentEffective 的 '••••••••'）。
      // 用户只改别的项时，浏览器会把掩码原样提交回来 —— 若当成真值存下去，
      // 重启后鉴权 KEY 就变成了那串圆点，而用户完全不知道发生了什么。
      // 这里识别掩码并跳过：语义是「没改」，不是「清空」。
      if (item.type === 'password' && typeof raw === 'string' && /^[•*]+$/.test(raw.trim())) {
        continue;
      }

      const value = validateEnvValue(item, raw);
      updates[item.key] = value;
    }
    if (!Object.keys(updates).length) {
      return { ok: true, saved: [], settingsFile: target, restartRequired: false, message: '没有需要保存的改动。' };
    }

    const current = loadSettings(target).values;
    const next = { ...current };
    for (const [k, v] of Object.entries(updates)) {
      // 空串 = 恢复默认（交还给环境变量 / 内置默认值）
      if (v === '') delete next[k];
      else next[k] = v;
    }

    try {
      saveSettings(target, next);
    } catch (err) {
      throw new ApiError(409, `写入 ${SETTINGS_FILENAME} 失败：${err.message}`, {
        code: 'settings_write_failed',
      });
    }

    log.info('配置已写入 settings.json', { keys: Object.keys(updates), file: target });
    return {
      ok: true,
      saved: Object.keys(updates),
      settingsFile: target,
      restartRequired: true,
      message: '已保存，重启服务后生效。',
    };
  }

  function validateEnvValue(item, raw) {
    const value = raw === undefined || raw === null ? '' : String(raw).trim();
    if (item.type === 'boolean') {
      if (!['true', 'false', ''].includes(value)) {
        throw new ApiError(400, `${item.key} 只能是 true / false`);
      }
      return value === '' ? 'false' : value;
    }
    if (item.type === 'number') {
      if (value === '') return '';
      const n = Number(value);
      if (!Number.isFinite(n)) throw new ApiError(400, `${item.key} 必须是数字`);
      if (item.min !== undefined && n < item.min) throw new ApiError(400, `${item.key} 不能小于 ${item.min}`);
      if (item.max !== undefined && n > item.max) throw new ApiError(400, `${item.key} 不能大于 ${item.max}`);
      return String(Math.trunc(n));
    }
    if (item.type === 'select') {
      if (!item.options.includes(value)) {
        throw new ApiError(400, `${item.key} 只能是 ${item.options.join(' / ')}`);
      }
      return value;
    }
    if (/[\r\n]/.test(value)) throw new ApiError(400, `${item.key} 不能包含换行`);
    return value;
  }

  /**
   * 当前进程里生效的值（由 config.mjs 按 网页设置 > 环境变量 > 默认 算出来的结果）。
   *
   * 必须覆盖 ENV_SCHEMA 的**全部**键：漏一个，那一项在页面上就显示成空白，
   * 用户会以为没设置过，保存时还可能被空串覆盖回去。
   * test/admin-settings.test.mjs 里有一条断言专门守这个一致性。
   */
  function currentEffective(key) {
    const b = (v) => String(v);
    const mapping = {
      /* 引擎与模型 */
      ENGINE: config.engine,
      DEEPSEEK_THINKING: config.deepseek.thinking,
      DEEPSEEK_SEARCH: b(config.deepseek.search),
      DEFAULT_MODEL: config.deepseek.defaultModel,
      DEEPSEEK_BASE_URL: config.deepseek.baseUrl,
      DEEPSEEK_DEVICE_PROFILE: config.deepseek.deviceProfile,
      DEEPSEEK_COLD_START: b(config.deepseek.coldStart),
      DEEPSEEK_HUMAN_TIMING: b(config.deepseek.humanTiming),
      DEEPSEEK_MANAGE_TOGGLES: b(config.deepseek.manageToggles),

      /* 服务与鉴权 */
      HOST: config.server.host,
      PORT: b(config.server.port),
      API_KEY: config.server.apiKey ? '••••••••' : '',
      CORS_ORIGIN: config.server.cors,
      TRUST_PROXY: config.server.trustProxy,
      LOG_LEVEL: config.logLevel,

      /* 限流 */
      RATE_LIMIT_ENABLED: b(config.server.rateLimit.enabled),
      RATE_LIMIT_PER_MINUTE: b(config.server.rateLimit.capacity),
      RATE_LIMIT_REFILL_PER_SEC: b(config.server.rateLimit.refillPerSec),
      RATE_LIMIT_MAX_BUCKETS: b(config.server.rateLimit.maxBuckets),

      /* 号池 */
      MAX_INFLIGHT_PER_ACCOUNT: b(config.direct.maxInflightPerAccount),
      MAX_COOLDOWN_WAIT_MS: b(config.runtime.maxCooldownWaitMs),
      ACCOUNT_COOLDOWN_MS: b(config.runtime.accountCooldownMs),
      ACCOUNT_PROBE_INTERVAL_MS: b(config.runtime.accountProbeIntervalMs ?? 0),
      POW_WORKERS: b(config.direct.powWorkers),

      /* 运行与节奏 */
      CONCURRENCY: b(config.runtime.concurrency),
      QUEUE_LIMIT: b(config.runtime.queueLimit),
      REQUEST_TIMEOUT_MS: b(config.runtime.requestTimeoutMs),
      FIRST_TOKEN_TIMEOUT_MS: b(config.runtime.firstTokenTimeoutMs),
      SEND_INTERVAL_MS: b(config.runtime.sendIntervalMs),
      DIRECT_SEND_INTERVAL_MS: b(config.runtime.directSendIntervalMs),
      POLL_INTERVAL_MS: b(config.runtime.pollIntervalMs),
      SETTLE_MS: b(config.runtime.settleMs),
      REASONING_HOLD_MS: b(config.runtime.reasoningHoldMs),
      RATE_LIMIT_BACKOFF_MS: b(config.runtime.rateLimitBackoffMs),
      IDLE_SHUTDOWN_MS: b(config.runtime.idleShutdownMs),
      SHUTDOWN_TIMEOUT_MS: b(config.runtime.shutdownTimeoutMs),

      /* 长上下文 */
      MAX_PROMPT_CHARS: b(config.runtime.maxPromptChars),
      MAX_ATTACHMENT_CHARS: b(config.runtime.maxAttachmentChars),
      OVERFLOW_TO_ATTACHMENT: b(config.runtime.overflowToAttachment),

      /* 开关 */
      WARMUP: b(config.runtime.warmup),
      SAVE_ARTIFACTS: b(config.runtime.saveArtifacts),

      /* 浏览器引擎 */
      BROWSER_HEADLESS: b(config.browser.headless),
      BROWSER_USER_AGENT: config.browser.userAgent,
      BROWSER_WIDTH: b(config.browser.viewport.width),
      BROWSER_HEIGHT: b(config.browser.viewport.height),
      BROWSER_LOCALE: config.browser.locale,
      BROWSER_SLOW_MO: b(config.browser.slowMo),
      BROWSER_NAV_TIMEOUT_MS: b(config.browser.navigationTimeoutMs),
      // 数组还原成命令行形式，否则页面上会显示成 "a,b"
      BROWSER_ARGS: (config.browser.launchArgs || []).join(' '),
      BROWSER_CAPTURE: b(config.runtime.browserCapture),
      BROWSER_CAPTURE_WAIT_MS: b(config.runtime.browserCaptureWaitMs),
    };
    return mapping[key];
  }

  function readLogTail(lines) {
    let text = '';
    try {
      const stat = fs.statSync(serverLog);
      const length = Math.min(stat.size, 512 * 1024);
      const fd = fs.openSync(serverLog, 'r');
      try {
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, Math.max(0, stat.size - length));
        text = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { file: serverLog, exists: false, lines: [], size: 0 };
    }
    const all = text.split(/\r?\n/);
    const tail = all.slice(Math.max(0, all.length - lines - 1), -1);
    return { file: serverLog, exists: true, lines: tail, size: text.length };
  }

  /**
   * 重启服务。
   *
   * 三种运行形态必须分开处理 —— 它们连"去哪里找启动入口"都不一样：
   *
   *   源码运行：交给 scripts/server-ctl.mjs（down→up，带 pid 文件、pgrep 兜底、
   *             pm2/systemd 检测）。这些工具都是 Unix 风格的，且 process.execPath
   *             是 node，可以带脚本参数。
   *
   *   打包 exe：process.execPath 是 cz-dsapi.exe，**不接受脚本参数**，也没有 pgrep/ps，
   *             SIGTERM 在 Windows 上也不可靠。所以自己实现：detached 拉起一个新的
   *             exe（继承环境变量，cwd 设为项目根），等它起来后再退出本进程。
   *
   *   Docker  ：也是自己拉起自己，和打包 exe 同一条路径 ——
   *             容器里没有 pgrep/ps，且 1 号进程一死容器就退出，绝对不能交给 server-ctl
   *             （详见 detectRuntimeMode 的注释）。
   */
  async function restartServer() {
    const mode = detectRuntimeMode();

    if (mode === 'packaged' || mode === 'docker') {
      return restartSelf(mode);
    }

    if (!fs.existsSync(ctlScript)) {
      throw new ApiError(
        500,
        `找不到重启脚本：${ctlScript}\n` +
          '如果你是从源码运行，请确认 scripts/server-ctl.mjs 存在；' +
          '如果是打包版，这个文件不需要（会直接重启可执行文件）。',
      );
    }
    const child = spawn(process.execPath, [ctlScript, 'restart'], {
      cwd: rootDir,
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    log.info('收到后台重启请求，已交给 server-ctl restart', { pid: child.pid });
    return {
      ok: true,
      message: '正在重启服务，页面会自动重连…',
      pid: child.pid,
    };
  }

  /**
   * 自己重启自己：打包 exe 与 Docker 容器共用。
   *
   * 步骤：
   *   1. detached 启动一个新进程，cwd/rootDir 不变，环境变量原样继承；
   *   2. 关掉自己的 HTTP server 释放端口，然后走优雅退出。
   *
   * 两种形态的启动命令不同，但**都不能带脚本参数**：
   *   - packaged：exe 是 Node SEA，"可执行文件 + 无参数"就是完整启动命令
   *     （传 src/index.mjs 会被 SEA 当成用户参数）；
   *   - docker  ：镜像的 CMD 就是 `node src/index.mjs`，execPath 是 node，
   *     所以要显式补上 index.mjs，否则 node 会打开 REPL 并立刻退出。
   *
   * 注意：容器里 1 号进程退出 = 容器退出。新进程是**子进程**，旧进程退出后
   * 它会被 tini 收养（tini 是镜像的 ENTRYPOINT，负责转发信号与回收子进程），
   * 所以必须用 tini 而不是让 node 直接当 1 号来跑 —— 这也是镜像里为什么装 tini。
   */
  async function restartSelf(mode) {
    const exe = process.execPath;
    const args = mode === 'docker' ? [path.join(rootDir, 'src', 'index.mjs')] : [];

    log.info(
      mode === 'docker'
        ? '收到后台重启请求（Docker），将重新拉起 node src/index.mjs'
        : '收到后台重启请求（打包版），将直接重启可执行文件',
      { exe, args },
    );

    // 延迟动作，让 sendJson 先把响应 flush 回浏览器
    setTimeout(() => {
      let child;
      try {
        child = spawn(exe, args, {
          cwd: rootDir,
          detached: true,
          stdio: 'ignore',
          env: process.env,
          windowsHide: true,
        });
      } catch (err) {
        log.error('重启失败：无法启动新进程', err.message);
        process.exit(1);
        return;
      }

      child.on('error', (err) => {
        log.error('重启失败：新进程启动出错', err.message);
        process.exit(1);
      });
      child.unref();
      log.info('新进程已启动，当前进程即将退出', { pid: child.pid });

      // 新进程启动后会短暂遇到 EADDRINUSE（旧端口还没释放），所以先 close 再退。
      // 退出走 SIGTERM 那套优雅关闭，好让 index.mjs 关掉浏览器和子进程 ——
      // 直接 process.exit() 会把 Playwright 的 Chromium 变成孤儿进程堆在后台。
      setTimeout(() => {
        try {
          server?.close?.();
        } catch {
          /* 已经关了 */
        }
        setTimeout(() => process.kill(process.pid, 'SIGTERM'), 150);
      }, 150);
    }, 120);

    return { ok: true, message: '正在重启服务，页面会自动重连…', pid: null };
  }

  /* ------------------------------------------------------------------ *
   * 静态页面
   * ------------------------------------------------------------------ */

  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const relative = decodeURIComponent(url.pathname.slice('/admin/'.length)) || 'index.html';
    const resolved = path.resolve(distDir, relative);
    const inside = resolved === distDir || resolved.startsWith(distDir + path.sep);
    const fallback = path.join(distDir, 'index.html');

    let stat = null;
    try {
      stat = inside ? fs.statSync(resolved) : null;
    } catch {
      stat = null;
    }
    let file = stat?.isFile() ? resolved : fallback;
    try {
      stat = fs.statSync(file);
    } catch {
      return sendHtml(res, 503, buildMissingPage());
    }
    if (!stat.isFile()) return sendHtml(res, 503, buildMissingPage());
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    // 流式发送：原来每次请求都把整个文件（主 JS 约 588KB）读进内存，
    // 并发访问后台时内存峰值随并发线性增长；流式只占一个小缓冲区。
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).on('error', () => {
      if (!res.headersSent) sendHtml(res, 503, buildMissingPage());
      else res.end();
    }).pipe(res);
  }
}

/* -------------------------------------------------------------------- *
 * 工具函数
 * -------------------------------------------------------------------- */



function clampInt(raw, min, max, fallback) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}



function buildMissingPage() {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<title>cz-dsapi 控制台尚未构建</title>
<style>body{font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;color:#1f2328}
pre{background:#f6f8fa;border:1px solid #e5e7eb;border-radius:8px;padding:14px;overflow:auto;font-size:13px}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}</style>
<h1>控制台还没构建</h1>
<p>后台前端在 <code>web/</code>（React + Vite + mdui），需要先构建一次：</p>
<pre>cd ${escapeHtml(process.cwd())}
npm --prefix web install
npm --prefix web run build</pre>
<p>构建产物输出到 <code>web/dist</code>，本页面会自动出现。开发时可另开一个终端跑 <code>npm --prefix web run dev</code>。</p>
</html>`;
}

