import { ApiError } from '../errors.mjs';
import { contentToText } from '../util.mjs';
import { FINAL_ANSWER_HINT, PROMPT_HEADER, SECTION, SPECIAL_TOKENS_HEADER, TOOL_CALL_REMINDER } from './special.mjs';
import { collectToolNames, renderToolDeclarations, renderToolResult } from './tools.mjs';

const VALID_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function']);

/**
 * 把 OpenAI messages 拼成网页输入框里的一条 prompt。
 *
 * 输出形状（一次请求 = 一次全新对话，模型只能靠这些段落判断上下文）：
 *
 *   # MESSAGES:
 *   ## SYSTEM_ROLE_MESSAGES
 *   <特殊 token 声明 + 调用方传入的 system + 工具格式重申>
 *
 *   ## TOOL_FUNCTIONS:
 *   {"name":"exec_shell","description":"..."}
 *
 *   ## USER_ROLE_MESSAGES:
 *   你好
 *
 *   ## ASSISTANT_ROLE_MESSAGES:
 *   你好！有什么可以帮你？
 *
 *   ## <|TOOL_CALL_RESULT|>:
 *   RESULT:{"name":"exec_shell","result":"Linux"}
 *
 *   ## USER_ROLE_MESSAGES:
 *   解释一下
 *
 * 注意工具结果的归属：它**单独成段**，不塞进 ASSISTANT_ROLE_MESSAGES。
 * 模型看到的历史里，自己的段落永远只有正文和 DO 调用行，不会出现 RESULT，
 * 这样它就不会把「assistant 说 DO 然后自己写 RESULT」当成正确的模仿对象。
 */
export function buildPrompt({ messages, tools = [], systemExtra = '' }) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError(400, 'messages 不能为空', { code: 'invalid_messages' });
  }

  const systemTexts = [];
  /** @type {{role: 'user'|'assistant'|'toolResult', lines: string[]}[]} */
  const sections = [];

  for (const [index, message] of messages.entries()) {
    const role = message?.role;
    if (!VALID_ROLES.has(role)) {
      throw new ApiError(400, `messages[${index}].role 不合法: ${JSON.stringify(role)}`, {
        code: 'invalid_role',
        param: `messages[${index}].role`,
      });
    }

    if (role === 'system' || role === 'developer') {
      const text = contentToText(message.content, role).trim();
      if (text) systemTexts.push(text);
      continue;
    }

    if (role === 'user') {
      sections.push({ role: 'user', lines: [contentToText(message.content, 'user')] });
      continue;
    }

    if (role === 'assistant') {
      const lines = [];
      const text = contentToText(message.content, 'assistant');
      if (text.trim()) lines.push(text);
      for (const call of message.tool_calls ?? []) {
        const fn = call?.function ?? {};
        if (!fn.name) continue;
        lines.push(renderToolCall(fn.name, fn.arguments));
      }
      if (!lines.length) lines.push('');
      sections.push({ role: 'assistant', lines });
      continue;
    }

    // tool / function 结果：单独成段，绝不并进 assistant 段落
    const name = message.name || findLastToolName(sections) || 'unknown';
    const resultLine = renderToolResult(name, contentToText(message.content, role));
    const last = sections.at(-1);
    if (last?.role === 'toolResult') last.lines.push(resultLine);
    else sections.push({ role: 'toolResult', lines: [resultLine] });
  }

  const lastSection = sections.at(-1);
  if (lastSection?.role === 'toolResult') {
    // 提示放在结果段末尾：模型接着往下写时，最后看到的是「现在该直接回答」
    lastSection.lines.push('', FINAL_ANSWER_HINT);
  }

  const parts = [PROMPT_HEADER, SECTION.system, SPECIAL_TOKENS_HEADER.trimEnd()];
  const extra = typeof systemExtra === 'string' ? systemExtra.trim() : '';
  if (systemTexts.length || extra) {
    // 调用方的 system 与「额外约束」都放在协议声明之后，越靠后约束力越强
    parts.push('', [...systemTexts, extra].filter(Boolean).join('\n\n'));
  }
  // 客户端 SYSTEM prompt 的末尾：长上下文时重申只认 DO: 格式，把注意力拉回开头协议
  parts.push('', TOOL_CALL_REMINDER);

  const toolLines = renderToolDeclarations(tools);
  if (toolLines.length) {
    parts.push('', SECTION.tools, ...toolLines);
  }

  for (const section of sections) {
    const body = section.lines.join('\n').trim();
    parts.push('', SECTION[section.role], body);
  }

  const prompt = parts.join('\n').trimEnd();

  return {
    prompt,
    systemTexts,
    toolNames: collectToolNames(tools),
    stats: {
      chars: prompt.length,
      sections: sections.length,
      systemMessages: systemTexts.length,
      tools: toolLines.length,
    },
  };
}

function findLastToolName(sections) {
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    for (let j = sections[i].lines.length - 1; j >= 0; j -= 1) {
      const line = sections[i].lines[j];
      if (line.startsWith('DO:')) {
        try {
          return JSON.parse(line.slice(3)).name;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 把一次工具调用渲染成 DO 行，历史里给模型看的唯一调用格式 */
function renderToolCall(name, args) {
  let parsed = {};
  if (typeof args === 'string') {
    try {
      const value = JSON.parse(args);
      parsed = value && typeof value === 'object' && !Array.isArray(value) ? value : { input: value };
    } catch {
      parsed = { input: args };
    }
  } else if (args && typeof args === 'object') {
    parsed = args;
  }

  return `DO:${JSON.stringify({ name, args: parsed })}`;
}