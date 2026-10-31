import crypto from 'node:crypto';

import { PromptTooLongError } from '../errors.mjs';

/**
 * 超长上下文 → 附件注入。
 *
 * 网页版输入框单次最多 10 万字（超了接口直接报错）。但聊天接口的 `ref_file_ids`
 * 可以挂附件，而附件不占输入框长度，所以把「较早的对话」拆成一个 .txt 传上去，
 * 正文只保留 system + 工具声明 + 最近的段落，再在正文里放一段说明。
 *
 * 拆分原则：
 * - 只切在 ## USER/ASSISTANT/TOOL_RESULT 段落边界上，不切碎单条消息；
 * - 保留**最新的**段落（真正要回答的问题在最后），较早的进附件；
 * - 万一最后一段自己就超长，保留它的尾部，前面部分进附件；
 * - 正文再留一点余量（reserve），给重试时的额外约束文案用。
 */

const SECTION_START = /\n## (?:USER_ROLE_MESSAGES:|ASSISTANT_ROLE_MESSAGES:|<|TOOL_CALL_RESULT|>:)/g;

const DEFAULT_RESERVE = 1024;
const NAME_PREFIX = 'context-';
/** 固定长度的占位文件名：先按它算预算，最后换成真实 hash 名，长度不变 */
const PLACEHOLDER = `${NAME_PREFIX}00000000.txt`;

/**
 * @param {string} prompt buildPrompt 生成的完整 prompt
 * @param {{ maxChars?: number, maxAttachmentChars?: number, reserve?: number }} [options]
 * @returns {{ prompt: string, attachment: null | { name: string, mime: string, buffer: Buffer, chars: number, sections: number } }}
 */
export function planOverflow(prompt, options = {}) {
  const {
    maxChars = 100_000,
    maxAttachmentChars = 2_000_000,
    reserve = DEFAULT_RESERVE,
  } = options;

  if (prompt.length <= maxChars) return { prompt, attachment: null };

  // 找到第一段对话的起点；system / TOOL_FUNCTIONS 必须留在正文里
  SECTION_START.lastIndex = 0;
  const first = SECTION_START.exec(prompt);
  if (!first) {
    throw new PromptTooLongError(
      `prompt 有 ${prompt.length} 字符，超过上限 ${maxChars}，且没有可拆分的对话段落（system / 工具声明本身过长）`,
    );
  }

  const head = prompt.slice(0, first.index);
  const sections = [];
  SECTION_START.lastIndex = first.index + 1;
  let match;
  let start = first.index;
  while ((match = SECTION_START.exec(prompt)) !== null) {
    sections.push(prompt.slice(start, match.index));
    start = match.index;
  }
  sections.push(prompt.slice(start));

  const budget = maxChars - reserve - head.length - buildNote(PLACEHOLDER, sections.length).length;
  if (budget <= 0) {
    throw new PromptTooLongError(
      `system + 工具声明已占 ${head.length} 字符（上限 ${maxChars}），没有空间保留对话内容`,
    );
  }

  // 从后往前尽可能多地保留整段
  let keepFrom = sections.length;
  let keptChars = 0;
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    if (keptChars + sections[i].length > budget) break;
    keptChars += sections[i].length;
    keepFrom = i;
  }

  let attachmentBody;
  let makeTail;
  let removedCount;

  if (keepFrom === sections.length) {
    // 最后一段自己就超预算：保留尾部，前面进附件
    const last = sections.at(-1);
    const headerEnd = last.indexOf('\n', 1);
    const header = headerEnd === -1 ? '' : last.slice(0, headerEnd);
    const body = headerEnd === -1 ? last : last.slice(headerEnd);
    // 用最大的 cut 位数估 marker 长度，宁保守勿超限
    const markerMax = buildMarker(PLACEHOLDER, body.length).length;
    const keep = budget - header.length - markerMax;
    if (keep < 200) {
      throw new PromptTooLongError(
        `最后一段有 ${last.length} 字符，超过正文可用空间 ${budget}，无法拆分`,
      );
    }
    let cut = Math.max(0, body.length - keep);
    const line = body.indexOf('\n', cut);
    if (line !== -1 && line - cut < 200) cut = line + 1;
    attachmentBody = sections.slice(0, -1).join('') + header + body.slice(0, cut);
    removedCount = sections.length;
    makeTail = (name) => `${header}${buildMarker(name, cut)}${body.slice(cut)}`;
  } else {
    attachmentBody = sections.slice(0, keepFrom).join('');
    removedCount = keepFrom;
    makeTail = () => sections.slice(keepFrom).join('');
  }

  if (!attachmentBody.trim()) {
    throw new PromptTooLongError('没有可拆分到附件的内容');
  }
  if (attachmentBody.length > maxAttachmentChars) {
    throw new PromptTooLongError(
      `需要放进附件的上下文有 ${attachmentBody.length} 字符，超过上限 ${maxAttachmentChars}（可用 MAX_ATTACHMENT_CHARS 调整）`,
    );
  }

  // 附件正文不含文件名，文件名由内容 hash 决定
  const attachmentText = `${buildAttachmentTitle(removedCount)}${attachmentBody}`;
  const name = fileNameFor(attachmentText);
  const note = buildNote(name, removedCount);
  const inline = `${head}${note}${makeTail(name)}`;

  if (inline.length > maxChars) {
    throw new PromptTooLongError(
      `拆分后正文仍有 ${inline.length} 字符，超过上限 ${maxChars}（可用 MAX_PROMPT_CHARS 调整）`,
    );
  }

  return {
    prompt: inline,
    attachment: {
      name,
      mime: 'text/plain',
      buffer: Buffer.from(attachmentText, 'utf8'),
      chars: attachmentText.length,
      sections: removedCount,
    },
  };
}

function fileNameFor(text) {
  const hash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
  return `${NAME_PREFIX}${hash}.txt`;
}

function buildNote(name, sections) {
  return [
    '',
    '## CONTEXT_ATTACHMENT:',
    `本次上下文较长，较早的 ${sections} 段对话已作为附件「${name}」上传。`,
    '附件使用与正文相同的 ## 段落格式（USER_ROLE_MESSAGES / ASSISTANT_ROLE_MESSAGES / <|TOOL_CALL_RESULT|>）。',
    '请先阅读附件，把它当作本次对话的早期历史，再接续下面的段落回答。不要向用户提及附件或本说明。',
    '',
  ].join('\n');
}

function buildMarker(name, cut) {
  return `\n（本段较长，前 ${cut} 字在附件 ${name} 中，以下为续）\n`;
}

function buildAttachmentTitle(sections) {
  return [
    '# 对话历史（较早部分）',
    '',
    `这是本次对话中较早的 ${sections} 段，因为超出网页输入框长度上限，被拆到本文件。`,
    '段落格式与正文一致：## USER_ROLE_MESSAGES / ## ASSISTANT_ROLE_MESSAGES / ## <|TOOL_CALL_RESULT|>。',
    '',
  ].join('\n');
}
