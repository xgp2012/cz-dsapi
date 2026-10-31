#!/usr/bin/env node
/**
 * 端到端冒烟测试：真的起一个 HTTP 服务，走 /v1/chat/completions。
 *
 *   npm run smoke                     # 非流式 + 流式 + 多轮 + 工具调用
 *   npm run smoke -- --only stream    # 只跑某一项
 */
import http from 'node:http';

import { loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/logger.mjs';
import { createServer } from '../src/server.mjs';
import { createEngine } from '../src/engine.mjs';

const only = (() => {
  const i = process.argv.indexOf('--only');
  return i > -1 ? process.argv[i + 1] : null;
})();

const config = loadConfig();
const logger = createLogger(config.logLevel, 'smoke');
const web = createEngine({ config, logger });
const server = createServer({ config, logger, web });

if (!config.deepseek.token) {
  logger.error('没有 token：先执行 npm run auth -- <userToken>');
  process.exit(1);
}

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}`;
logger.info(`临时服务：${url}`);

const api = (path, body) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

let failures = 0;
const check = (name, ok, extra = '') => {
  if (ok) logger.info(`✅ ${name}${extra ? ` ${extra}` : ''}`);
  else {
    failures += 1;
    logger.error(`❌ ${name}${extra ? ` ${extra}` : ''}`);
  }
};

async function runNonStream() {
  const started = Date.now();
  const res = await api('/v1/chat/completions', {
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: '只回复两个字：收到' }],
  });
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content ?? '';
  check('非流式返回内容', content.length > 0, `(${Date.now() - started}ms) ${JSON.stringify(content.slice(0, 60))}`);
  check('finish_reason', json.choices?.[0]?.finish_reason === 'stop', json.choices?.[0]?.finish_reason);
  return json;
}

async function runStream() {
  const started = Date.now();
  const res = await api('/v1/chat/completions', {
    model: 'deepseek-flash',
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: 'user', content: '数到五，每个数字之间用空格' }],
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let firstTokenAt = 0;
  let sawDone = false;
  let usage = null;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = raw.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') {
        sawDone = true;
        continue;
      }
      const chunk = JSON.parse(payload);
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        if (!firstTokenAt) firstTokenAt = Date.now();
        content += delta;
      }
    }
  }

  check('流式输出内容', content.length > 0, `${JSON.stringify(content.slice(0, 60))}`);
  check('收到 [DONE]', sawDone);
  check('首字延迟', firstTokenAt > 0, `${firstTokenAt - started}ms`);
  check('include_usage', Boolean(usage), usage ? `total=${usage.total_tokens}` : '');
  return content;
}

async function runMultiTurn() {
  const res = await api('/v1/chat/completions', {
    model: 'deepseek-flash',
    messages: [
      { role: 'system', content: '你是一个只回答数字的助手' },
      { role: 'user', content: '记住这个数字：731' },
      { role: 'assistant', content: '好的，我记住了：731' },
      { role: 'user', content: '我刚才让你记住的数字是多少？只回答数字' },
    ],
  });
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content ?? '';
  check('多轮上下文拼接', content.includes('731'), JSON.stringify(content.slice(0, 80)));
}

async function runTools() {
  const res = await api('/v1/chat/completions', {
    model: 'deepseek-flash',
    messages: [{ role: 'user', content: '请用 exec_shell 工具执行命令：uname -a' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'exec_shell',
          description: 'Exec shell command',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string', description: '要执行的命令' } },
            required: ['command'],
          },
        },
      },
    ],
  });
  const json = await res.json();
  const calls = json.choices?.[0]?.message?.tool_calls ?? [];
  check(
    '工具调用解析',
    calls.length > 0 && calls[0].function?.name === 'exec_shell',
    calls.length ? `args=${calls[0].function.arguments}` : '没有解析到 DO:',
  );
}

const tests = [
  ['non-stream', runNonStream],
  ['stream', runStream],
  ['multi-turn', runMultiTurn],
  ['tools', runTools],
];

try {
  for (const [name, fn] of tests) {
    if (only && only !== name) continue;
    logger.info(`--- ${name} ---`);
    await fn();
  }
} catch (err) {
  logger.error('冒烟测试异常:', err.message);
  failures += 1;
} finally {
  server.close();
  await web.close().catch(() => {});
}

if (failures) {
  logger.error(`${failures} 项失败`);
  process.exit(1);
}
logger.info('全部通过 🎉');
