import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPrompt } from '../src/prompt/build.mjs';
import { planOverflow } from '../src/prompt/overflow.mjs';
import { SPECIAL_TOKENS_HEADER } from '../src/prompt/special.mjs';

const long = (tag, n) => `${tag}：${'x'.repeat(n)}`;

function multiTurnPrompt(turns = 6, size = 2000) {
  const messages = [];
  for (let i = 0; i < turns; i += 1) {
    messages.push({ role: 'user', content: long(`问题${i}`, size) });
    messages.push({ role: 'assistant', content: long(`回答${i}`, size) });
  }
  messages.push({ role: 'user', content: '最后一个问题：用一句话总结' });
  const { prompt } = buildPrompt({ messages, tools: [{ type: 'function', function: { name: 'exec_shell' } }] });
  return prompt;
}

test('未超限：原样返回，不产生附件', () => {
  const { prompt } = buildPrompt({ messages: [{ role: 'user', content: '你好' }] });
  const plan = planOverflow(prompt, { maxChars: 100_000 });
  assert.equal(plan.prompt, prompt);
  assert.equal(plan.attachment, null);
});

test('超限：较早对话进附件，正文保留最新段落并在预算内', () => {
  const prompt = multiTurnPrompt();
  assert.ok(prompt.length > 10_000);

  const plan = planOverflow(prompt, { maxChars: 10_000 });
  const text = plan.attachment.buffer.toString('utf8');

  assert.ok(plan.prompt.length <= 10_000, `正文应该压到上限内: ${plan.prompt.length}`);
  assert.match(plan.prompt, /## CONTEXT_ATTACHMENT:/);
  assert.match(plan.prompt, /最后一个问题：用一句话总结/);
  // 自带协议提示词永远留在正文
  assert.ok(plan.prompt.includes(SPECIAL_TOKENS_HEADER.trim()));
  assert.ok(!plan.prompt.includes('问题0：'), '最早的问题应该离开正文');
  assert.match(text, /问题0：/);
  assert.match(text, /## User:/);
  assert.match(text, /## Assistant:/);
  assert.match(plan.attachment.name, /^context-[0-9a-f]{8}\.txt$/);
  assert.equal(plan.attachment.mime, 'text/plain');
  assert.ok(plan.attachment.sections > 0);
  assert.equal(plan.attachment.chars, text.length);
});

test('超限：客户端 system 过大时移进附件，协议提示词和最新对话留在正文', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'system', content: 'SYSSTART-' + 's'.repeat(30_000) + '-SYSEND' },
      { role: 'user', content: '你好' },
    ],
    tools: [{ type: 'function', function: { name: 'exec_shell' } }],
  });

  const plan = planOverflow(prompt, { maxChars: 6000 });
  const text = plan.attachment.buffer.toString('utf8');

  assert.ok(plan.prompt.length <= 6000, `正文超限: ${plan.prompt.length}`);
  assert.ok(plan.prompt.includes(SPECIAL_TOKENS_HEADER.trim()), '协议提示词必须留在正文');
  assert.match(plan.prompt, /## CONTEXT_ATTACHMENT:/);
  assert.match(plan.prompt, /## User:\n你好/);
  assert.ok(!plan.prompt.includes('SYSSTART'), '客户端 system 应该进附件');
  assert.match(text, /SYSSTART/);
});

test('超限：工具声明过大时也能移进附件', () => {
  const bigSchema = {
    type: 'function',
    function: {
      name: 'exec_shell',
      description: 'BIGTOOLS-' + 'd'.repeat(30_000) + '-BIGTOOLS',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
    },
  };
  const { prompt } = buildPrompt({
    messages: [{ role: 'user', content: '你好' }],
    tools: [bigSchema],
  });

  const plan = planOverflow(prompt, { maxChars: 6000 });
  const text = plan.attachment.buffer.toString('utf8');

  assert.ok(plan.prompt.length <= 6000, `正文超限: ${plan.prompt.length}`);
  assert.ok(plan.prompt.includes(SPECIAL_TOKENS_HEADER.trim()));
  assert.match(plan.prompt, /## CONTEXT_ATTACHMENT:/);
  assert.ok(!plan.prompt.includes('BIGTOOLS'), '工具声明应该进附件');
  assert.match(text, /BIGTOOLS/);
});

test('最后一段自己就超长：保留尾部，前面进附件', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'user', content: '读一个大文件' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: `BIGSTART-${'y'.repeat(30_000)}-BIGEND` },
    ],
    tools: [{ type: 'function', function: { name: 'read_file' } }],
  });

  const plan = planOverflow(prompt, { maxChars: 8000 });
  const text = plan.attachment.buffer.toString('utf8');

  assert.ok(plan.prompt.length <= 8000, `正文超限: ${plan.prompt.length}`);
  assert.ok(!plan.prompt.includes('BIGSTART'), '开头应该在附件里');
  assert.match(plan.prompt, /BIGEND/);
  assert.match(text, /BIGSTART/);
  assert.match(plan.prompt, /continued below/);
});

test('附件超过上限时报错', () => {
  const prompt = multiTurnPrompt(6, 5000);
  assert.throws(() => planOverflow(prompt, { maxChars: 8000, maxAttachmentChars: 5000 }), /MAX_ATTACHMENT_CHARS|超过上限/);
});

test('连协议提示词都放不下时报错', () => {
  const { prompt } = buildPrompt({
    messages: [{ role: 'user', content: 'x'.repeat(20_000) }],
  });
  assert.throws(() => planOverflow(prompt, { maxChars: 1500 }), /无法保留任何对话内容|超过上限/);
});
