#!/usr/bin/env node
/**
 * 后台启停脚本：npm run up / down / status / logs
 *
 * 为什么不用 nohup 直接跑：这里用 detached spawn + pid 文件，
 * 保证 node 进程的父进程是 init，不会被当前终端会话回收。
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = loadConfig();
const dataDir = config.dataDir;
const pidFile = path.join(dataDir, 'server.pid');
const logFile = path.join(dataDir, 'server.log');
const url = `http://${config.server.host}:${config.server.port}`;

const action = process.argv[2] || 'status';

function readPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    if (!Number.isFinite(pid)) return null;
    process.kill(pid, 0); // 探活
    return pid;
  } catch {
    return null;
  }
}

async function health() {
  try {
    const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 进程表兜底：pid 文件可能过期，旧版本的 /healthz 又没有 pid 字段，
 * 这时直接按启动命令找本项目的 node src/index.mjs。
 */
function listenerPids() {
  try {
    const exact = path.join(root, 'src', 'index.mjs');
    const out = execFileSync('pgrep', ['-f', exact], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isFinite(pid) && pid !== process.pid);
  } catch {
    return [];
  }
}

async function waitGone(pid, timeoutMs = 8000) {
  for (let i = 0; i < timeoutMs / 200; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* 已经没了 */
  }
  return false;
}

/** 看看这个进程是不是被 pm2 之类的守护进程托管（杀了会被自动拉起） */
function supervisorOf(pid) {
  try {
    const ppid = Number.parseInt(
      execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim(),
      10,
    );
    if (!Number.isFinite(ppid) || ppid <= 1) return '';
    return execFileSync('ps', ['-o', 'comm=', '-p', String(ppid)], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function up() {
  const running = await health();
  if (running) {
    // 端口上已经有实例：把 pid 文件纠正过来，不要重复启动
    const pid = Number.isFinite(running.pid) ? running.pid : listenerPids()[0];
    if (pid) {
      fs.writeFileSync(pidFile, `${pid}\n`);
      console.log(`已经在运行：${url}（pid ${pid}）`);
      return 0;
    }
    console.error(`❌ ${url} 有响应，但找不到对应进程（旧版本 /healthz 无 pid），请手动停止`);
    return 1;
  }

  // 进程活着但 HTTP 不响应：先清掉，否则新进程会撞 EADDRINUSE
  for (const stale of listenerPids()) {
    console.log(`pid ${stale} 还在但 ${url} 无响应，先结束它`);
    try {
      process.kill(stale, 'SIGTERM');
    } catch {
      /* 已经没了 */
    }
    await waitGone(stale);
  }
  fs.rmSync(pidFile, { force: true });

  fs.mkdirSync(dataDir, { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(root, 'src', 'index.mjs')], {
    cwd: root,
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  fs.writeFileSync(pidFile, `${child.pid}\n`);

  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 250));
    const info = await health();
    if (info) {
      if (info.pid && info.pid !== child.pid) {
        console.error(`❌ 端口 ${url} 被 pid ${info.pid} 占用（不是刚启动的 ${child.pid}），先执行 down`);
        return 1;
      }
      console.log(`✅ 已启动：${url}（pid ${child.pid}）`);
      console.log(`   日志：${logFile}`);
      console.log(`   接口：${url}/v1/chat/completions`);
      return 0;
    }
    try {
      process.kill(child.pid, 0);
    } catch {
      console.error('❌ 进程退出了，看看日志：');
      console.error(fs.readFileSync(logFile, 'utf8').split('\n').slice(-20).join('\n'));
      return 1;
    }
  }
  console.error(`❌ 10 秒内没有监听 ${url}，检查端口是否被占用或日志：${logFile}`);
  return 1;
}

async function down() {
  const info = await health();
  const pids = new Set(listenerPids());
  if (Number.isFinite(info?.pid)) pids.add(info.pid);
  if (!pids.size) {
    const fromFile = readPid();
    if (fromFile) pids.add(fromFile);
  }

  if (!pids.size) {
    console.log('没有在运行的实例');
    fs.rmSync(pidFile, { force: true });
    return 0;
  }

  for (const pid of pids) {
    const supervisor = supervisorOf(pid);
    if (/pm2|supervisor|systemd/i.test(supervisor)) {
      console.log(`⚠️ pid ${pid} 由 ${supervisor} 托管：杀掉后会被自动拉起`);
      console.log('   想真正重启，请用 pm2 restart index（或对应的守护进程命令）');
    }
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* 已经没了 */
    }
    const gone = await waitGone(pid);
    console.log(gone ? `已停止（pid ${pid}）` : `强制停止（pid ${pid}）`);
  }
  fs.rmSync(pidFile, { force: true });
  return 0;
}

async function status() {
  const info = await health();
  const pid = Number.isFinite(info?.pid) ? info.pid : (readPid() ?? listenerPids()[0] ?? '未知');
  if (!info) {
    console.log(`未运行（${url} 无响应）`);
    return 1;
  }
  console.log(`运行中：${url}（pid ${pid}）`);
  console.log(JSON.stringify(info, null, 2));
  return 0;
}

const handlers = { up, down, status, start: up, stop: down };
const handler = handlers[action];
if (!handler) {
  console.log('用法：node scripts/server-ctl.mjs <up|down|status>');
  process.exit(1);
}
process.exit(await handler());
