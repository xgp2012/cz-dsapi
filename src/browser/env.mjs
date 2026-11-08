import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Playwright 浏览器缓存的默认根目录（按平台分）。
 *
 * 不能用 `os.homedir()/.cache` 一把梭：Windows 是 `%LOCALAPPDATA%\ms-playwright`，
 * macOS 是 `~/Library/Caches/ms-playwright`，Linux 才是 `~/.cache/ms-playwright`。
 * 之前只写死 Linux 路径，导致 Windows / macOS 上这里永远找不到浏览器，
 * 只能靠用户手动设 CHROMIUM_EXECUTABLE 才能跑起来。
 */
function defaultCacheRoots(platform = process.platform, env = process.env) {
  const home = os.homedir();
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [path.join(localAppData, 'ms-playwright')];
  }
  if (platform === 'darwin') {
    return [path.join(home, 'Library', 'Caches', 'ms-playwright')];
  }
  return [path.join(home, '.cache', 'ms-playwright')];
}

/**
 * 各平台下完整版 chromium 可执行文件的相对路径。
 *
 * 新版 Playwright 把目录从 `chrome-linux/` / `chrome-win/` 改成了
 * `chrome-linux64/` / `chrome-win64/`，两种都要认，否则升级 Playwright
 * 或者本机缓存来自另一个版本时会静默找不到。
 */
function chromiumCandidates(dir, platform = process.platform) {
  if (platform === 'win32') {
    return [
      path.join(dir, 'chrome-win64', 'chrome.exe'),
      path.join(dir, 'chrome-win', 'chrome.exe'),
    ];
  }
  if (platform === 'darwin') {
    return [
      path.join(dir, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      path.join(dir, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ];
  }
  return [path.join(dir, 'chrome-linux64', 'chrome'), path.join(dir, 'chrome-linux', 'chrome')];
}

/** 在 Playwright 缓存里找完整版 chromium（比 headless_shell 更稳） */
export function resolveChromiumExecutable(config) {
  if (config.browser.executablePath) return config.browser.executablePath;

  const roots = process.env.PLAYWRIGHT_BROWSERS_PATH
    ? [process.env.PLAYWRIGHT_BROWSERS_PATH]
    : defaultCacheRoots();

  for (const cache of roots) {
    try {
      const dirs = fs
        .readdirSync(cache)
        .filter((d) => d.startsWith('chromium-') && !d.includes('headless_shell'))
        .sort()
        .reverse();
      for (const dir of dirs) {
        for (const bin of chromiumCandidates(path.join(cache, dir))) {
          if (fs.existsSync(bin) && fs.statSync(bin).size > 0) return bin;
        }
      }
    } catch {
      /* 找不到就交给 Playwright 自己挑 */
    }
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
