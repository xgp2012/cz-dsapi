/**
 * 构建 Windows 单 exe 发行包。
 *
 * 产出 dist/win-x64/：
 *   fuckds.exe            单文件可执行（Node SEA）
 *   启动.bat              双击启动
 *   .env.example / data/  配置与运行时数据
 *   src/                  程序源码（ESM，运行时由 exe 动态 import）
 *   node_modules/         playwright + playwright-core
 *   bin/ds-pow.exe        Go PoW 求解器
 *   ms-playwright/        精简后的 Chromium
 *   web/dist/             控制台前端（若已构建）
 *
 * 目标机器零安装：解压即用，不需要 Node / Go / Chromium。
 *
 * ── 为什么 src/ 不内嵌进 exe ──────────────────────────────────────────
 * SEA 内嵌的代码一律按 **CommonJS** 执行（实测 Node 24：`import` 语法直接
 * SyntaxError "Cannot use import statement outside a module"），而本项目是
 * 30+ 个 ESM 文件、互相静态 import。把它们强行内联需要自制 bundler，
 * 而 SEA 的 CJS 入口**可以** `await import(fileURL)` 加载磁盘上的 ESM ——
 * 这是官方支持的组合，所以让源码留在 exe 旁边是更简单也更可靠的选择。
 *
 * exe 在这里承担的职责是"目标机器不用装 Node"，而不是"单文件包含一切"。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────
 *   node scripts/build-exe.mjs                  # 完整构建
 *   node scripts/build-exe.mjs --skip-browser   # 不带 Chromium（体积小很多）
 *   node scripts/build-exe.mjs --no-zip         # 不打 zip
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'win-x64');
const BUILD = path.join(ROOT, '.build-exe');
const args = process.argv.slice(2);
const skipBrowser = args.includes('--skip-browser');
const noZip = args.includes('--no-zip');

const log = (m) => console.log(`\x1b[36m▸\x1b[0m ${m}`);
const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);
const warn = (m) => console.log(`\x1b[33m!\x1b[0m ${m}`);
const die = (m) => {
  console.error(`\x1b[31m✗\x1b[0m ${m}`);
  process.exit(1);
};

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

function dirSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p);
    else if (e.isFile()) total += fs.statSync(p).size;
  }
  return total;
}

function copyDir(src, dest, filter) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (filter && !filter(s, e)) continue;
    if (e.isDirectory()) copyDir(s, d, filter);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

// ---------------------------------------------------------------- 0. 前置检查

log(`Node ${process.versions.node}，目标 ${process.platform}-${process.arch}`);
if (process.platform !== 'win32') {
  die('本脚本只产出 Windows exe（SEA 必须用目标平台同版本的 node 二进制）');
}
if (!fs.existsSync(path.join(ROOT, 'node_modules', 'playwright'))) {
  die('缺少 node_modules/playwright，先跑 npm install');
}

// postject 是注入 SEA blob 的唯一可靠方式（对 PE 做二进制手术）
const postject = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
if (!fs.existsSync(postject)) {
  die('缺少 postject。安装：npm i -D postject');
}

// ---------------------------------------------------------------- 1. CJS 入口

log('生成 SEA 入口（CJS → 动态 import ESM）');

fs.rmSync(BUILD, { recursive: true, force: true });
fs.mkdirSync(BUILD, { recursive: true });

/**
 * 入口必须是 CJS（SEA 只支持 CJS 作为 main）。
 * 它做三件事：
 *   1) 把 exe 所在目录定为项目根，并通过 FUCKDS_ROOT 告知 config.mjs；
 *   2) 设置 PLAYWRIGHT_BROWSERS_PATH 指向自带的 ms-playwright/；
 *   3) 动态 import 真实的 src/index.mjs。
 */
const ENTRY = `
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const base = path.dirname(process.execPath);

// config.mjs 用 FUCKDS_ROOT（若存在）而不是 import.meta.dirname 推导项目根
process.env.FUCKDS_ROOT = process.env.FUCKDS_ROOT || base;

// 浏览器缓存随包分发
const bundledBrowsers = path.join(base, 'ms-playwright');
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(bundledBrowsers)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = bundledBrowsers;
}

// 首次运行创建 data/
try { fs.mkdirSync(path.join(base, 'data'), { recursive: true }); } catch {}

const entryFile = path.join(base, 'src', 'index.mjs');
if (!fs.existsSync(entryFile)) {
  console.error('\\n找不到 ' + entryFile);
  console.error('请确认 src/ 与 fuckds.exe 在同一个目录（解压不完整？）\\n');
  process.exit(1);
}

import(pathToFileURL(entryFile).href).catch((err) => {
  console.error('启动失败:', err && err.stack ? err.stack : err);
  process.exit(1);
});
`;

fs.writeFileSync(path.join(BUILD, 'entry.cjs'), ENTRY, 'utf8');

// ---------------------------------------------------------------- 2. SEA blob

log('生成 SEA blob');

fs.writeFileSync(
  path.join(BUILD, 'sea.json'),
  JSON.stringify(
    {
      main: 'entry.cjs',
      output: 'sea-prep.blob',
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
    },
    null,
    2,
  ),
);

const seaRun = spawnSync(process.execPath, ['--experimental-sea-config', 'sea.json'], {
  cwd: BUILD,
  encoding: 'utf8',
});
if (seaRun.status !== 0) {
  console.error(seaRun.stdout || '', seaRun.stderr || '');
  die('生成 SEA blob 失败');
}
const blob = path.join(BUILD, 'sea-prep.blob');
if (!fs.existsSync(blob)) die('SEA blob 未生成');
ok(`blob: ${mb(fs.statSync(blob).size)}`);

// ---------------------------------------------------------------- 3. exe

log('组装 exe');

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 用 step 2 的 node 原型复制出来，但原 exe 被 SEA 注入后会破坏签名，
// 所以这里复制一份干净的 node.exe 作为基底
const exePath = path.join(OUT, 'fuckds.exe');
// process.execPath 就是当前 node.exe，没有被注入过
fs.copyFileSync(process.execPath, exePath);

const inject = spawnSync(
  process.execPath,
  [
    postject,
    exePath,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  { cwd: ROOT, encoding: 'utf8' },
);
if (inject.status !== 0) {
  console.error(inject.stdout || '', inject.stderr || '');
  die('SEA blob 注入失败');
}
ok(`fuckds.exe: ${mb(fs.statSync(exePath).size)}（含 blob）`);

// ---------------------------------------------------------------- 4. 外置依赖

log('收集外置依赖');

// src/：程序本体
copyDir(path.join(ROOT, 'src'), path.join(OUT, 'src'));
ok(`src/: ${mb(dirSize(path.join(OUT, 'src')))}`);

// node_modules
const nmOut = path.join(OUT, 'node_modules');
for (const pkg of ['playwright', 'playwright-core']) {
  const src = path.join(ROOT, 'node_modules', pkg);
  if (!fs.existsSync(src)) die(`缺少 node_modules/${pkg}`);
  copyDir(src, path.join(nmOut, pkg));
}
ok(`node_modules: ${mb(dirSize(nmOut))}`);

// ds-pow
for (const cand of ['ds-pow.exe', 'ds-pow']) {
  const p = path.join(ROOT, 'bin', cand);
  if (fs.existsSync(p)) {
    fs.mkdirSync(path.join(OUT, 'bin'), { recursive: true });
    fs.copyFileSync(p, path.join(OUT, 'bin', 'ds-pow.exe'));
    ok(`ds-pow.exe: ${mb(fs.statSync(p).size)}`);
    break;
  }
}
if (!fs.existsSync(path.join(OUT, 'bin', 'ds-pow.exe'))) {
  warn('没有 bin/ds-pow.exe —— 目标机器只能跑 browser 引擎（先 npm run pow:build）');
}

// Chromium
if (skipBrowser) {
  warn('按 --skip-browser 跳过 Chromium');
} else {
  const cacheRoot =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || '', 'ms-playwright')
      : path.join(os.homedir(), '.cache', 'ms-playwright'));

  if (!fs.existsSync(cacheRoot)) {
    warn(`找不到 ${cacheRoot}，跳过。先跑 npm run setup:browser`);
  } else {
    const browsers = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'node_modules', 'playwright-core', 'browsers.json'), 'utf8'),
    );
    // ── 只带 headless shell，不带完整 Chromium ─────────────────────────
    // 实测：headless=true 时 playwright 只认 headless_shell.exe，完整 chromium
    // 完全不参与，白占 313MB。而本项目默认就是 headless（BROWSER_HEADLESS=true）。
    //
    // 代价：如果用户在 .env 里设 BROWSER_HEADLESS=false（要可视化看页面/过验证码），
    // 就会缺 chromium-<rev>。用 --with-chromium 可以把完整版也带上。
    //
    // 两个坑：
    //  1. 缓存目录名用下划线（chromium_headless_shell-1148），而 browsers.json 里
    //     写的是连字符（chromium-headless-shell）。直接拼 name-revision 永远匹配不上；
    //  2. chromium-tip-of-tree 是 Playwright 自己的实验版本，本项目从不用它。
    const withChromium = args.includes('--with-chromium');
    const dirName = (b) => `${b.name.replace(/-/g, '_')}-${b.revision}`;
    const wanted = new Set(
      browsers.browsers
        .filter((b) => /^chromium/.test(b.name) && !b.name.includes('tip-of-tree'))
        .filter((b) => (withChromium ? true : b.name === 'chromium-headless-shell'))
        .map(dirName),
    );
    const outBrowsers = path.join(OUT, 'ms-playwright');
    let n = 0;
    for (const name of fs.readdirSync(cacheRoot)) {
      if (!wanted.has(name)) continue;
      copyDir(path.join(cacheRoot, name), path.join(outBrowsers, name));
      n += 1;
    }
    const copied = fs.existsSync(outBrowsers) ? fs.readdirSync(outBrowsers) : [];
    const missing = [...wanted].filter((w) => !copied.includes(w));
    if (n === 0) warn(`缓存里没有匹配的版本（需要 ${[...wanted].join(', ')}）`);
    else if (missing.length) {
      warn(`缺少浏览器包: ${missing.join(', ')} —— browser 引擎会启动失败。先跑 npm run setup:browser`);
    } else ok(`Chromium: ${n} 个包，${mb(dirSize(outBrowsers))}`);
  }
}

// web/dist
const webDist = path.join(ROOT, 'web', 'dist');
if (fs.existsSync(path.join(webDist, 'index.html'))) {
  copyDir(webDist, path.join(OUT, 'web', 'dist'));
  ok(`控制台: ${mb(dirSize(path.join(OUT, 'web', 'dist')))}`);
} else {
  warn('无 web/dist，包里没有控制台（先 npm run admin:install && npm run admin:build）');
}

// 配置与数据目录
fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(OUT, '.env.example'));
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });

// ---------------------------------------------------------------- 5. 启动器

/**
 * 启动脚本要做三件事：
 *   1) 首次运行时把 .env.example 复制成 .env（否则用户不知道要改哪个文件）；
 *   2) 检测登录态是否已配置——没配置就直接把操作指引打在屏幕上。
 *      exe 里抛出的错误信息虽然也写了，但双击启动时窗口可能一闪而过，
 *      在 bat 里先拦一道，用户能看清楚再决定；
 *   3) 服务退出后 pause，避免窗口瞬间关闭。
 */
/**
 * 启动脚本的职责要克制：
 *   1) 首次运行时把 .env.example 复制成 .env；
 *   2) 设置 PLAYWRIGHT_BROWSERS_PATH；
 *   3) 起 exe，并**无论如何都 pause**，这样 exe 报的错用户能看清楚。
 *
 * 不在 bat 里判断"token 配没配"：
 *   findstr 的 regex 不支持 `.*` 量词（实测 `^X=.` 对 "X=abc" 也不匹配），
 *   想正确区分"空值 / 有值 / 注释掉"非常别扭。而且现在服务在没配 token 时
 *   也能起来，控制台会把用户直接领到「账号」页，bat 不需要重复判断。
 */
const batContent = [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal',
  'cd /d "%~dp0"',
  '',
  'if not exist ".env" (',
  '  copy ".env.example" ".env" >nul 2>&1',
  '  echo 已生成配置模板 .env（首次运行）',
  ')',
  'if exist "ms-playwright" set "PLAYWRIGHT_BROWSERS_PATH=%~dp0ms-playwright"',
  '',
  'rem 端口默认 8787，与 config.mjs 保持一致；.env 里改过就用改后的',
  'set "_FU_PORT=8787"',
  'for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b /c:"PORT=" ".env" 2^>nul`) do set "_FU_PORT=%%b"',
  '',
  'echo ============================================================',
  'echo   fuckds 正在启动，按 Ctrl+C 可停止',
  'echo ============================================================',
  'echo.',
  'rem 稍等片刻再开浏览器：服务 listen 是异步的，太早打开会显示连接失败',
  'start "" cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:%_FU_PORT%/admin/"',
  'fuckds.exe',
  'set "_FU_CODE=%ERRORLEVEL%"',
  'echo.',
  'if not "%_FU_CODE%"=="0" (',
  '  echo 服务异常退出（退出码 %_FU_CODE%）。',
  '  echo 上面的提示里说明了原因和处理办法。',
  '  echo 需要改配置就用记事本打开： .env',
  ')',
  'echo.',
  'pause',
  '',
].join('\r\n');

// cmd 在 chcp 65001 下没有 BOM 时仍可能把中文按 ANSI 解释成乱码，显式加 UTF-8 BOM
fs.writeFileSync(path.join(OUT, '启动.bat'), `\uFEFF${batContent}`, 'utf8');
ok('启动.bat 已生成（含首次运行引导）');

// ---------------------------------------------------------------- 6. 冒烟验证

log('验证 exe 能启动');

/**
 * 自检策略：用 `--version` 之类的轻量路径会绕过真实加载，测不出问题。
 * 这里真的启动服务，但用 PORT=0（随机端口）避免和占用冲突，
 * 然后看它是否打印了"服务已启动"。
 *
 * 引擎选 browser：direct 需要在目标机器上有 token，否则 createEngine 会抛错
 * ——那会和真正的打包问题混在一起，干扰判断。
 */
const smokePort = 30000 + Math.floor(Math.random() * 20000);
const smoke = spawnSync(exePath, [], {
  cwd: OUT,
  encoding: 'utf8',
  timeout: 25_000,
  env: {
    ...process.env,
    PORT: String(smokePort),
    HOST: '127.0.0.1',
    ENGINE: 'browser',
    WARMUP: 'false',
    API_KEY: '',
    LOG_LEVEL: 'info',
    IDLE_SHUTDOWN_MS: '0',
    PLAYWRIGHT_BROWSERS_PATH: path.join(OUT, 'ms-playwright'),
  },
});

// 服务启动后常驻，所以超时被 kill 属正常；只看它有没有打印启动横幅或致命错误
const combined = `${smoke.stdout || ''}${smoke.stderr || ''}`;
const fatal = combined.match(
  /找不到.*src|ERR_MODULE_NOT_FOUND|Cannot find module|SyntaxError|Cannot use import statement/,
);
if (fatal) {
  console.error(combined.slice(0, 1500));
  die('exe 启动自检失败：exe 无法载入 src/');
}
if (combined.includes('服务已启动')) {
  ok('exe 启动自检通过（已监听并打印启动横幅）');
} else {
  warn('未捕获到启动横幅，可能提前退出了。输出如下：');
  console.log(combined.slice(0, 1200) || '(无输出)');
}

// ---------------------------------------------------------------- 6b. 浏览器自检

if (!skipBrowser && fs.existsSync(path.join(OUT, 'ms-playwright'))) {
  log('验证随包的 Chromium 能真正启动');

  // 探测脚本放在 BUILD 而不是 OUT：模块解析用绝对路径（import 文件 URL），
  // 这样 cwd 可以是 BUILD —— Chromium 启动失败时会往 cwd 写 debug.log，
  // 放在 OUT 就会被一起打进发行包。BUILD 最后会整个删掉。
  const probeFile = path.join(BUILD, 'probe-browser.mjs');
  const playwrightUrl = new URL(
    `file:///${path.join(OUT, 'node_modules', 'playwright', 'index.mjs').replace(/\\/g, '/')}`,
  ).href;
  fs.writeFileSync(
    probeFile,
    `import { chromium } from ${JSON.stringify(playwrightUrl)};
const b = await chromium.launch({ headless: true });
const page = await b.newPage();
await page.setContent('<h1>ok</h1>');
const text = await page.textContent('h1');
await b.close();
console.log('BROWSER-OK', b.version(), text);
`,
    'utf8',
  );
  const probe = spawnSync(process.execPath, [probeFile], {
    cwd: BUILD,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: path.join(OUT, 'ms-playwright') },
  });
  fs.rmSync(probeFile, { force: true });
  const out = `${probe.stdout || ''}${probe.stderr || ''}`;
  if (out.includes('BROWSER-OK')) {
    ok('Chromium 可用（启动 → 打开页面 → 取文本 → 关闭）');
  } else {
    console.error(out.slice(0, 1200));
    die('随包 Chromium 无法启动 —— 目标机器上 browser 引擎会挂');
  }
}

// ---------------------------------------------------------------- 7. zip

// 兜底：清掉自检过程可能在产物目录里留下的运行时垃圾
for (const junk of ['debug.log', '.probe-browser.mjs', 'chrome_debug.log']) {
  fs.rmSync(path.join(OUT, junk), { force: true });
}

if (!noZip) {
  log('打包 zip');
  const zipName = path.join(DIST, 'fuckds-win-x64.zip');
  fs.rmSync(zipName, { force: true });
  // 用 .NET 的 ZipFile 避免 Compress-Archive 对中文路径/大目录的性能问题。
  //
  // 注意 CreateFromDirectory 会把**目录本身**作为压缩包的根，也就是解压后
  // 多一层 win-x64/。为了让用户解压出来就是"fuckds.exe 在最外层"，
  // 这里创建后把内部条目统一去掉那一层前缀。
  const ps = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        `$zip = '${zipName}'`,
        `[System.IO.Compression.ZipFile]::CreateFromDirectory('${OUT}', $zip,`,
        '  [System.IO.Compression.CompressionLevel]::Optimal, $false)',
        // 去掉顶层 win-x64/ 前缀
        '$prefix = "win-x64/"',
        '$src = [System.IO.Compression.ZipFile]::OpenRead($zip)',
        '$dst = [System.IO.Compression.ZipFile]::Open($zip + ".tmp", "Create")',
        'foreach ($e in $src.Entries) {',
        '  $n = $e.FullName',
        '  if ($n.StartsWith($prefix)) { $n = $n.Substring($prefix.Length) }',
        '  if ($n -eq "") { continue }',
        '  $ne = $dst.CreateEntry($n, [System.IO.Compression.CompressionLevel]::Optimal)',
        '  $ne.LastWriteTime = $e.LastWriteTime',
        '  $si = $e.Open(); $di = $ne.Open()',
        '  $si.CopyTo($di)',
        '  $di.Dispose(); $si.Dispose()',
        '}',
        '$src.Dispose(); $dst.Dispose()',
        'Remove-Item $zip -Force',
        'Move-Item ($zip + ".tmp") $zip',
      ].join('\n'),
    ],
    { encoding: 'utf8' },
  );
  if (ps.status === 0 && fs.existsSync(zipName)) {
    ok(`zip: ${mb(fs.statSync(zipName).size)}`);
  } else {
    warn(`zip 失败: ${(ps.stderr || ps.stdout || '').slice(0, 300)}`);
  }
}

fs.rmSync(BUILD, { recursive: true, force: true });

console.log('');
ok(`构建完成 -> ${OUT}`);
console.log(`  总大小 ${mb(dirSize(OUT))}`);
console.log('  目标机器：解压后双击「启动.bat」，无需安装 Node / Go / Chromium');
