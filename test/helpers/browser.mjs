import path from 'node:path';
import { chromium } from 'playwright';

import { loadConfig } from '../../src/config.mjs';
import { buildLaunchEnv, resolveChromiumExecutable } from '../../src/browser/env.mjs';

const dataDir = path.join(process.cwd(), 'test', '.artifacts', 'data');

let browser = null;
let failure = null;

export function makeConfig(overrides = {}) {
  return loadConfig({
    ...process.env,
    DATA_DIR: dataDir,
    DEEPSEEK_USER_TOKEN: 'test-token-0123456789abcdef',
    // 不继承本地 .env 里真实的 API_KEY，否则测试里的服务会要求鉴权
    API_KEY: '',
    ...overrides,
  });
}

export async function getBrowser() {
  if (browser?.isConnected()) return browser;
  if (failure) throw failure;
  try {
    const config = makeConfig();
    const env = buildLaunchEnv(config, { warn() {} });
    browser = await chromium.launch({
      headless: true,
      executablePath: resolveChromiumExecutable(config),
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      env,
    });
    return browser;
  } catch (err) {
    failure = err;
    throw err;
  }
}

export async function closeBrowser() {
  await browser?.close().catch(() => {});
  browser = null;
}

/** 浏览器起不来就跳过，别让 CI/无网环境红一片 */
export async function requireBrowser(t) {
  try {
    return await getBrowser();
  } catch (err) {
    t.skip(`浏览器不可用：${err.message.split('\n')[0]}`);
    return null;
  }
}
