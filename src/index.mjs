import { loadConfig } from './config.mjs';
import { createLogger } from './logger.mjs';
import { createEngine } from './engine.mjs';
import { createServer } from './server.mjs';

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

const shutdown = async (signal) => {
  logger.info(`收到 ${signal}，正在关闭…`);
  server.close();
  await web.close().catch(() => {});
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error('未处理的 Promise 拒绝:', err));

if (config.runtime.warmup) {
  web.warmUp()
    .then(() => logger.info('浏览器和对话页已预热'))
    .catch((err) => logger.warn('预热失败（首次请求会重新启动）:', err.message));
}

server.listen(config.server.port, config.server.host, () => {
  const base = `http://${config.server.host === '0.0.0.0' ? '127.0.0.1' : config.server.host}:${config.server.port}`;
  const ready = config.deepseek.tokens.length > 0;

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
