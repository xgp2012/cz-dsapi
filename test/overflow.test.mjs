import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPrompt } from '../src/prompt/build.mjs';
import { planOverflow } from '../src/prompt/overflow.mjs';

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

test('超限：较早段落进附件，正文保留最新段落并在预算内', () => {
  const prompt = multiTurnPrompt();
  assert.ok(prompt.length > 10_000);

  const plan = planOverflow(prompt, { maxChars: 10_000 });
  const text = plan.attachment.buffer.toString('utf8');

  assert.ok(plan.prompt.length <= 10_000, `正文应该压到上限内: ${plan.prompt.length}`);
  assert.match(plan.prompt, /## CONTEXT_ATTACHMENT:/);
  assert.match(plan.prompt, /最后一个问题：用一句话总结/);
  assert.ok(!plan.prompt.includes('问题0：'), '最早的问题应该离开正文');
  assert.match(text, /问题0：/);
  assert.match(text, /## USER_ROLE_MESSAGES:/);
  assert.match(plan.attachment.name, /^context-[0-9a-f]{8}\.txt$/);
  assert.equal(plan.attachment.mime, 'text/plain');
  assert.ok(plan.attachment.sections > 0);
  assert.equal(plan.attachment.chars, text.length);
});

test('超限：system 段和工具声明始终留在正文', () => {
  const prompt = multiTurnPrompt(8, 3000);
  const plan = planOverflow(prompt, { maxChars: 12_000 });
  assert.match(plan.prompt, /## SYSTEM_ROLE_MESSAGES/);
  assert.match(plan.prompt, /## TOOL_FUNCTIONS:/);
  assert.match(plan.prompt, /"name":"exec_shell"/);
  assert.ok(plan.prompt.indexOf('## TOOL_FUNCTIONS:') < plan.prompt.indexOf('## CONTEXT_ATTACHMENT:'));
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
  assert.match(plan.prompt, /本段较长/);
  // 工具结果段的收尾提示不能被拆丢
  assert.match(plan.prompt, /以上结果由系统注入/);
});

test('附件超过上限时报错', () => {
  const prompt = multiTurnPrompt(6, 5000);
  assert.throws(() => planOverflow(prompt, { maxChars: 8000, maxAttachmentChars: 5000 }), /MAX_ATTACHMENT_CHARS|超过上限/);
});

test('system 本身过长、没有可拆段落时报错', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'system', content: 's'.repeat(20_000) },
      { role: 'user', content: '你好' },
    ],
  });
  assert.throws(() => planOverflow(prompt, { maxChars: 6000 }), /system \/ 工具声明|没有空间/);
});
