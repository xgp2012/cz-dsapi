#!/usr/bin/env node
/**
 * 跨平台跑测试。
 *
 * 为什么不用 `node --test 'test/**\/*.test.mjs'`：
 *   npm 在 Windows 上走 cmd.exe，cmd 不做 glob 展开，也不会去掉引号，
 *   因此 Node 收到的是字面量 'test/**\/*.test.mjs' —— 单 `*` 分段可以匹配，
 *   但不同 Node 版本行为不一致；更糟的是 PowerShell 下直接 `npm test`
 *   会出现 0 个用例"静默通过"的假绿（见 docs/DEVELOPMENT.md §14.2 / T1）。
 *
 * 这里在 Node 里自己展开，再显式把文件列表传给 `node --test`，
 * 保证任何 shell 下跑的都是同一批文件。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testDir = path.join(root, 'test');

function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (entry.name.endsWith('.test.mjs')) out.push(full);
  }
  return out;
}

const files = collect(testDir).sort();

if (files.length === 0) {
  console.error('没有找到任何 test/**/*.test.mjs，检查 test/ 目录');
  process.exit(1);
}

// 允许透传额外参数：npm test -- --test-name-pattern="DSML"
const extra = process.argv.slice(2);
// --test-concurrency=1 只让"测试文件之间"串行，同一文件内的顶层 test()
// 仍然并发。浏览器用例每个都要起一只真实 Chromium（单个 3~6 秒），
// 并发跑会互相抢 CPU/内存，导致本应通过的用例随机超时。
// 这些都跑真实浏览器的文件因此逐个文件单独跑（每个文件内部仍并发）。
const BROWSER_HEAVY = [/driver\.test\.mjs$/, /browser-.*\.test\.mjs$/];
const isHeavy = (file) => BROWSER_HEAVY.some((re) => re.test(file));

if (extra.length === 0) {
  const heavy = files.filter(isHeavy);
  const light = files.filter((f) => !isHeavy(f));
  const groups = [{ files: light, concurrency: 1 }, ...heavy.map((f) => ({ files: [f], concurrency: 1 }))];

  let failed = false;
  for (const group of groups) {
    const code = await runNode(group);
    if (code !== 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
}

const code = await runNode({ files, concurrency: 1 });
process.exit(code);

function runNode({ files: subset, concurrency }) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--test', `--test-concurrency=${concurrency}`, ...extra, ...subset],
      { cwd: root, stdio: 'inherit' },
    );
    child.on('exit', (code2, signal) => {
      if (signal) process.kill(process.pid, signal);
      else resolve(code2 ?? 1);
    });
  });
}
