import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { POW_EXPIRY_SAFETY_MS, DirectEngine, powNotExpired } from '../src/direct/client.mjs';
import { PowSolver } from '../src/direct/pow.mjs';
import { resolveExecutable } from '../src/util.mjs';

const logger = { info() {}, warn() {}, debug() {}, error() {} };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 起一个假的 DeepSeek 上游 + 真实 DirectEngine，用来黑盒验证 PoW 池行为。
 * header 里的 x-ds-pow-response 是可观测的「用了哪一发 PoW」。
 */
async function makePowHarness(t) {
  const powBin = resolveExecutable(process.env.POW_BIN || path.join(root, 'bin', 'ds-pow'));
  if (!fs.existsSync(powBin)) {
    t.skip('缺少 bin/ds-pow，先 npm run pow:build');
    return null;
  }

  const state = { challengeCount: 0, seenPowHeaders: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const json = (payload) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.url === '/api/v0/chat_session/create') {
        json({ data: { biz_data: { chat_session: { id: `sess-${Math.random()}` } } } });
        return;
      }
      if (req.url === '/api/v0/chat/create_pow_challenge') {
        state.challengeCount += 1;
        // 必须用官方 WASM 测试向量：answer=42 依赖 expire_at=1700000000 参与哈希，
        // 改成未来时间就无解（pow: no solution within difficulty）。
        // 「预解件过期」的场景靠往池里塞人造的 expireAt 来构造，不依赖上游时间。
        json({
          data: {
            biz_data: {
              challenge: {
                algorithm: 'DeepSeekHashV1',
                challenge: 'd4a2ea58c89e40887c933484868380c6f803eaa8dc53a3b9df8e431b921a4f09',
                salt: 'testsalt',
                expire_at: 1700000000,
                difficulty: 1000,
                signature: 'sig',
                target_path: '/api/v0/chat/completion',
              },
            },
          },
        });
        return;
      }
      if (req.url === '/api/v0/chat/completion') {
        state.seenPowHeaders.push(String(req.headers['x-ds-pow-response'] || ''));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ v: { response: { status: 'WIP', fragments: [{ type: 'RESPONSE', content: '来自' }] } } })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ v: '好号' })}\n\n`);
        res.write(`data: ${JSON.stringify({ p: 'response/status', o: 'SET', v: 'FINISHED' })}\n\n`);
        res.end();
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cz-dsapi-pow-'));
  const engine = new DirectEngine({
    config: {
      dataDir,
      server: {},
      browser: {},
      deepseek: {
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        tokens: ['pool-token-0123456789abcdef'],
        deviceProfile: 'chrome-win',
        humanTiming: false,
        coldStart: false,
        search: false,
      },
      direct: { powBin },
      runtime: {
        maxPromptChars: 100_000,
        accountCooldownMs: 60_000,
        rateLimitBackoffMs: 0,
        maxCooldownWaitMs: 0,
        requestTimeoutMs: 10_000,
      },
    },
    logger,
  });

  const cleanup = async () => {
    engine.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { engine, state, cleanup };
}


test('powNotExpired：正常有效期可用', () => {
  const now = 1_700_000_000_000;
  assert.equal(powNotExpired(Math.floor((now + 60_000) / 1000), now), true);
});

test('powNotExpired：已过期的 challenge 不可用', () => {
  const now = 1_700_000_000_000;
  assert.equal(powNotExpired(Math.floor((now - 1_000) / 1000), now), false);
});

test('powNotExpired：剩余不足安全余量时提前丢弃', () => {
  const now = 1_700_000_000_000;
  const almost = Math.floor((now + POW_EXPIRY_SAFETY_MS - 1) / 1000);
  assert.equal(powNotExpired(almost, now), false);
  const enough = Math.floor((now + POW_EXPIRY_SAFETY_MS + 5_000) / 1000);
  assert.equal(powNotExpired(enough, now), true);
});

test('powNotExpired：兼容毫秒时间戳', () => {
  const now = 1_700_000_000_000;
  assert.equal(powNotExpired(now + 60_000, now), true);
  assert.equal(powNotExpired(now - 60_000, now), false);
});

test('powNotExpired：服务端没给 expire_at 时保守认为可用（与旧行为一致）', () => {
  assert.equal(powNotExpired(undefined), true);
  assert.equal(powNotExpired(0), true);
  assert.equal(powNotExpired(null), true);
});

test('PoW 池：过期预解件不会让请求失败，也不会留在池里', async (t) => {
  const harness = await makePowHarness(t);
  if (!harness) return;
  const { engine, state, cleanup } = harness;
  try {
    const account = engine.pool.accounts[0];
    // 池里塞两个「已过期」的预解件：旧实现只看 shift 出来的第一个，
    // 丢掉后现场重解，池里剩下那发仍然过期 —— 下一次请求还要再解一次。
    const now = Date.now();
    account.powPool.push({ header: 'stale-1', expireAt: now - 60_000 });
    account.powPool.push({ header: 'stale-2', expireAt: now - 30_000 });
    account.powPending = null;
    account.sessionPool.length = 0;

    const result = await engine.chat({ prompt: '你好', meta: {} });
    assert.equal(result.text, '来自好号', '过期 PoW 不该导致请求失败');
    assert.ok(state.challengeCount > 0, '应该确实重新取过 challenge');
    // 池里不该再留着人造的过期件（旧的 stale-1/stale-2）
    assert.equal(
      account.powPool.some((entry) => entry.header === 'stale-1' || entry.header === 'stale-2'),
      false,
      '过期件应该被丢弃，不能留在池里等下个请求再丢一次',
    );
    assert.equal(
      state.seenPowHeaders.includes('stale-1') || state.seenPowHeaders.includes('stale-2'),
      false,
      '过期件不能被真的发出去',
    );
  } finally {
    await cleanup();
  }
});

test('PoW 池：有效期内的预解件被直接复用（不重新取 challenge）', async (t) => {
  const harness = await makePowHarness(t);
  if (!harness) return;
  const { engine, state, cleanup } = harness;
  try {
    const account = engine.pool.accounts[0];
    account.powPool.push({ header: 'fresh-header', expireAt: Date.now() + 600_000 });
    account.powPending = null;
    account.sessionPool.length = 0;

    const result = await engine.chat({ prompt: '你好', meta: {} });
    assert.equal(result.text, '来自好号');
    assert.equal(state.seenPowHeaders.includes('fresh-header'), true, '应该用上池里的预解件');
  } finally {
    await cleanup();
  }
});


test('PowSolver 能对已知 challenge 解出正确答案（ds-pow 协议回归）', async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  // Windows 上产物可能是 bin/ds-pow 或 bin/ds-pow.exe，统一交给 resolveExecutable
  const bin = resolveExecutable(process.env.POW_BIN || path.join(root, 'bin', 'ds-pow'));
  if (!fs.existsSync(bin)) {
    t.skip(`缺少 ${bin}，先运行 npm run pow:build`);
    return;
  }
  // DeepSeekHashV1("testsalt_1700000000_42") 的官方 WASM 向量（见 deepseek_pow_test.go）
  const challenge = 'd4a2ea58c89e40887c933484868380c6f803eaa8dc53a3b9df8e431b921a4f09';
  const solver = new PowSolver({ bin, logger: { debug() {}, warn() {} } });
  try {
    const solved = await solver.solve({
      challenge,
      salt: 'testsalt',
      expireAt: 1700000000,
      difficulty: 1000,
    });
    assert.equal(solved.answer, 42);
    // 注意 powd 的响应字段带 omitempty：求解快于 1ms 时 ms=0 会被省略，
    // 所以 ms 可能是 undefined（旧版协议行为，Node 侧只用于日志）。
    assert.ok(solved.ms === undefined || typeof solved.ms === 'number');
  } finally {
    solver.close();
  }
});
