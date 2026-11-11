import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { detectRuntimeMode } from '../src/admin/routes.mjs';

/**
 * 「重启」的运行形态分派。
 *
 * 真实重启需要 spawn 新进程 + 抢端口，不适合在单元测试里跑（会污染测试环境、
 * 也可能残留进程）。这里锁住两件事：
 *   1. detectRuntimeMode() 的判定结果（纯函数，直接测行为，不做源码文本匹配）；
 *   2. 各分支的关键结构不变。
 *
 * 真实行为已在打包产物上手工验证：direct 与 browser 两种引擎重启后 pid 都变化、
 * 旧进程干净退出、无孤儿 headless_shell。
 */

const source = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'admin', 'routes.mjs'),
  'utf8',
);

/* ------------------------------------------------------------------ *
 * 判定逻辑（行为测试）
 * ------------------------------------------------------------------ */

test('源码运行：node + node src/index.mjs → source', () => {
  assert.equal(
    detectRuntimeMode({ execPath: '/usr/bin/node', env: {}, existsSync: () => false }),
    'source',
  );
});

test('打包 exe：CZDSAPI_ROOT 存在 → packaged（即使 execPath 叫 node）', () => {
  assert.equal(
    detectRuntimeMode({ execPath: '/usr/bin/node', env: { CZDSAPI_ROOT: '/opt/cz' }, existsSync: () => false }),
    'packaged',
  );
});

test('打包 exe：execPath 不是 node → packaged', () => {
  assert.equal(
    detectRuntimeMode({ execPath: 'C:\\app\\cz-dsapi.exe', env: {}, existsSync: () => false }),
    'packaged',
  );
  assert.equal(
    detectRuntimeMode({ execPath: '/usr/local/bin/cz-dsapi', env: {}, existsSync: () => false }),
    'packaged',
  );
});

test('Docker：/.dockerenv 存在 → docker（不能落到 source）', () => {
  assert.equal(
    detectRuntimeMode({
      execPath: '/usr/local/bin/node',
      env: {},
      existsSync: (p) => p === '/.dockerenv',
    }),
    'docker',
  );
});

test('Docker：CZDSAPI_DOCKER=1 → docker（非标准运行时的兜底）', () => {
  assert.equal(
    detectRuntimeMode({ execPath: '/usr/local/bin/node', env: { CZDSAPI_DOCKER: '1' }, existsSync: () => false }),
    'docker',
  );
});

test('Docker 判定必须优先于 source：否则会去调用根本不存在的 server-ctl', () => {
  const mode = detectRuntimeMode({
    execPath: '/usr/local/bin/node',
    env: {},
    existsSync: (p) => p === '/.dockerenv',
  });
  assert.notEqual(mode, 'source', '容器里的 execPath 也叫 node，绝不能因此判成源码运行');
  assert.equal(mode, 'docker');
});

test('existsSync 抛错时不炸，按非容器处理', () => {
  assert.equal(
    detectRuntimeMode({
      execPath: '/usr/bin/node',
      env: {},
      existsSync: () => {
        throw new Error('EACCES');
      },
    }),
    'source',
  );
});

/* ------------------------------------------------------------------ *
 * 结构：各分支的关键步骤
 * ------------------------------------------------------------------ */

test('重启会区分三种运行形态', () => {
  assert.match(source, /const mode = detectRuntimeMode\(\)/, '必须用 detectRuntimeMode 判定');
  assert.match(source, /mode === 'packaged' \|\| mode === 'docker'/, '打包版与容器必须走自重启');
  assert.match(source, /return restartSelf\(mode\)/, '自重启要能拿到形态（容器需要补 index.mjs 参数）');
});

test('自重启分支不依赖 scripts/server-ctl.mjs（发行包与镜像里都没有 scripts/）', () => {
  const start = source.indexOf('async function restartSelf');
  assert.ok(start > 0, 'restartSelf 必须存在');
  const body = source.slice(start);
  assert.doesNotMatch(body.slice(0, body.indexOf('\n  }\n')), /server-ctl/, '自重启分支不能引用只存在于源码树里的脚本');
});

test('Docker 分支要给 node 补上 src/index.mjs（镜像里 execPath 就是 node）', () => {
  assert.match(
    source,
    /mode === 'docker' \? \[path\.join\(rootDir, 'src', 'index\.mjs'\)\] : \[\]/,
    '容器里 spawn(node, []) 会打开 REPL 并立刻退出，必须显式传入口',
  );
});

test('打包 exe 仍用「exe + 空参数」启动，不传脚本路径', () => {
  assert.match(source, /spawn\(exe, args, \{/, '统一走 args');
  assert.match(source, /: \[\]/, '打包形态的 args 必须是空数组');
});

test('自重启先释放端口再退出，且走优雅关闭', () => {
  const start = source.indexOf('async function restartSelf');
  const body = source.slice(start);
  assert.match(body, /server\?\.close\?\.\(\)/, '要先 close server 释放端口，否则新进程 EADDRINUSE');
  assert.match(
    body,
    /process\.kill\(process\.pid, 'SIGTERM'\)/,
    '要走 SIGTERM 优雅退出，直接 exit 会把 Chromium 留成孤儿进程',
  );
  assert.ok(
    body.indexOf('spawn(exe, args') < body.indexOf('server?.close?.()'),
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
