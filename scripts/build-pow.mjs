#!/usr/bin/env node
/** 编译 Go 版 PoW 求解器：go build -o bin/ds-pow ./cmd/powd */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  process.env.GO_BIN,
  'go',
  path.join(process.env.HOME || '', '.local', 'go', 'bin', 'go'),
  '/usr/local/go/bin/go',
  // Windows 上 go 的默认安装位置
  'C:\\Program Files\\Go\\bin\\go.exe',
  'C:\\Go\\bin\\go.exe',
].filter(Boolean);

const go = candidates.find((bin) => {
  try {
    return spawnSync(bin, ['version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
});

if (!go) {
  console.error('找不到 Go 工具链。安装 Go 1.21+ 后重试，或把 GO_BIN 指向 go 可执行文件。');
  process.exit(1);
}

fs.mkdirSync(path.join(root, 'bin'), { recursive: true });

// Windows 上 Go 的 -o 不会自动补 .exe，而 Node 的 spawn 对"带路径的完整文件名"也不按
// PATHEXT 补扩展名 → 直接产出 bin/ds-pow 会让后端报 spawn ENOENT。
// 这里显式带上 .exe；src/util.mjs#resolveExecutable 仍兼容没有扩展名的旧产物。
const outName = process.platform === 'win32' ? 'ds-pow.exe' : 'ds-pow';
const outPath = path.join(root, 'bin', outName);

const result = spawnSync(go, ['build', '-o', outPath, './cmd/powd'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CGO_ENABLED: '0' },
});
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`✅ 已生成 ${path.relative(root, outPath)}`);
