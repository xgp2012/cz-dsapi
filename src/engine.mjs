import fs from 'node:fs';
import path from 'node:path';

import { DeepSeekWeb } from './browser/driver.mjs';
import { DirectEngine } from './direct/client.mjs';
import { ApiError } from './errors.mjs';

/**
 * 选择引擎（默认 direct）：
 *   ENGINE=direct  只直连（需要 bin/ds-pow + 登录态）；条件不满足直接抛错
 *   ENGINE=browser 只走 Playwright（驱动真实网页，不依赖 PoW 求解器，但**仍需要登录态**）
 *   ENGINE=auto    有 Go 求解器就直连，否则回退浏览器
 */

/**
 * 是否跑在打包后的 exe 里（SEA）。
 *
 * 打包入口会设置 FUCKDS_ROOT=exe 所在目录，源码运行时不会设置 —— 这是最可靠的判据。
 * （不要用 npm_package_name：只有 `npm start` 才有，直接 `node src/index.mjs` 就没有。）
 */
const isPackaged = () => Boolean(process.env.FUCKDS_ROOT);

/**
 * 登录态缺失时的提示。
 *
 * 这是**首次运行的必经之路**：不管哪个引擎，没有 userToken 都无法工作
 * （direct 用它做接口鉴权，browser 用它写入页面 localStorage）。
 * 所以这里要把"到底缺什么、从哪拿、往哪放"说清楚，而不是让用户去猜。
 */
function tokenHelp(config) {
  const dataDir = path.dirname(config.authFile);
  const envLine = 'DEEPSEEK_USER_TOKEN=<你的 token>';
  const lines = [
    '',
    '  缺少 DeepSeek 登录态（userToken）。三种配置方式，任选一种：',
    '',
    '  1) 环境变量（临时，最简单）',
    `     set ${envLine}`,
    '     fuckds.exe',
    '',
    '  2) 写进 .env 文件（推荐，放在 fuckds.exe 同目录）',
    `     ${envLine}`,
    '',
    '  3) 写入鉴权文件（支持多账号号池）',
    `     ${path.join(dataDir, 'auth.json')}`,
    '     内容格式： {"token":"<token>","tokens":["<token>"]}',
    '',
    '  怎么拿 token：浏览器登录 https://chat.deepseek.com → F12 打开开发者工具',
    '     → Console 里执行  localStorage.getItem("userToken")',
    '     → 复制输出的那一串（是 {"value":"..."} 形式也可以，会自己解析）',
    '',
  ];
  return lines.join('\n');
}

/**
 * 未配置登录态时的占位引擎。
 *
 * 以前缺 token 会让进程直接退出，于是用户陷入死锁：
 *   「Web UI 里能配 token」← 但要先启动服务 → 「启动要求有 token」。
 *
 * 现在改为照常启动 HTTP 服务和控制台，只有**真的发请求**时才报错。
 * 这样第一次使用可以：双击 exe → 打开 /admin → 粘贴 token → 点重启 → 开用。
 *
 * 它满足引擎契约（status/warmUp/close/chat），因此不需要在 server 侧做特判。
 */
class UnconfiguredEngine {
  constructor({ config }) {
    this.config = config;
    this.reason = '还没有配置 DeepSeek 登录态（userToken）';
  }

  status() {
    return {
      engine: 'unconfigured',
      ready: false,
      needsSetup: true,
      reason: this.reason,
      browser: false,
      pages: 0,
      busy: 0,
      queued: 0,
    };
  }

  async warmUp() {
    /* 没有账号可预热 */
  }

  async close() {
    /* 没有资源要释放 */
  }

  async chat() {
    // 用 400 而不是 500：这是用户侧的配置问题，不是服务端故障。
    throw new ApiError(
      400,
      `${this.reason}。请打开 http://<本机地址>:${this.config.server.port}/admin/ 到「账号」页粘贴 token，或设置环境变量 DEEPSEEK_USER_TOKEN。`,
      { code: 'deepseek_auth_required', type: 'invalid_request_error' },
    );
  }
}

export function createEngine({ config, logger }) {
  // 未显式指定时默认 direct
  const engine = config.engine ?? 'direct';

  const hasToken = Boolean(config.deepseek.token);
  const binExists = fs.existsSync(config.direct.powBin);
  const wantDirect = engine !== 'browser';
  const canDirect = binExists && hasToken;

  // 没有登录态：不再抛错，交给占位引擎，让控制台能起来。
  if (!hasToken) {
    logger.warn('尚未配置 DeepSeek 登录态，服务照常启动但无法处理对话请求');
    logger.warn(`  请在控制台「账号」页粘贴 token：http://127.0.0.1:${config.server.port}/admin/`);
    if (!binExists) {
      logger.warn(`  另外缺少 PoW 求解器：${config.direct.powBin}`);
    }
    return new UnconfiguredEngine({ config });
  }

  if (wantDirect && canDirect) {
    return new DirectEngine({ config, logger: logger.child('direct') });
  }

  if (engine === 'direct') {
    // 到这里说明 token 有、但 PoW 二进制缺失
    const why = isPackaged()
      ? `bin/ds-pow.exe 应该随包分发，但没找到：${config.direct.powBin}\n` +
        '  解压是否不完整？或改用 ENGINE=browser（不需要求解器）。'
      : `缺少 PoW 求解器：${config.direct.powBin}\n` + '  先执行 npm run pow:build。';
    throw new Error(`ENGINE=direct 但缺少 PoW 求解器。\n  ${why}`);
  }

  if (wantDirect) {
    logger.warn(
      `没有可用的 Go PoW 求解器（${config.direct.powBin}），回退到 Playwright 引擎` +
        (isPackaged() ? '' : '（npm run pow:build 可修复）'),
    );
  }
  return new DeepSeekWeb({ config, logger: logger.child('web') });
}
