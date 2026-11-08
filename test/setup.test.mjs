import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { createEngine } from '../src/engine.mjs';
import { createServer } from '../src/server.mjs';
import { createLogger } from '../src/logger.mjs';
import { makeConfig } from './helpers/browser.mjs';

/**
 * 「首次配置」相关行为。
 *
 * 背景：以前缺 token 会让进程直接退出，于是 Web 控制台永远打不开 ——
 * 而配置 token 的功能恰恰在控制台里，形成死锁。现在改为：
 *   - 服务照常启动，引擎换成 UnconfiguredEngine；
 *   - 只有真正发对话请求时才报 400，并指向控制台；
 *   - /healthz 暴露 hasToken，控制台据此引导用户。
 */

const logger = createLogger('error');

const noTokenConfig = (overrides = {}) => {
  const config = makeConfig({
    DEEPSEEK_USER_TOKEN: '',
    DEEPSEEK_USER_TOKENS: '',
    ENGINE: 'direct',
    WARMUP: 'false',
    ...overrides,
  });
  // makeConfig 可能从 data/auth.json 读到真实 token，这里强制清空
  config.deepseek.tokens = [];
  config.deepseek.token = '';
  return config;
};

/** 起一个真实 server，跑完自动关掉 */
async function withServer(config, fn) {
  const web = createEngine({ config, logger });
  const server = createServer({ config, logger, web });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn({ base, web, server });
  } finally {
    server.close();
    await web.close?.().catch(() => {});
  }
}

test('未配置 token 时也能创建引擎：返回 unconfigured 占位而不是抛错', () => {
  const engine = createEngine({ config: noTokenConfig(), logger });
  assert.equal(engine.status().engine, 'unconfigured');
  assert.equal(engine.status().needsSetup, true);
  // 引擎契约必须齐全，否则 server 侧会崩
  for (const method of ['status', 'warmUp', 'close', 'chat']) {
    assert.equal(typeof engine[method], 'function', `缺少 ${method}()`);
  }
});

test('未配置 token 时占位引擎的 warmUp/close 不抛错', async () => {
  const engine = createEngine({ config: noTokenConfig(), logger });
  await engine.warmUp();
  await engine.close();
});

test('未配置 token 时 /healthz 可访问并标记 hasToken=false', async () => {
  await withServer(noTokenConfig(), async ({ base }) => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.hasToken, false);
    assert.equal(body.engine, 'unconfigured');
    assert.equal(body.needsSetup, true);
  });
});

test('未配置 token 时对话请求返回 400 且提示指向控制台（不是 500）', async () => {
  await withServer(noTokenConfig(), async ({ base }) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 400, '配置缺失属于用户侧问题，应该是 400 而不是 500');
    const text = await res.text();
    assert.match(text, /admin/, '提示里要告诉用户去控制台配置');
    assert.match(text, /登录态|userToken/);
  });
});

test('未配置 token 时流式请求在 SSE 帧里给出同样的错误', async () => {
  await withServer(noTokenConfig(), async ({ base }) => {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    // SSE 一旦开始发头就没法再改状态码了，所以这里是 200 + 错误帧，
    // 这是 SSE 协议的固有限制（非流式才是 400）。
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"error"/, '错误要以 data 帧的形式下发');
    assert.match(text, /admin/, '错误帧里同样要指向控制台');
    assert.match(text, /deepseek_auth_required/);
    assert.match(text, /\[DONE\]/, '错误之后也要正常结束流');
  });
});

test('未配置 token 时 Anthropic 端点返回 Anthropic 格式的错误', async () => {
  await withServer(noTokenConfig(), async ({ base }) => {
    const res = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    // Anthropic 的错误体形状：{ type: 'error', error: { type, message } }
    assert.equal(body.type, 'error');
    assert.ok(body.error?.message, '要有 message');
  });
});

test('未配置 token 时控制台静态页与账号接口仍可用（配置入口不能锁死）', async () => {
  // 这个测试需要 web/dist 已构建；没构建时跳过，避免在干净仓库里误报
  const distIndex = path.join(import.meta.dirname, '..', 'web', 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    return;
  }
  await withServer(noTokenConfig(), async ({ base }) => {
    const page = await fetch(`${base}/admin/`);
    assert.equal(page.status, 200, '控制台是唯一的配置入口，必须能打开');

    const accounts = await fetch(`${base}/admin/api/accounts`);
    assert.equal(accounts.status, 200, '账号接口必须可用，否则无法配置 token');
  });
});

test('已配置 token 时不再进入未配置状态', async () => {
  const config = makeConfig({ ENGINE: 'auto', WARMUP: 'false', DEEPSEEK_USER_TOKEN: 'x'.repeat(32) });
  config.deepseek.tokens = ['x'.repeat(32)];
  config.deepseek.token = 'x'.repeat(32);
  const engine = createEngine({ config, logger });
  assert.notEqual(engine.status().needsSetup, true);
  await engine.close?.().catch(() => {});
});
