import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SETTINGS_FILENAME,
  loadSettings,
  overlaySettings,
  saveSettings,
  settingsPath,
  settingsWritable,
} from '../src/settings-store.mjs';

/**
 * 网页设置持久化。
 *
 * 这一组守的是「用户明确要求的所有配置网页可改」能否真正成立。
 * 最危险的失败模式是**静默失效**：页面说「已保存」，重启后却没生效。
 * 所以优先级顺序（网页 > 环境变量）必须有断言钉住。
 */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cz-settings-'));
}

test('保存后能读回，值保持原本类型', () => {
  const dir = tmpDir();
  try {
    const file = settingsPath(dir);
    saveSettings(file, { CONCURRENCY: 8, ENGINE: 'browser', WARMUP: false });
    const { values, broken } = loadSettings(file);
    assert.equal(broken, false);
    assert.deepEqual(values, { CONCURRENCY: 8, ENGINE: 'browser', WARMUP: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('文件不存在时返回空设置，不报错（首次启动的正常情况）', () => {
  const dir = tmpDir();
  try {
    const { values, broken } = loadSettings(settingsPath(dir));
    assert.deepEqual(values, {});
    assert.equal(broken, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('文件损坏时标记 broken 且不抛异常', () => {
  const dir = tmpDir();
  try {
    const file = settingsPath(dir);
    fs.writeFileSync(file, '{ 这不是 json');
    const { values, broken } = loadSettings(file);
    assert.equal(broken, true, '损坏必须能被识别，否则用户不知道配置被忽略了');
    assert.deepEqual(values, {}, '损坏时当作没有用户设置，让服务仍能启动');

    // 数组 / null 等结构错误也算损坏
    fs.writeFileSync(file, '[1,2,3]');
    assert.equal(loadSettings(file).broken, true);
    fs.writeFileSync(file, 'null');
    assert.equal(loadSettings(file).broken, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('手改出的嵌套值会被丢弃，只保留标量', () => {
  const dir = tmpDir();
  try {
    const file = settingsPath(dir);
    fs.writeFileSync(file, JSON.stringify({ A: 'x', B: 1, C: true, D: { deep: 1 }, E: [1] }));
    const { values } = loadSettings(file);
    assert.deepEqual(values, { A: 'x', B: 1, C: true }, '嵌套结构不能漏进来把后续逻辑搞崩');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('写入是原子的：中途失败不会留下半截文件', () => {
  const dir = tmpDir();
  try {
    const file = settingsPath(dir);
    saveSettings(file, { ENGINE: 'direct' });
    const before = fs.readFileSync(file, 'utf8');

    // 造一个必然失败的写入（值含循环引用，JSON.stringify 会抛）
    const circular = {};
    circular.self = circular;
    assert.throws(() => saveSettings(file, circular));

    assert.equal(fs.readFileSync(file, 'utf8'), before, '失败后旧文件必须完好无损');
    // 不能留下临时文件
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, [], `不应残留临时文件：${leftovers.join(', ')}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('overlaySettings：网页设置覆盖环境变量，且不污染 process.env', () => {
  const env = { CONCURRENCY: '2', ENGINE: 'direct' };
  const merged = overlaySettings(env, { CONCURRENCY: 8, ENGINE: 'browser' });

  assert.equal(merged.CONCURRENCY, '8', '必须转成字符串（loadConfig 按 env 字符串解析）');
  assert.equal(merged.ENGINE, 'browser');
  assert.equal(env.CONCURRENCY, '2', '不能改坏传入的原始 env 对象');

  // 空值不覆盖：空串的语义是「恢复默认」，不是「设成空」
  const merged2 = overlaySettings({ A: 'keep' }, { A: '' });
  assert.equal(merged2.A, 'keep', '空串表示回落到环境变量，不能覆盖成空');
});

test('settingsWritable：目录可写时返回 true', () => {
  const dir = tmpDir();
  try {
    assert.equal(settingsWritable(settingsPath(dir)), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('文件名固定为 settings.json（文档和排障都依赖它）', () => {
  assert.equal(SETTINGS_FILENAME, 'settings.json');
  assert.equal(settingsPath('/app/data'), path.join('/app/data', 'settings.json'));
});
