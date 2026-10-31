import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPrompt } from '../src/prompt/build.mjs';
import { SPECIAL_TOKENS_HEADER } from '../src/prompt/special.mjs';

test('单轮：system + user，按 ## 段落拼接', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'system', content: '你是一个简洁的助手' },
      { role: 'user', content: '你好' },
    ],
  });

  assert.ok(prompt.startsWith('# MESSAGES:\n## SYSTEM_ROLE_MESSAGES\n'));
  assert.ok(prompt.includes(SPECIAL_TOKENS_HEADER));
  assert.ok(prompt.includes('你是一个简洁的助手'));
  assert.ok(prompt.includes('## USER_ROLE_MESSAGES:\n你好'));
  assert.ok(!prompt.includes('## ASSISTANT_ROLE_MESSAGES:'));
  // 不该出现空白 section
  assert.ok(!/\n{3,}/.test(prompt));
});

test('多轮：assistant 段落用 ## ASSISTANT_ROLE_MESSAGES', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'user', content: '第一步' },
      { role: 'assistant', content: '第一步的回答' },
      { role: 'user', content: '第二步' },
    ],
  });

  const order = [
    '## USER_ROLE_MESSAGES:\n第一步',
    '## ASSISTANT_ROLE_MESSAGES:\n第一步的回答',
    '## USER_ROLE_MESSAGES:\n第二步',
  ].map((needle) => prompt.indexOf(needle));

  assert.ok(order.every((i) => i >= 0), `段落缺失: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, '段落顺序不对');
  assert.ok(prompt.trimEnd().endsWith('## USER_ROLE_MESSAGES:\n第二步'));
});

test('tools：TOOL_FUNCTIONS 每行一个 JSON', () => {
  const { prompt, toolNames } = buildPrompt({
    messages: [{ role: 'user', content: '执行 ls' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'exec_shell',
          description: 'Exec shell command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      },
      { function: { name: 'read_file', description: 'Read a file' } },
    ],
  });

  assert.deepEqual(toolNames, ['exec_shell', 'read_file']);
  assert.ok(prompt.includes('## TOOL_FUNCTIONS:'));
  const section = prompt.slice(prompt.indexOf('## TOOL_FUNCTIONS:'), prompt.indexOf('## USER_ROLE_MESSAGES:'));
  const lines = section.split('\n').filter((l) => l.startsWith('{"name"'));
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.name, 'exec_shell');
  assert.equal(first.parameters.type, 'object');
  // TOOL_FUNCTIONS 必须在第一段 USER 之前
  assert.ok(prompt.indexOf('## TOOL_FUNCTIONS:') < prompt.indexOf('## USER_ROLE_MESSAGES:'));
});

test('tool 结果单独成段，RESULT 不出现在 assistant 段落里', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'user', content: '看看内核' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec_shell', arguments: '{"command":"uname -a"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'exec_shell', content: 'Linux ubuntu 6.1' },
      { role: 'user', content: '解释一下' },
    ],
  });

  const assistantAt = prompt.indexOf('## ASSISTANT_ROLE_MESSAGES:');
  const toolResultAt = prompt.indexOf('## TOOL_RESULT_MESSAGES:');
  const doAt = prompt.lastIndexOf('DO:{"name":"exec_shell"');
  const resultAt = prompt.lastIndexOf('RESULT:{');
  const nextUserAt = prompt.lastIndexOf('## USER_ROLE_MESSAGES:');

  assert.ok(assistantAt > 0 && doAt > assistantAt && toolResultAt > doAt);
  // 历史里的调用只允许 DO 块，不能退回 DSML / <tool_call> 等原生格式
  assert.ok(prompt.includes('DO:{"name":"exec_shell","args":{"command":"uname -a"}}'));
  assert.ok(!prompt.includes('<|DSML|'));
  assert.ok(!prompt.includes('<tool_call>'));
  assert.ok(resultAt > toolResultAt && nextUserAt > resultAt);

  // 模型模仿的是自己的段落：这里绝不能出现 RESULT
  const assistantBody = prompt.slice(assistantAt, toolResultAt);
  assert.ok(!assistantBody.includes('RESULT'), `assistant 段落混入了 RESULT:\n${assistantBody}`);

  const result = JSON.parse(prompt.slice(resultAt + 'RESULT:'.length, prompt.indexOf('\n', resultAt)));
  assert.equal(result.name, 'exec_shell');
  assert.equal(result.result, 'Linux ubuntu 6.1');
});

test('连续多个 tool 结果合并到同一个 TOOL_RESULT 段', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'user', content: '查两样' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'a', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'a', content: '结果 A' },
      { role: 'tool', tool_call_id: 'call_2', name: 'b', content: '结果 B' },
    ],
  });

  const occurrences = prompt.match(/## TOOL_RESULT_MESSAGES:/g) ?? [];
  assert.equal(occurrences.length, 1);
  assert.ok(prompt.includes('RESULT:{"name":"b","result":"结果 B"}'));
  // 最后一段是工具结果时，段尾要有「直接回答」提示
  assert.match(prompt, /以上结果由系统注入/);
});

test('systemExtra 追加在 SYSTEM 段末尾', () => {
  const { prompt } = buildPrompt({
    messages: [{ role: 'user', content: '你好' }],
    systemExtra: '额外约束：不要输出 RESULT。',
  });
  assert.ok(prompt.indexOf('额外约束：不要输出 RESULT。') < prompt.indexOf('## USER_ROLE_MESSAGES:'));
  assert.ok(prompt.includes('额外约束'));
});

test('content parts 数组会被拼起来', () => {
  const { prompt } = buildPrompt({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '第一段' },
          { type: 'text', text: '第二段' },
        ],
      },
    ],
  });
  assert.ok(prompt.includes('第一段\n第二段'));
});

test('图片部分不进入 prompt 正文（由附件上传单独处理）', () => {
  const { prompt } = buildPrompt({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看图' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
  });
  assert.match(prompt, /看图/);
  assert.ok(!prompt.includes('base64'), '图片数据不能拼进 prompt');
});

test('空 messages 报错', () => {
  assert.throws(() => buildPrompt({ messages: [] }), /messages 不能为空/);
});

test('协议声明：只教 DO，不展示 DSML 语法，也不恐吓用户', () => {
  assert.match(SPECIAL_TOKENS_HEADER, /DO:\{"name":/);
  assert.match(SPECIAL_TOKENS_HEADER, /不要输出 DSML、XML/);
  assert.ok(!SPECIAL_TOKENS_HEADER.includes('封禁'));
  // 只说不许用，不展示任何原生格式的语法
  assert.ok(!SPECIAL_TOKENS_HEADER.includes('<|DSML|'));
  assert.ok(!SPECIAL_TOKENS_HEADER.includes('<|tool'));
  assert.ok(!SPECIAL_TOKENS_HEADER.includes('<tool_call>'));
});

test('assistant 历史里的 tool_calls 只渲染成 DO 块', () => {
  const { prompt } = buildPrompt({
    messages: [
      { role: 'user', content: '看下内核和 hosts' },
      {
        role: 'assistant',
        content: '好的',
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'exec_shell', arguments: '{"command":"uname -r"}' } },
          { id: 'b', type: 'function', function: { name: 'read_file', arguments: '{"path":"/etc/hosts"}' } },
        ],
      },
    ],
  });

  assert.match(prompt, /好的\nDO:\{"name":"exec_shell","args":\{"command":"uname -r"\}\}/);
  assert.match(prompt, /DO:\{"name":"read_file","args":\{"path":"\/etc\/hosts"\}\}/);
  // 历史里绝不能出现 DSML / native 调用格式
  assert.ok(!prompt.includes('<|DSML|'));
  assert.ok(!prompt.includes('<tool_call>'));
});
