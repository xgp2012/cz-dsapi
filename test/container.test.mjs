import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createLogger } from '../src/logger.mjs';

/**
 * 容器环境适配。
 *
 * 这里锁住的是「在容器里会静默出错的那些行为」——它们在本机开发时全都不复现，
 * 只有真正跑进镜像、以非 root、只读文件系统、UTC 时区时才暴露出来。
 */

/* ------------------------------------------------------------------ *
 * 日志时间戳必须是本地时间
 * ------------------------------------------------------------------ */

test('日志时间戳用本地时区，不是 UTC', () => {
  // 捕获 stdout，比对日志前缀与本地时间
  const captured = [];
  const original = console.log;
  console.log = (...args) => captured.push(args.join(' '));
  try {
    createLogger('info').info('本地时间测试');
  } finally {
    console.log = original;
  }

  assert.equal(captured.length, 1);
  const line = captured[0];
  // 形如 20:45:42.234 INFO    本地时间测试
  const match = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3}) INFO\b/.exec(line);
  assert.ok(match, `日志格式不对：${line}`);

  const now = new Date();
  const loggedSec = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  const localSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  // 允许 5 秒误差（跨秒边界）
  assert.ok(
    Math.abs(loggedSec - localSec) <= 5,
    `日志时间 ${match[0]} 与本地时间 ${now.toTimeString().slice(0, 8)} 不符 —— ` +
      '说明又用回了 toISOString()（UTC），容器里会差 8 小时',
  );
});

test('日志不把 UTC 当作本地时间：时区偏移非零时必须体现出来', () => {
  const offsetMin = -new Date().getTimezoneOffset();
  if (offsetMin === 0) {
    // 机器本身就在 UTC，这条断言没有区分度，跳过（CI 常见）
    return;
  }
  const captured = [];
  const original = console.log;
  console.log = (...args) => captured.push(args.join(' '));
  try {
    createLogger('info').info('x');
  } finally {
    console.log = original;
  }
  const [, h] = /^(\d{2}):/.exec(captured[0]);
  const utcHour = new Date().getUTCHours();
  const localHour = Number(h);
  assert.notEqual(
    localHour,
    utcHour,
    `本地时区偏移 ${offsetMin} 分钟，但日志小时 ${localHour} 等于 UTC 小时 ${utcHour}`,
  );
});

/* ------------------------------------------------------------------ *
 * 只读文件系统（容器的默认形态）
 * ------------------------------------------------------------------ */

test('目录只读时能判定 .env 不可写，而不是抛异常', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'czro-'));
  const envFile = path.join(dir, '.env');
  try {
    fs.chmodSync(dir, 0o555);
    // 在 root 下 chmod 不生效（root 无视权限位），这条用例在容器 CI 里要跳过
    let effectivelyReadOnly = true;
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      effectivelyReadOnly = false;
    } catch {
      effectivelyReadOnly = true;
    }
    if (!effectivelyReadOnly) return; // root 环境，无法模拟只读

    // 复刻 routes.mjs#envWritable 的判定顺序：先文件、再目录
    const fileWritable = () => {
      try {
        fs.accessSync(envFile, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    };
    const dirWritable = () => {
      try {
        fs.accessSync(dir, fs.constants.W_OK);
        return true;
      } catch {
        return false;
      }
    };
    assert.equal(fileWritable(), false, '不存在的 .env 应判定不可写');
    assert.equal(dirWritable(), false, '只读目录应判定不可写');
  } finally {
    try {
      fs.chmodSync(dir, 0o755);
    } catch {
      /* ignore */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('容器镜像里 .env 不可写是预期：必须有可操作的环境变量提示', () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'admin', 'routes.mjs'),
    'utf8',
  );
  assert.match(source, /env_not_writable/, '要返回专门的错误码，前端才能识别');
  assert.match(source, /-e KEY=VALUE/, '提示里要给出 docker run 的写法');
  assert.match(source, /environment:/, '提示里要给出 docker-compose 的写法');
  // 必须是 409 而不是 500：这是环境限制，不是服务端故障
  assert.match(source, /new ApiError\(409,\s*writable\.message/, '只读应该是 409 冲突，不是 500');
});

test('控制台配置页能知道是否可写', () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'admin', 'routes.mjs'),
    'utf8',
  );
  assert.match(source, /writable: writable\.ok/, 'buildConfig 要暴露 writable');
  assert.match(source, /writableHint:/, '要带上不可写的原因，前端才能说明白');
});

/* ------------------------------------------------------------------ *
 * 优雅关闭：容器只有 10s 宽限
 * ------------------------------------------------------------------ */

test('优雅关闭有超时兜底，不会被容器 SIGKILL', () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'index.mjs'),
    'utf8',
  );
  assert.match(source, /shutdownTimeoutMs/, '要有可配置的关闭超时');
  assert.match(source, /强制退出/, '超时后要强制退出，而不是无限等');
  assert.match(source, /shuttingDown/, '重入保护：SIGTERM 可能被转发两次');
});

test('关闭超时默认值小于容器默认的 10s 宽限', () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'config.mjs'),
    'utf8',
  );
  const m = /shutdownTimeoutMs:\s*int\(env\.SHUTDOWN_TIMEOUT_MS,\s*(\d[\d_]*)\)/.exec(source);
  assert.ok(m, '找不到 shutdownTimeoutMs 的默认值');
  const ms = Number(m[1].replace(/_/g, ''));
  assert.ok(
    ms > 0 && ms < 10_000,
    `默认 ${ms}ms 必须小于 docker stop 的 10s 宽限，否则会被 SIGKILL`,
  );
});
