#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [, , command = 'serve', ...rest] = process.argv;

const help = `
deepseek-web-api —— 把 chat.deepseek.com 包装成 OpenAI 兼容 API

用法：
  deepseek-web-api serve            启动服务（默认，等价 npm start）
  deepseek-web-api auth [userToken] 写入并校验登录态
  deepseek-web-api smoke            端到端冒烟测试
  deepseek-web-api help             显示帮助

环境变量见 .env.example / README.md
`;

const run = (file, args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, file), ...args], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 0));
  });

let code = 0;
if (command === 'serve' || command === 'start') code = await run('src/index.mjs', rest);
else if (command === 'auth') code = await run('scripts/auth.mjs', rest);
else if (command === 'smoke') code = await run('scripts/smoke.mjs', rest);
else if (command === 'help' || command === '--help' || command === '-h') console.log(help);
else {
  console.error(`未知命令: ${command}`);
  console.log(help);
  code = 1;
}
process.exit(code);
