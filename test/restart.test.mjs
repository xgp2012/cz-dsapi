import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 「重启」在两种运行形态下的分派逻辑。
 *
 * 真实重启需要 spawn 新进程 + 抢端口，不适合在单元测试里跑（会污染测试环境、
 * 也可能残留进程）。这里只锁住**结构不变**：这两种形态的判定和关键步骤一旦被
 * 改坏，下面的断言会立刻失败。
 *
 * 真实行为已在打包产物上手工验证：direct 与 browser 两种引擎重启后 pid 都变化、
 * 旧进程干净退出、无孤儿 headless_shell。
 */

const source = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'admin', 'routes.mjs'),
  'utf8',
);

test('重启会区分源码模式与打包模式', () => {
  assert.match(
    source,
    /const packaged = Boolean\(process\.env\.FUCKDS_ROOT\)/,
    '打包模式要能识别出来（FUCKDS_ROOT 是唯一可靠信号）',
  );
  assert.match(source, /if \(packaged\) \{\s*return restartPackaged\(\);/, '打包模式要走独立分支');
});

test('打包模式不依赖 scripts/server-ctl.mjs（发行包里没有 scripts/）', () => {
  const packagedFn = source.slice(source.indexOf('async function restartPackaged'));
  const body = packagedFn.slice(0, packagedFn.indexOf('\n  }\n'));
  assert.doesNotMatch(body, /server-ctl/, '打包分支不能引用只存在于源码树里的脚本');
  assert.doesNotMatch(body, /existsSync\(ctlScript\)/, '打包分支不能因为缺脚本而报错');
});

test('打包模式用「exe + 空参数」启动，不传脚本路径', () => {
  // process.execPath 在 SEA 里就是 fuckds.exe，带参数会被当成用户参数
  assert.match(source, /spawn\(exe, \[\], \{/, '必须以空参数启动自身');
  assert.doesNotMatch(
    source.slice(source.indexOf('async function restartPackaged')),
    /spawn\(exe, \['.*index\.mjs'/,
    '不能把 src/index.mjs 当脚本参数传给 exe',
  );
});

test('打包模式先释放端口再退出，且走优雅关闭', () => {
  const body = source.slice(source.indexOf('async function restartPackaged'));
  assert.match(body, /server\?\.close\?\.\(\)/, '要先 close server 释放端口，否则新进程 EADDRINUSE');
  assert.match(
    body,
    /process\.kill\(process\.pid, 'SIGTERM'\)/,
    '要走 SIGTERM 优雅退出，直接 exit 会把 Chromium 留成孤儿进程',
  );
  // 先 spawn 新进程，再 close：反过来会有一段没有任何进程监听的窗口
  assert.ok(
    body.indexOf('spawn(exe, []') < body.indexOf('server?.close?.()'),
    '必须先拉起新进程再关闭旧监听',
  );
});

test('源码模式仍走 server-ctl.mjs，且缺文件时给出可操作的提示', () => {
  assert.match(
    source,
    /spawn\(process\.execPath, \[ctlScript, 'restart'\]/,
    '源码模式要继续用 server-ctl（带 pid 文件、pm2 检测等）',
  );
  assert.match(source, /找不到重启脚本/, '缺文件时的错误信息要保留');
  assert.match(source, /如果是打包版，这个文件不需要/, '错误信息要说明打包版不需要该脚本');
});
