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

/**
 * 容器里「网页改配置」是否可用。
 *
 * 历史：早期版本写回 /app/.env，在容器里必然失败（root 只读），
 * 于是这里断言过 env_not_writable 这条错误码。
 *
 * 现在改成了写 data/settings.json（数据卷可写），所以这个能力在容器里**应该可用**，
 * 旧断言反而成了过时的枷锁。下面锁的是新契约：
 *   - 保存目标在数据目录里，而不是只读的 /app；
 *   - 权限不足时仍然返回 409（而不是 500）。
 */
test('配置保存在数据目录（容器里可写），而不是只读的 /app/.env', () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'admin', 'routes.mjs'),
    'utf8',
  );
  assert.match(source, /const target = config\.settingsFile/, '保存目标必须是 settingsFile');
  assert.doesNotMatch(source, /envFile\s*=\s*path\.join\(rootDir, '\.env'\)[\s\S]{0,200}writeFileSync/,
    '不能再往 /app/.env 写');
});

test('配置目录不可写时返回 409 并给出可操作的提示', () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'admin', 'routes.mjs'),
    'utf8',
  );
  assert.match(source, /settings_not_writable/, '要有专门的错误码');
  assert.match(source, /cz-dsapi-data:\/app\/data/, '提示里要给出数据卷的挂载写法');
  // 409 而不是 500：这是环境限制，不是服务端故障
  assert.match(source, /new ApiError\(\s*409,/, '不可写应该是 409 冲突，不是 500');
});

test('控制台配置页能知道是否可写', () => {
  const source = fs.readFileSync(
    path.join(import.meta.dirname, '..', 'src', 'admin', 'routes.mjs'),
    'utf8',
  );
  assert.match(source, /const writable = settingsWritable\(config\.settingsFile\)/, '要用 settingsWritable 探测');
  assert.match(source, /writable[,:]/, 'buildConfig 要暴露 writable');
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
