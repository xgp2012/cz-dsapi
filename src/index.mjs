import fs from 'node:fs';

import { loadConfig } from './config.mjs';
import { createLogger } from './logger.mjs';
import { createEngine } from './engine.mjs';
import { createServer } from './server.mjs';
import { createAccountMonitor } from './account-monitor.mjs';

const config = loadConfig();
const logger = createLogger(config.logLevel);

/**
 * 引擎创建失败基本都是**配置没做完**（缺 token / 缺 PoW 求解器），
 * 不是程序 bug。这种情况下把完整的 stack 打出来只会淹没真正的提示，
 * 所以只打印 message（engine.mjs 里已经写得很详细了），
 * 并用非 0 退出码让外层脚本能识别失败。
 */
let web;
try {
  web = createEngine({ config, logger });
} catch (err) {
  console.error(`\n启动失败：${err.message}\n`);
  process.exit(1);
}

const server = createServer({ config, logger, web });

/**
 * 账号后台探活：让「token 失效 → 人工重新 auth + 重启」变成自动恢复。
 * 引擎不支持（browser / 未配置）时会自己静默跳过，这里不需要分支。
 */
const monitor = createAccountMonitor({
  engine: web,
  config,
  logger: logger.child('probe'),
  onEvent: (event) => {
    // 目前只落日志；留成回调是为了以后接 Telegram / 邮件告警时不用改探活逻辑
    if (event.type === 'unavailable') {
      logger.warn(`账号 #${event.index} 已不可用${event.authFailed ? '（登录态失效）' : ''}：${event.reason ?? ''}`);
    } else if (event.type === 'recovered') {
      logger.info(`账号 #${event.index} 已恢复可用`);
    }
  },
});

/**
 * 优雅关闭。
 *
 * 容器里这条路径比以前重要得多：`docker stop` 先发 SIGTERM，等
 * **10 秒**（默认 `--stop-timeout`）后直接 SIGKILL。而 `web.close()` 要关
 * Playwright 的 Chromium，慢的时候可能超过这个窗口 —— 被 SIGKILL 的话
 * 子进程会变成孤儿、优雅收尾全部作废。
 *
 * 所以这里加两道保险：
 *   1. **不重复进入**：SIGTERM 之后 tini 或 docker 可能再补一次信号，
 *      重入会让 close() 跑两遍；
 *   2. **超时兜底**：关不完就强制退出，用非 0 退出码让人能在日志里看出来。
 *      宁可不优雅也不能被 SIGKILL（那时连日志都来不及落盘）。
 */
let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) {
    logger.warn(`收到 ${signal}，关闭已在进行中（忽略本次信号）`);
    return;
  }
  shuttingDown = true;
  logger.info(`收到 ${signal}，正在关闭…`);

  // 容器默认 10s 宽限，我们留 2s 余量自己先退，避免被 SIGKILL
  const forceMs = Math.max(1000, config.runtime.shutdownTimeoutMs);
  const forced = setTimeout(() => {
    logger.error(`关闭超时（${forceMs}ms），强制退出。可能有未收尾的连接或子进程。`);
    process.exit(1);
  }, forceMs);
  forced.unref?.();

  try {
    monitor.stop();
    server.close();
    await web.close().catch(() => {});
    clearTimeout(forced);
    logger.info('已关闭');
    process.exit(0);
  } catch (err) {
    clearTimeout(forced);
    logger.error('关闭过程中出错，强制退出:', err?.message || err);
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error('未处理的 Promise 拒绝:', err));

if (config.runtime.warmup) {
  web.warmUp()
    .then(() => logger.info('浏览器和对话页已预热'))
    .catch((err) => logger.warn('预热失败（首次请求会重新启动）:', err.message));
}

// 探活只在有号、且引擎支持时才真正启动（内部自己判定）
if (config.runtime.accountProbeIntervalMs > 0) monitor.start();

server.listen(config.server.port, config.server.host, () => {
  const base = `http://${config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host}:${config.server.port}`;
  const ready = config.deepseek.tokens.length > 0;
  const inDocker = Boolean(process.env.CZDSAPI_DOCKER) || fs.existsSync('/.dockerenv');

  logger.info('服务已启动');
  // 控制台放最前面：首次使用的人第一眼就该看到"去哪配置"
  logger.info(`  控制台     ${base}/admin/`);
  logger.info(`  接口       ${base}/v1/chat/completions`);
  logger.info(`  模型列表   ${base}/v1/models`);
  logger.info(`  健康检查   ${base}/healthz`);
  logger.info(
    `  登录态     ${
      ready ? `已配置 ✅ 号池 ${config.deepseek.tokens.length} 个` : '未配置 ❌ 打开上面的控制台，在「账号」页粘贴 token'
    }`,
  );
  logger.info(`  引擎       ${web.status().engine || 'browser'}`);
  logger.info(`  并发       ${config.runtime.concurrency}，单次超时 ${Math.round(config.runtime.requestTimeoutMs / 1000)}s`);
  if (monitor.status().enabled) {
    logger.info(`  账号探活   每 ${Math.round(config.runtime.accountProbeIntervalMs / 1000)}s 复检停用/冷却中的账号（失效自动恢复）`);
  }

  // 容器里上面那个 127.0.0.1 是**容器内部**地址，在宿主机浏览器里打不开。
  // 不说清楚的话，用户会以为是"服务没起来"，而其实只是地址取错了。
  if (inDocker) {
    logger.info(`  部署形态   Docker 容器（容器内监听 ${config.server.host}:${config.server.port}）`);
    logger.info('');
    logger.info('  容器内看到的 127.0.0.1 是容器自己，请改用下面这个地址访问：');
    logger.info('    http://<宿主机IP>:' + config.server.port + '/admin/');
    logger.info('    （本机就是宿主机时可用 http://localhost:' + config.server.port + '/admin/）');
    if (!config.server.apiKey) {
      logger.warn('  ⚠️  当前 API_KEY 为空且监听 0.0.0.0：任何能访问该端口的人都能直接用量。');
      logger.warn('     请设置 -e API_KEY=<强随机串>，否则务必确认端口没有暴露到公网。');
    }
  }

  if (!ready) {
    // 用醒目的分隔线，避免淹没在普通日志里。
    // 不用 ╔═╗ 这类制表符：Windows 控制台默认字体下会显示成乱码（实测），
    // 用纯 ASCII 的 = 和 | 最稳。
    const line = '='.repeat(62);
    const pad = (text) => `| ${text.padEnd(58)}|`;
    logger.warn('');
    logger.warn(line);
    logger.warn(pad('还没有配置 DeepSeek 登录态，现在无法处理对话请求'));
    logger.warn(pad(''));
    logger.warn(pad('用浏览器打开下面这个地址，在「账号」页粘贴 token：'));
    logger.warn(pad(`  ${base}/admin/`));
    logger.warn(pad(''));
    logger.warn(pad('取 token：登录 chat.deepseek.com -> F12 -> Console'));
    logger.warn(pad('          localStorage.getItem("userToken")'));
    logger.warn(line);
  }
});

server.on('error', (err) => {
  logger.error('HTTP 服务启动失败:', err.message);
  process.exit(1);
});
