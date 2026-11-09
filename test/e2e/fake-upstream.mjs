#!/usr/bin/env node
/**
 * 假 DeepSeek Web 上游（直连模式专用）。
 *
 * 照着 src/direct/client.mjs 真实调用的接口伪造响应，让整条 direct 链路可以在
 * 没有账号、没有网络的情况下端到端验证：
 *
 *   POST /api/v0/chat_session/create       → { data: { biz_data: { chat_session: { id } } } }
 *   POST /api/v0/chat/create_pow_challenge → 真 PoW 挑战（由本地 Node 求解器生成）
 *   POST /api/v0/chat/completion           → DeepSeek patch 协议 SSE
 *   POST /api/v0/file/upload_file          → { data: { biz_data: { id } } }
 *   GET  /api/v0/client/settings           → 冷启动拉配置
 *   POST /api/v0/users/auth_token/check_device
 *   POST /api/v0/client/settings/report
 *
 * 场景由 prompt 里的标记触发（与 test/helpers/fake-deepseek.mjs 保持一致）：
 *   TOOL            回答末尾带 DSML 工具调用
 *   THINK           带思考片段（THINK 在 RESPONSE 之前）
 *   FABRICATE       编造 RESULT + 无限续写（验证 I4：只清洗不中止）
 *   RATE_LIMIT      只回 event: hint 限流
 *   EMPTY           空流（触发空流重试 → RateLimitError）
 *   AUTH_FAIL       401（验证登录态失效 → AuthExpiredError / 停用账号）
 *   POW_REJECT      第一次 completion 回 40301，之后正常（验证 PoW 重发）
 */
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.FAKE_PORT || 0);

/* ------------------------------------------------------------------ *
 * DeepSeekHashV1 纯 JS 实现（与 deepseek_hash.go 逐字节等价）。
 *
 * 假上游需要**可被求解**的挑战：随机 32 字节只有 1/2^64 概率在 10^5 的搜索空间里
 * 有解，直接随机必失败。这里先随机 salt/expire_at，再反向算出一个真正的挑战：
 * 取一个 nonce，算出 prefix+nonce 的摘要，它就是「能被这组参数解出来」的目标值。
 * ------------------------------------------------------------------ */
const RATE = 136;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const MASK64 = (1n << 64n) - 1n;
const rotl = (v, k) => ((v << BigInt(k)) | (v >> BigInt(64 - k))) & MASK64;

function keccakF23(s) {
  for (let r = 1; r < 24; r += 1) {
    const c0 = s[0] ^ s[5] ^ s[10] ^ s[15] ^ s[20];
    const c1 = s[1] ^ s[6] ^ s[11] ^ s[16] ^ s[21];
    const c2 = s[2] ^ s[7] ^ s[12] ^ s[17] ^ s[22];
    const c3 = s[3] ^ s[8] ^ s[13] ^ s[18] ^ s[23];
    const c4 = s[4] ^ s[9] ^ s[14] ^ s[19] ^ s[24];
    const d0 = c4 ^ rotl(c1, 1);
    const d1 = c0 ^ rotl(c2, 1);
    const d2 = c1 ^ rotl(c3, 1);
    const d3 = c2 ^ rotl(c4, 1);
    const d4 = c3 ^ rotl(c0, 1);
    for (let i = 0; i < 25; i += 5) {
      s[i] ^= d0;
      s[i + 1] ^= d1;
      s[i + 2] ^= d2;
      s[i + 3] ^= d3;
      s[i + 4] ^= d4;
    }
    const b = new Array(25);
    b[0] = s[0];
    b[10] = rotl(s[1], 1);
    b[20] = rotl(s[2], 62);
    b[5] = rotl(s[3], 28);
    b[15] = rotl(s[4], 27);
    b[16] = rotl(s[5], 36);
    b[1] = rotl(s[6], 44);
    b[11] = rotl(s[7], 6);
    b[21] = rotl(s[8], 55);
    b[6] = rotl(s[9], 20);
    b[7] = rotl(s[10], 3);
    b[17] = rotl(s[11], 10);
    b[2] = rotl(s[12], 43);
    b[12] = rotl(s[13], 25);
    b[22] = rotl(s[14], 39);
    b[23] = rotl(s[15], 41);
    b[8] = rotl(s[16], 45);
    b[18] = rotl(s[17], 15);
    b[3] = rotl(s[18], 21);
    b[13] = rotl(s[19], 8);
    b[14] = rotl(s[20], 18);
    b[24] = rotl(s[21], 2);
    b[9] = rotl(s[22], 61);
    b[19] = rotl(s[23], 56);
    b[4] = rotl(s[24], 14);
    for (let i = 0; i < 25; i += 5) {
      s[i] = b[i] ^ (~b[i + 1] & MASK64 & b[i + 2]);
      s[i + 1] = b[i + 1] ^ (~b[i + 2] & MASK64 & b[i + 3]);
      s[i + 2] = b[i + 2] ^ (~b[i + 3] & MASK64 & b[i + 4]);
      s[i + 3] = b[i + 3] ^ (~b[i + 4] & MASK64 & b[i]);
      s[i + 4] = b[i + 4] ^ (~b[i] & MASK64 & b[i + 1]);
    }
    s[0] ^= RC[r];
  }
}

function deepseekHashV1(buf) {
  const data = Buffer.from(buf);
  const s = new Array(25).fill(0n);
  let off = 0;
  const absorb = (block) => {
    for (let i = 0; i < RATE / 8; i += 1) s[i] ^= block.readBigUInt64LE(i * 8);
    keccakF23(s);
  };
  while (off + RATE <= data.length) {
    absorb(data.subarray(off, off + RATE));
    off += RATE;
  }
  const final = Buffer.alloc(RATE);
  data.copy(final, 0, off);
  final[data.length - off] = 0x06;
  final[RATE - 1] |= 0x80;
  absorb(final);
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i += 1) out.writeBigUInt64LE(s[i], i * 8);
  return out;
}

/**
 * 造一个「在 [0, difficulty) 里确实有解」的挑战。
 * 做法：随机 salt/expire_at + 随机 nonce（限制在 difficulty 内），
 * 算出 prefix+nonce 的摘要作为 challenge —— 那么 nonce 就是它的答案。
 */
function makeSolvableChallenge(difficulty) {
  const salt = crypto.randomBytes(6).toString('hex');
  const expireAt = Math.floor(Date.now() / 1000) + 300;
  const answer = Math.floor(Math.random() * difficulty);
  const prefix = `${salt}_${expireAt}_`;
  const digest = deepseekHashV1(Buffer.from(prefix + String(answer), 'utf8'));
  return {
    algorithm: 'DeepSeekHashV1',
    challenge: digest.toString('hex'),
    salt,
    signature: crypto.randomBytes(32).toString('hex'),
    difficulty,
    expire_at: expireAt,
    target_path: '/api/v0/chat/completion',
    // 调试用：假上游自己知道答案
    _expectedAnswer: answer,
  };
}

const POW_DIFFICULTY = 100_000;


const stats = {
  sessions: 0,
  challenges: 0,
  completions: 0,
  uploads: 0,
  powRejected: 0,
  emptyRetries: 0,
  lastPrompt: '',
  lastRefFileIds: [],
  lastThinking: null,
  lastSearch: null,
  coldStart: { settings: 0, checkDevice: 0, report: 0 },
  completionHeaders: null,
  powVerified: 0,
  powBad: 0,
};

/**
 * challenge -> 期望答案。
 *
 * 引擎加载完 challenge 后会「预解下一个」（见 client.mjs 的 powPool），
 * 所以假上游可能连发两个 challenge，而 completion 用的是先前那个的答案。
 * 按 challenge 摘要建映射，才能准确校验每个 header。
 */
const expectedAnswers = new Map();

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

function ok(res, bizData) {
  return json(res, 200, { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: bizData } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 原生工具调用 token，和真实模型输出完全一致：
 *   <|tool▁calls▁begin|> … <|tool▁calls▁end|>
 * 用 String.fromCharCode 拼，避免源码里的竖线字符被编辑器/转码改动。
 */
const B = String.fromCharCode(0x3c) + String.fromCharCode(0x7c) + 'tool' + String.fromCharCode(0x2581);
const BT = String.fromCharCode(0x7c) + String.fromCharCode(0x3e);
const nativeBegin = () => B + 'calls' + String.fromCharCode(0x2581) + 'begin' + BT;
const nativeEnd = () => B + 'calls' + String.fromCharCode(0x2581) + 'end' + BT;

/** 模型「原始输出」——按 prompt 标记选场景 */
function answerFor(prompt) {
  if (prompt.includes('TOOL')) {
    return [
      '我来执行一下命令。',
      '',
      '<｜DSML｜tool_calls>',
      '<｜DSML｜invoke name="exec_shell">',
      '<｜DSML｜parameter name="command" string="true">uname -a</｜DSML｜parameter>',
      '</｜DSML｜invoke>',
      '</｜DSML｜tool_calls>',
    ].join('\n');
  }
  if (prompt.includes('FABRICATE_SECTION')) {
    // 真实原生工具 token（会被正确解析成 tool call，不算编造）+ 伪造段标题（isFabricatedBlock 会命中）
    return [
      '好的，开始调用。',
      nativeBegin(),
      '{"name":"exec_shell","arguments":{"command":"uname -a"}}',
      nativeEnd(),
      '',
      '## Tool_call_result',
      '内核版本：Linux 6.8.0',
      '',
    ].join('\n');
  }
  if (prompt.includes('FABRICATE_LOOP') || prompt.includes('FABRICATE')) {
    // 原生工具 token + RESULT:{json}：RESULT 后面真的跟着 JSON，属于 isFabricatedBlock 认定的编造
    return [
      '好的，开始调用。',
      nativeBegin(),
      '{"name":"exec_shell","arguments":{"command":"uname -a"}}',
      nativeEnd(),
      '',
      'RESULT:{"name":"exec_shell","result":"假结果"}',
      '',
    ].join('\n');
  }
  if (prompt.includes('LONG')) {
    // 2 万字符的回答，验证长流不多不少
    let s = '';
    for (let i = 0; i < 400; i += 1) s += `第${i}行：这是一段用来验证长回答流式拼接不丢字、不重复的文本。\n`;
    return s;
  }
  if (prompt.includes('ECHO')) {
    // 把 prompt 里 ## User 的内容原样回显，用来验证上下文拼接
    const at = prompt.lastIndexOf('## User');
    return at >= 0 ? prompt.slice(at + 8, at + 300).trim() : '没有找到 User 段';
  }
  return '收到，这是假上游的回答。';
}

/** 按真实补全协议产出一段 SSE：快照 → THINK → RESPONSE（逐字） → FINISHED */
async function streamCompletion(res, prompt) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  let closed = false;
  res.on('close', () => {
    closed = true;
  });
  const send = (payload) => {
    if (closed || res.writableEnded) return false;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
  };

  if (prompt.includes('RATE_LIMIT')) {
    res.write(
      `event: hint\ndata: ${JSON.stringify({
        type: 'error',
        content: '消息发送过于频繁，请稍后重试',
        clear_response: true,
        finish_reason: 'rate_limit_reached',
      })}\n\n`,
    );
    res.end();
    return;
  }
  if (prompt.includes('EMPTY')) {
    // 真实限流时常见：只回一个空的 ready，没有任何片段
    res.write('event: ready\ndata: {}\n\n');
    res.end();
    return;
  }

  send({ v: { response: { message_id: 'fake-msg-1', fragments: [] } } });
  await sleep(5);

  if (prompt.includes('THINK')) {
    send({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'THINK', content: '' }] });
    for (const ch of '先分析一下这个问题。') {
      if (!send({ p: 'response/fragments/-1/content', v: ch })) return;
      await sleep(2);
    }
  }

  send({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: '' }] });
  const answer = answerFor(prompt);
  for (const ch of answer) {
    if (!send({ p: 'response/fragments/-1/content', v: ch })) return;
    await sleep(1);
  }

  if (prompt.includes('FABRICATE')) {
    // 编造完立刻无限续写（模拟「停不下来」）
    const deadline = Date.now() + 15_000;
    while (!closed && !res.destroyed && Date.now() < deadline) {
      await sleep(20);
      if (!send({ p: 'response/fragments/-1/content', v: ' 继续写……' })) return;
    }
    if (!res.destroyed) res.end();
    return;
  }

  send({ p: 'response/accumulated_token_usage', o: 'SET', v: 1234 });
  send({ p: 'response/status', o: 'SET', v: 'FINISHED' });
  if (!res.writableEnded) res.end();
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  try {
    return JSON.parse(buf.toString('utf8') || '{}');
  } catch {
    return {};
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // ---- 冷启动序列 ----
  if (url.pathname === '/api/v0/client/settings') {
    stats.coldStart.settings += 1;
    return ok(res, { settings: [{ id: 1, value: 'a' }], banners: [] });
  }
  if (url.pathname === '/api/v0/users/auth_token/check_device') {
    stats.coldStart.checkDevice += 1;
    return ok(res, { valid: true });
  }
  if (url.pathname === '/api/v0/client/settings/report') {
    stats.coldStart.report += 1;
    return ok(res, {});
  }

  // ---- 建会话 ----
  if (url.pathname === '/api/v0/chat_session/create') {
    stats.sessions += 1;
    return ok(res, { chat_session: { id: `session-${stats.sessions}` } });
  }

  // ---- PoW 挑战 ----
  if (url.pathname === '/api/v0/chat/create_pow_challenge') {
    stats.challenges += 1;
    const { _expectedAnswer, ...challenge } = makeSolvableChallenge(POW_DIFFICULTY);
    expectedAnswers.set(challenge.challenge, _expectedAnswer);
    return ok(res, { challenge });
  }

  // ---- 上传（图片 / 溢出附件共用）----
  if (url.pathname === '/api/v0/file/upload_file') {
    if (!req.headers['x-ds-pow-response']) {
      return json(res, 400, { code: 40001, msg: 'missing pow header' });
    }
    await readBody(req);
    stats.uploads += 1;
    return ok(res, { id: `file-${stats.uploads}`, status: 'SUCCESS' });
  }

  // ---- 补全 ----
  if (url.pathname === '/api/v0/chat/completion') {
    const body = await readJson(req);
    stats.completions += 1;
    stats.lastPrompt = String(body.prompt ?? '');
    stats.lastRefFileIds = body.ref_file_ids ?? [];
    stats.lastThinking = body.thinking_enabled;
    stats.lastSearch = body.search_enabled;
    stats.completionHeaders = {
      pow: Boolean(req.headers['x-ds-pow-response']),
      auth: Boolean(req.headers.authorization),
      deviceId: Boolean(req.headers['x-device-id']),
      ua: req.headers['user-agent'],
      secChua: req.headers['sec-ch-ua'],
      // 原始头名列表，便于断言（node 保留客户端发送的原始大小写）
      keys: Object.keys(req.headers),
    };

    // 真的校验 PoW 头：解出来的 answer 必须等于假上游下发时预期的值
    if (req.headers['x-ds-pow-response']) {
      try {
        const decoded = JSON.parse(Buffer.from(req.headers['x-ds-pow-response'], 'base64').toString('utf8'));
        const expected = expectedAnswers.get(decoded.challenge);
        if (expected !== undefined && Number(decoded.answer) === expected) stats.powVerified += 1;
        else {
          stats.powBad += 1;
          stats.lastPowMismatch = {
            got: Number(decoded.answer),
            expected: expected ?? null,
            knownChallenges: expectedAnswers.size,
          };
        }
      } catch (err) {
        stats.powBad += 1;
        stats.lastPowMismatch = { error: err.message };
      }
    }

    const prompt = stats.lastPrompt;
    if (prompt.includes('AUTH_FAIL')) return json(res, 401, { code: 40100, msg: '登录态失效' });
    if (prompt.includes('POW_REJECT') && stats.completions === 1) {
      stats.powRejected += 1;
      return json(res, 400, { code: 40301, msg: 'INVALID_POW_RESPONSE' });
    }
    if (prompt.includes('EMPTY')) stats.emptyRetries += 1;

    return streamCompletion(res, prompt);
  }

  // ---- 观测接口（测试自己用）----
  if (url.pathname === '/__stats') return json(res, 200, stats);
  if (url.pathname === '/__reset') {
    for (const k of Object.keys(stats.coldStart)) stats.coldStart[k] = 0;
    for (const k of ['sessions', 'challenges', 'completions', 'uploads', 'powRejected', 'emptyRetries', 'powVerified', 'powBad']) {
      stats[k] = 0;
    }
    stats.lastPrompt = '';
    stats.lastRefFileIds = [];
    return json(res, 200, { ok: true });
  }

  json(res, 404, { code: 404, msg: `not found: ${url.pathname}` });
});

server.listen(PORT, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${port}` }));
});
