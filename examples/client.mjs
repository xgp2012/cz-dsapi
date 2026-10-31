#!/usr/bin/env node
/**
 * 最小客户端示例：直接和本地服务聊两句，演示流式输出与多轮上下文。
 *
 *   node examples/client.mjs
 *   BASE_URL=http://127.0.0.1:8787 node examples/client.mjs
 */
const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:8787';
const API_KEY = process.env.API_KEY || '';

async function chat(messages, { stream = true } = {}) {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
    },
    body: JSON.stringify({ model: 'deepseek-flash', messages, stream }),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  if (!stream) {
    const json = await res.json();
    return json.choices[0].message.content;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') return content;
      const chunk = JSON.parse(payload);
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        content += delta;
        process.stdout.write(delta);
      }
    }
  }
  return content;
}

const history = [];
for (const question of ['用三句话介绍一下 QUIC 协议', '它和 TCP 最大的区别是什么？']) {
  console.log(`\n> ${question}\n`);
  history.push({ role: 'user', content: question });
  const answer = await chat(history);
  history.push({ role: 'assistant', content: answer });
  console.log('\n');
}
