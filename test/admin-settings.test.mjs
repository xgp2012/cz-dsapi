import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 配置页 schema 的自洽性守卫。
 *
 * 两条最容易坏、且坏了很难发现的地方：
 *
 *   1. ENV_SCHEMA 里加了一项，但 currentEffective() 忘了加对应映射
 *      → 那一项在页面上显示为空白，用户以为没设置过，保存时还可能被空串覆盖。
 *      （开发过程中真实发生过：schema 加到 51 项时 mapping 还停在 19 项）
 *
 *   2. 保存目标是 .env 而不是 settings.json
 *      → 容器里写不进去；就算写进去也会被环境变量盖住，静默失效。
 */

const routesSrc = fs.readFileSync(
  path.join(import.meta.dirname, '..', 'src', 'admin', 'routes.mjs'),
  'utf8',
);

test('ENV_SCHEMA 的每一项都在 currentEffective 里有映射', () => {
  const schemaKeys = [...routesSrc.matchAll(/key: '([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]);

  const block = /function currentEffective\(key\) \{[\s\S]*?return mapping\[key\];/.exec(routesSrc);
  assert.ok(block, '找不到 currentEffective 实现');

  const mappingKeys = [...block[0].matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]);

  const missing = schemaKeys.filter((k) => !mappingKeys.includes(k));
  assert.deepEqual(
    missing,
    [],
    `以下配置项在页面上会显示为空白（currentEffective 缺映射）：${missing.join(', ')}`,
  );
});

test('schema 不存在重复键', () => {
  const schemaKeys = [...routesSrc.matchAll(/key: '([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]);
  const dup = schemaKeys.filter((k, i) => schemaKeys.indexOf(k) !== i);
  assert.deepEqual(dup, [], `schema 里有重复键：${[...new Set(dup)].join(', ')}`);
});

test('所有环境变量键名合法（大写字母数字下划线）', () => {
  const schemaKeys = [...routesSrc.matchAll(/key: '([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1]);
  for (const k of schemaKeys) {
    assert.match(k, /^[A-Z][A-Z0-9_]*$/, `键名格式不合法：${k}`);
  }
});

test('配置保存到 settings.json，而不是 .env', () => {
  assert.match(routesSrc, /const target = config\.settingsFile/, '保存目标必须是 settingsFile');
  assert.match(routesSrc, /saveSettings\(target, next\)/, '必须调用 saveSettings');

  // 旧的 .env 写入路径必须已经移除（否则容器里会继续静默失败）
  assert.doesNotMatch(routesSrc, /function writeEnvFile/, '.env 写入函数应已删除');
  assert.doesNotMatch(routesSrc, /写入 \.env 失败/, '不应再有 .env 写入错误分支');
  assert.doesNotMatch(routesSrc, /env_not_writable/, '只读的是 .env 这个概念已经过时');
});

test('密码类字段的掩码值不会被当成真值保存', () => {
  // API_KEY 在页面上显示为 ••••••••；用户只改别的项时浏览器会把掩码提交回来。
  // 若不识别，重启后鉴权 KEY 就变成了那串圆点。
  assert.match(
    routesSrc,
    /item\.type === 'password' && typeof raw === 'string' && \/\^\[•\*\]\+\$\/\.test\(raw\.trim\(\)\)/,
    '必须识别掩码并跳过保存',
  );
  assert.match(routesSrc, /continue;/, '识别到掩码后应跳过该项，而不是写入');
});

test('空值 = 恢复默认（从设置文件里删掉该键）', () => {
  assert.match(
    routesSrc,
    /if \(v === ''\) delete next\[k\];/,
    '空串必须删除键、回落到环境变量，否则用户永远无法「恢复默认」',
  );
});
