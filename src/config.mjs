import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { parseEnvText, resolveExecutable } from './util.mjs';
import { loadSettings, overlaySettings, settingsPath } from './settings-store.mjs';

/**
 * 项目根目录。
 *
 * 默认按源码位置推导（src/ 的上一级）。但 SEA 打包成 exe 后，`import.meta.dirname`
 * 不再是一个真实可用的目录（入口是内嵌的），所以打包入口会预先设置 CZDSAPI_ROOT
 * 为 exe 所在目录。这样 exe 与 src/ 同级放置时，.env / data / bin / web 都能照常找到。
 */
const ROOT = process.env.CZDSAPI_ROOT
  ? path.resolve(process.env.CZDSAPI_ROOT)
  : path.resolve(import.meta.dirname, '..');

/* ------------------------------------------------------------------ *
 * 极简 .env 加载（不引入 dotenv，减少依赖）
 * ------------------------------------------------------------------ */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const [key, value] of Object.entries(parseEnvText(fs.readFileSync(file, 'utf8')))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(path.join(ROOT, '.env'));

/**
 * 配置优先级：**网页设置 > 环境变量 > .env > 内置默认值**。
 *
 * .env 已经在上一步灌进 process.env，所以前三层在这里合成：
 *   process.env（含 compose 的 environment 与 .env）+ settings.json 的覆盖。
 *
 * 为什么让网页设置压过环境变量：
 * 用户要求「所有配置网页可改」。若环境变量优先，compose 里写过的键
 * 在网页上改了永远不生效，页面却显示「已保存」—— 这种静默失败比报错更糟。
 *
 * 注意顺序：settings.json 存放在 dataDir 里，而 dataDir 由 DATA_DIR 决定。
 * 先按「.env + 环境变量」算出 dataDir 的位置，再去读设置文件；
 * 不能反过来，否则 DATA_DIR 自己被网页改过时会读到错误路径。
 */

const bool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

const str = (value, fallback = '') => (value === undefined || value === null ? fallback : String(value).trim());

const float = (value, fallback) => {
  const n = Number.parseFloat(value ?? '');
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);

/* ------------------------------------------------------------------ *
 * 登录态：环境变量 > data/auth.json
 * ------------------------------------------------------------------ */
function readTokenFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = [];
    if (Array.isArray(parsed?.tokens)) list.push(...parsed.tokens);
    if (typeof parsed?.token === 'string') list.push(parsed.token);
    return list.map((t) => String(t).trim()).filter(Boolean);
  } catch {
    /* 文件不存在或损坏都忽略，交给调用方提示 */
  }
  return [];
}

function resolveTokens(env, authFile) {
  const fromEnv = [];
  for (const key of ['DEEPSEEK_USER_TOKENS', 'DEEPSEEK_USER_TOKEN']) {
    const raw = env[key];
    if (!raw) continue;
    fromEnv.push(
      ...String(raw)
        .split(/[\s,;]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    );
  }
  const list = fromEnv.length ? fromEnv : readTokenFile(authFile);
  return [...new Set(list)];
}

/**
 * 读取「网页设置」文件位置。
 *
 * 单独导出：admin 路由要用它做保存目标，诊断信息也要显示它到底在哪。
 * 位置取决于 DATA_DIR，而 DATA_DIR 本身也可能被网页改过 ——
 * 那种情况要重启后才生效（端口/数据目录这类不能在运行时搬家）。
 */
export function userSettingsFile(env = process.env) {
  const dir = path.resolve(ROOT, env.DATA_DIR || 'data');
  return settingsPath(dir);
}

export function loadConfig(rawEnv = process.env) {
  // 先按「环境变量 + .env」定位数据目录，再去读网页保存的设置，
  // 然后用合并后的视图解析其余所有项（网页设置覆盖环境变量）。
  const initialDataDir = path.resolve(ROOT, expandHome(str(rawEnv.DATA_DIR, 'data')));
  const settingsFile = settingsPath(initialDataDir);

  const settings = loadSettings(settingsFile);
  const env = overlaySettings(rawEnv, settings.values);

  // dataDir / authFile 也要跟着网页设置走（DATA_DIR 允许在网页上改）
  const dataDir = path.resolve(ROOT, expandHome(str(env.DATA_DIR, 'data')));
  fs.mkdirSync(dataDir, { recursive: true });
  const authFile = path.join(dataDir, 'auth.json');

  const tokens = resolveTokens(env, authFile);
  const token = tokens[0] || '';

  const baseUrl = str(env.DEEPSEEK_BASE_URL, 'https://chat.deepseek.com').replace(/\/+$/, '');

  return {
    rootDir: ROOT,
    dataDir,
    authFile,
    // 供后台页面显示「配置存在哪、有没有读坏」
    settingsFile: settingsPath(dataDir),
    settingsBroken: settings.broken,
    logLevel: str(env.LOG_LEVEL, 'info'),
    server: {
      host: str(env.HOST, '127.0.0.1'),
      port: int(env.PORT, 8787),
      apiKey: str(env.API_KEY),
      cors: str(env.CORS_ORIGIN, '*'),
      // 入口限流（按客户端 IP 的令牌桶）。和号池冷却不同：那个是上游拒了才冷却，
      // 这个是流量还没打到上游就先挡掉，防止 HOST=0.0.0.0 + 空 API_KEY 时被白嫖。
      rateLimit: {
        enabled: bool(env.RATE_LIMIT_ENABLED, true),
        // 每分钟允许的突发请求数
        capacity: int(env.RATE_LIMIT_PER_MINUTE, 60),
        // 稳态补充速率（每秒补几个令牌）
        refillPerSec: float(env.RATE_LIMIT_REFILL_PER_SEC, 1),
        maxBuckets: int(env.RATE_LIMIT_MAX_BUCKETS, 10_000),
      },
      // 反向代理场景：不设就只认 socket 地址（客户端伪造 XFF 无效）
      // loopback: 只有直连方是本地/私网时才信任 X-Forwarded-For
      trustProxy: str(env.TRUST_PROXY, ''),
    },
    engine: str(env.ENGINE, 'direct'),
    direct: {
      // Windows 上 go build -o bin/ds-pow 不产出 .exe，Node 的 spawn 又不会补扩展名，
      // 这里统一过一遍 resolveExecutable，避免 ENOENT（见 util.mjs）。
      powBin: resolveExecutable(path.resolve(ROOT, expandHome(str(env.POW_BIN, 'bin/ds-pow')))),
      // PoW 求解器每个任务的 goroutine 数。0 = 交给 Go 用 runtime.NumCPU()。
      // 高并发时可以调小（实测：并发 8 时每任务 2 个 worker 比 4 个更快收敛），
      // 因为 N 个并发 solve 各起 NumCPU 个 goroutine 会互相抢核。
      powWorkers: int(env.POW_WORKERS, 0),
      // 每个账号同时在途的请求上限：0 = 不限（纯轮询）。
      // 号池只有一个号时它不起作用；多个号时它把并发摊开，避免全压在一个号上撞风控。
      maxInflightPerAccount: int(env.MAX_INFLIGHT_PER_ACCOUNT, 0),
    },
    deepseek: {
      baseUrl,
      token,
      tokens,
      // always: 打开网页上的「深度思考」（默认）；auto: 按模型名；never: 关闭
      thinking: str(env.DEEPSEEK_THINKING, 'always'),
      search: bool(env.DEEPSEEK_SEARCH, false),
      // 是否主动把网页上的「深度思考 / 智能搜索」开关拨到请求要求的状态
      manageToggles: bool(env.DEEPSEEK_MANAGE_TOGGLES, true),
      defaultModel: str(env.DEFAULT_MODEL, 'deepseek-flash'),
      // 设备画像：chrome-win（桌面 Chrome）/ chrome-android（移动 Chrome）。
      // 一旦选定就长期固定，别来回切，否则会被识别成「设备漂移」。
      deviceProfile: str(env.DEEPSEEK_DEVICE_PROFILE, 'chrome-win'),
      // 冷启动序列：拉配置 / 设备校验 / 配置回执，让账号有「网页打开过」的痕迹
      coldStart: bool(env.DEEPSEEK_COLD_START, true),
      // 行为时序伪装：PoW 耗时不那么快、发送前有输入停顿
      humanTiming: bool(env.DEEPSEEK_HUMAN_TIMING, true),
      modelAliases: {
        'deepseek-flash': { thinking: false },
        'deepseek-v3': { thinking: false },
        'deepseek-web': { thinking: false },
        'deepseek-reasoner': { thinking: true },
        'deepseek-r1': { thinking: true },
      },
    },
    browser: {
      headless: bool(env.BROWSER_HEADLESS, true),
      executablePath: str(env.CHROMIUM_EXECUTABLE) || '',
      // 无 root 环境下，把 .deb 解包到本地目录，通过 LD_LIBRARY_PATH 供 Chromium 使用
      depsDir: expandHome(str(env.CHROMIUM_DEPS_DIR, path.join(os.homedir(), '.local', 'chromium-deps'))),
      userAgent: str(
        env.BROWSER_USER_AGENT,
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ),
      viewport: {
        width: int(env.BROWSER_WIDTH, 1440),
        height: int(env.BROWSER_HEIGHT, 900),
      },
      locale: str(env.BROWSER_LOCALE, 'zh-CN'),
      slowMo: int(env.BROWSER_SLOW_MO, 0),
      launchArgs: str(env.BROWSER_ARGS)
        .split(/\s+/)
        .filter(Boolean),
      navigationTimeoutMs: int(env.BROWSER_NAV_TIMEOUT_MS, 60_000),
    },
    runtime: {
      concurrency: Math.max(1, int(env.CONCURRENCY, 1)),
      queueLimit: int(env.QUEUE_LIMIT, 64),
      requestTimeoutMs: int(env.REQUEST_TIMEOUT_MS, 240_000),
      pollIntervalMs: int(env.POLL_INTERVAL_MS, 60),
      // 文本稳定多久算生成结束（毫秒）
      settleMs: int(env.SETTLE_MS, 800),
      // 两次发送之间的最小间隔：账号级限流，太密会触发「发送过于频繁」
      // 浏览器引擎需要更保守（网页有「发送过于频繁」），直连可以快很多
      sendIntervalMs: int(env.SEND_INTERVAL_MS, 4000),
      // 直连不做发送间隔（限流是「窗口内条数」，靠号池绕），保留开关以便需要时限制
      directSendIntervalMs: int(env.DIRECT_SEND_INTERVAL_MS, 0),
      // 账号被限流后的冷却时间，以及请求最多愿意等多久
      accountCooldownMs: int(env.ACCOUNT_COOLDOWN_MS, 60_000),
      maxCooldownWaitMs: int(env.MAX_COOLDOWN_WAIT_MS, 5_000),
      // 首段正文最多等多久思考内容（毫秒），保证 reasoning 一定排在 content 前面
      reasoningHoldMs: int(env.REASONING_HOLD_MS, 900),
      rateLimitBackoffMs: int(env.RATE_LIMIT_BACKOFF_MS, 4000),
      firstTokenTimeoutMs: int(env.FIRST_TOKEN_TIMEOUT_MS, 90_000),
      idleShutdownMs: int(env.IDLE_SHUTDOWN_MS, 15 * 60_000),
      // 启动时就把浏览器拉起来，省掉第一次请求的 2~3 秒
      warmup: bool(env.WARMUP, true),
      saveArtifacts: bool(env.SAVE_ARTIFACTS, true),
      // 网页输入框单次上限；超过就把较早的上下文拆成附件
      maxPromptChars: int(env.MAX_PROMPT_CHARS, 100_000),
      // 附件注入：拆分出去的上下文最多多少字符（按 3 字节/字的 UTF-8 也远小于上传上限）
      maxAttachmentChars: int(env.MAX_ATTACHMENT_CHARS, 2_000_000),
      // 关掉就恢复旧行为：超长直接 413
      overflowToAttachment: bool(env.OVERFLOW_TO_ATTACHMENT, true),
      // 浏览器模式：抓页面自己发出的 /api/v0/chat/completion 原始流，用模型原始输出
      // （含 DO 工具调用 token）作为权威文本，DOM 只负责流式展示。关掉退回纯 DOM 提取。
      browserCapture: bool(env.BROWSER_CAPTURE, true),
      // DOM 提前判定结束时，最多再等原始流收尾多久（毫秒），用来补齐被截断的尾部 token
      browserCaptureWaitMs: int(env.BROWSER_CAPTURE_WAIT_MS, 20_000),
      // 账号后台探活：每隔多久复检一个「停用/冷却中」的账号。
      // 成功就自动恢复（token 失效不再需要人工重启），0 = 关闭。
      // 下限 60s：探活本身不能成为风控来源。
      accountProbeIntervalMs: int(env.ACCOUNT_PROBE_INTERVAL_MS, 10 * 60_000),
      // 优雅关闭最多等多久（毫秒），超时强制退出。
      // 容器默认 `--stop-timeout` 是 10s，所以默认 8s 留出余量：
      // 自己不退就会被 SIGKILL，那样子进程变孤儿、日志来不及落盘。
      shutdownTimeoutMs: int(env.SHUTDOWN_TIMEOUT_MS, 8000),
    },
  };
}

export const CONFIG_ROOT = ROOT;
