import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 在 ~/.cache/ms-playwright 里找完整版 chromium（比 headless_shell 更稳） */
export function resolveChromiumExecutable(config) {
  if (config.browser.executablePath) return config.browser.executablePath;

  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    const dirs = fs
      .readdirSync(cache)
      .filter((d) => d.startsWith('chromium-') && !d.includes('headless_shell'))
      .sort()
      .reverse();
    for (const dir of dirs) {
      const bin = path.join(cache, dir, 'chrome-linux', 'chrome');
      if (fs.existsSync(bin) && fs.statSync(bin).size > 0) return bin;
    }
  } catch {
    /* 找不到就交给 Playwright 自己挑 */
  }
  return undefined;
}

/**
 * 构造 Chromium 进程环境变量。
 *
 * 在 Android / 无 root 的容器里，系统缺少 Chromium 需要的一批 so。
 * scripts/install-chromium-deps.sh 会把 .deb 解包到 ~/.local/chromium-deps，
 * 这里通过 LD_LIBRARY_PATH + FONTCONFIG_FILE 把它们接上（不污染系统）。
 */
export function buildLaunchEnv(config, logger) {
  const env = { ...process.env };
  const deps = config.browser.depsDir;

  if (!deps || !fs.existsSync(deps)) return env;

  const libCandidates = [
    path.join(deps, 'usr', 'lib', 'aarch64-linux-gnu'),
    path.join(deps, 'lib', 'aarch64-linux-gnu'),
    path.join(deps, 'usr', 'lib'),
    path.join(deps, 'lib'),
  ].filter((p) => fs.existsSync(p));

  if (libCandidates.length) {
    env.LD_LIBRARY_PATH = [...libCandidates, env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  }

  const fontDirs = [
    path.join(deps, 'usr', 'share', 'fonts'),
    '/usr/share/fonts',
    '/usr/local/share/fonts',
  ].filter((p) => fs.existsSync(p));

  if (fontDirs.length) {
    const confPath = path.join(config.dataDir, 'fonts.conf');
    const cacheDir = path.join(config.dataDir, 'font-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const xml = [
      '<?xml version="1.0"?>',
      '<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">',
      '<fontconfig>',
      ...fontDirs.map((dir) => `  <dir>${dir}</dir>`),
      `  <cachedir>${cacheDir}</cachedir>`,
      '</fontconfig>',
      '',
    ].join('\n');
    try {
      fs.writeFileSync(confPath, xml);
      env.FONTCONFIG_FILE = confPath;
    } catch (err) {
      logger?.warn('写入 fonts.conf 失败，沿用系统字体配置:', err.message);
    }
  }

  // 依赖库通过 LD_LIBRARY_PATH 提供，跳过 Playwright 的宿主机校验
  env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = '1';
  return env;
}
