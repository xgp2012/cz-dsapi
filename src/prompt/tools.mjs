/**
 * 工具声明 / 调用解析。
 *
 * 约定（与网页 prompt 中的 ## Tool_functions 段落一致）：
 *   {"name":"exec_shell","description":"Exec shell command","parameters":{...}}
 *
 * 模型输出工具调用只走一种语法：**原生 DSML**（XML 风格调用，见 dsml.mjs）。
 * 解析层把它转成标准 tool_calls / tool_use，再从 content / SSE 里剔除；
 * 历史里绝不回写 DSML，只写 ## Tool_calls 段的 JSON 行。
 *
 * 为了不丢调用，<tool_call> JSON 和 <|tool▁calls▁begin|> 这类原生工具 token 仍然静默兜底解析，
 * 但不再区分、也不再记日志（它们不是对外协议，只是容错）。
 */

import { parseDsmlCalls } from './dsml.mjs';

/** 把 OpenAI tools 定义渲染成「每行一个 JSON」的工具列表 */
export function renderToolDeclarations(tools = []) {
  const lines = [];
  for (const tool of tools) {
    const fn = tool?.function ?? tool;
    if (!fn || typeof fn.name !== 'string' || !fn.name.trim()) continue;
    const decl = { name: fn.name.trim() };
    if (fn.description) decl.description = String(fn.description);
    if (fn.parameters && typeof fn.parameters === 'object') decl.parameters = fn.parameters;
    lines.push(JSON.stringify(decl));
  }
  return lines;
}

/** 从文本里读取一个以 `{` 开头的完整 JSON 对象（考虑字符串与转义） */
export function readJsonObject(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // 还没输出完，或者格式坏了
}

/**
 * 旧版 DO 行（`DO:{"name":...}`）的容错解析。
 *
 * 新协议里 prompt / 历史都不再出现 DO（历史调用走 ## Tool_calls 的 JSON 行），
 * 这里保留只是兜底：万一模型/旧客户端还吐 DO，不丢调用、也不报错、不记日志。
 */
const DO_PATTERN = /\bDO\b[ \t*_`~]{0,6}[:：=][ \t*_`~]{0,6}\s*/g;

/** <tool_call>{...}</tool_call>（也认 <tool_calls>；流式截断时缺闭合标签就把后面整段当 body） */
const XML_TOOL_PATTERN = /<tool_calls?\b[^>]*>([\s\S]*?)(?:<\/tool_calls?>|$)/gi;

/** 原生工具 token：`<|tool▁calls▁begin|>`、`<|tool_calls|>`、`<|tool▁sep|>` 之类 */
const NATIVE_TOKEN_SOURCE = '<\\|[^|<>\\r\\n]{0,64}tool[^|<>\\r\\n]{0,64}\\|>';
const NATIVE_TOKEN_PATTERN = new RegExp(NATIVE_TOKEN_SOURCE, 'gi');
const NATIVE_TOKEN_AT = new RegExp(`^(?:${NATIVE_TOKEN_SOURCE})`, 'i');

/** 参数对象键排序后再序列化，方便不同格式的等价调用去重 / 比较 */
export function canonicalArguments(args) {
  try {
    return stableStringify(JSON.parse(args));
  } catch {
    return typeof args === 'string' ? args : JSON.stringify(args ?? {});
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** JSON.parse 的宽松版：修掉裸换行 / 尾随逗号再试一次（模型手写的 JSON 常见） */
function parseJsonLoose(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // 继续尝试修复
  }
  try {
    return JSON.parse(repairJsonText(raw));
  } catch {
    return null;
  }
}

/** 转义字符串里的裸控制字符，并去掉对象 / 数组末尾多余的逗号 */
function repairJsonText(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

/** 读出 `{` 开头的对象并宽松解析；不是对象 / 还没闭合就返回 null */
function readJsonValue(text, start) {
  if (text[start] !== '{') return null;
  const raw = readJsonObject(text, start);
  return raw ? parseJsonLoose(raw) : null;
}

/**
 * 把解析出来的 JSON 归一成 { name, args }。
 * 兼容 OpenAI 风格 `{"function":{"name":...,"arguments":...}}` 包一层的情况。
 */
function normalizeCallObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fn =
    value.function && typeof value.function === 'object' && !Array.isArray(value.function)
      ? value.function
      : value;
  const name = typeof fn.name === 'string' ? fn.name.trim() : '';
  if (!name) return null;
  return { name, args: fn.args ?? fn.arguments ?? value.args ?? value.arguments ?? {} };
}

/** <tool_call> 里的 body：整个 JSON、截断的 JSON、后面跟着解释文字都尽量读出来 */
function parseToolCallBody(body) {
  const trimmed = typeof body === 'string' ? body.trim() : '';
  if (!trimmed) return null;
  const braceAt = trimmed[0] === '{' ? 0 : trimmed.indexOf('{');
  if (braceAt < 0) return null;
  return normalizeCallObject(readJsonValue(trimmed, braceAt));
}

/** 跳过原生 token / `function` 关键字 / ```json 围栏，落到真正的 JSON 上 */
function skipNativeLead(text, from) {
  let i = from;
  for (let step = 0; step < 16; step += 1) {
    while (i < text.length && /\s/.test(text[i])) i += 1;

    const token = NATIVE_TOKEN_AT.exec(text.slice(i, i + 96));
    if (token) {
      i += token[0].length;
      continue;
    }

    const fence = /^```[a-zA-Z0-9_+-]{0,10}[ \t]*\r?\n?/.exec(text.slice(i, i + 24));
    if (fence) {
      i += fence[0].length;
      continue;
    }

    const keyword = /^(?:function|name)[ \t]*[:：=]?[ \t]*["']?/i.exec(text.slice(i, i + 24));
    if (keyword) {
      i += keyword[0].length;
      continue;
    }
    break;
  }
  return i;
}

/** 原生格式里工具名写在 JSON 前面：`function<|tool▁sep|>get_weather` */
function nativeNameBefore(text, from, to) {
  let window = text.slice(from, to);
  if (!window.trim()) return '';
  // 去掉 JSON 前面的代码围栏（```json\n），否则会把 "json" 当成函数名
  window = window.replace(/```[a-zA-Z0-9_+-]*[ \t]*\r?\n?[ \t]*$/, '');
  const match = /([A-Za-z_$][\w$.-]{0,63})[ \t\r\n]*$/.exec(window);
  if (!match) return '';
  const name = match[1];
  if (/^(?:function|name|tool|tools|json|arguments|args)$/i.test(name)) return '';
  return name;
}

/**
 * 原生工具 token 的兜底解析。两种形态都认：
 * 1. token 后面直接跟带 name / arguments 的 JSON；
 * 2. 真·原生格式：`function<|tool▁sep|>工具名` 在前，JSON 只是 arguments。
 */
function parseNativeToolCalls(text, add) {
  NATIVE_TOKEN_PATTERN.lastIndex = 0;
  let token;
  while ((token = NATIVE_TOKEN_PATTERN.exec(text)) !== null) {
    const tokenEnd = token.index + token[0].length;

    // 形态 1：token 后面就是完整 JSON（名字在 JSON 里）
    const jsonAt = skipNativeLead(text, tokenEnd);
    const directRaw = readJsonObject(text, jsonAt);
    const direct = directRaw ? normalizeCallObject(parseJsonLoose(directRaw)) : null;
    if (direct) {
      add(direct.name, normalizeArguments(direct.args), text.slice(token.index, jsonAt + directRaw.length), token.index);
      continue;
    }

    // 形态 2：JSON 只是参数，工具名在 JSON 前面
    const braceAt = text.indexOf('{', tokenEnd);
    if (braceAt < 0 || braceAt - tokenEnd > 600) continue;
    const argsRaw = readJsonObject(text, braceAt);
    if (!argsRaw) continue;
    const argsValue = parseJsonLoose(argsRaw);
    if (!argsValue || typeof argsValue !== 'object' || Array.isArray(argsValue)) continue;
    const name = nativeNameBefore(text, tokenEnd, braceAt);
    if (!name) continue;
    add(name, normalizeArguments(argsValue), text.slice(token.index, braceAt + argsRaw.length), token.index);
  }
}

/**
 * 解析模型回复中的工具调用。
 *
 * 顺序：DSML（唯一对外语法）→ <tool_call> → 原生 token → 旧版 DO 兜底；
 * 最终按出现位置排序，用 canonicalArguments 去重
 * （同一次调用被模型用两种格式重复写出来时只保留一次）。
 *
 * @param {string} text
 * @param {string[]} [knownTools] 已知工具名，用于过滤误伤
 * @returns {{ name: string, arguments: string, raw: string, index: number }[]}
 */
export function parseToolCalls(text, knownTools = null) {
  if (!text || typeof text !== 'string') return [];
  const allowed = knownTools ? new Set(knownTools) : null;
  const calls = [];
  const seen = new Set();

  const add = (name, args, raw, index) => {
    if (!name) return;
    if (allowed && !allowed.has(name)) return;
    const argsJson = normalizeArguments(args);
    const signature = `${name}\u0000${canonicalArguments(argsJson)}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    calls.push({ name, arguments: argsJson, raw, index });
  };

  // 1) DSML：唯一对外语法（全角 / 半角竖线、截断都能解析）
  for (const call of parseDsmlCalls(text, allowed)) {
    add(call.name, call.arguments, call.raw, call.index);
  }

  // 2) <tool_call>{...}</tool_call>：缺闭合标签时按截断处理
  XML_TOOL_PATTERN.lastIndex = 0;
  let xml;
  while ((xml = XML_TOOL_PATTERN.exec(text)) !== null) {
    const call = parseToolCallBody(xml[1]);
    if (!call) continue;
    add(call.name, call.args, xml[0], xml.index);
  }

  // 3) 原生工具 token（<|tool▁calls▁begin|> 之类）兜底
  parseNativeToolCalls(text, add);

  // 4) 旧版 DO 行：只做静默兜底，不记日志、不回写历史
  DO_PATTERN.lastIndex = 0;
  let match;
  while ((match = DO_PATTERN.exec(text)) !== null) {
    const raw = readJsonObject(text, match.index + match[0].length);
    const call = raw ? normalizeCallObject(parseJsonLoose(raw)) : null;
    if (!call) continue;
    add(call.name, call.args, `DO:${raw}`, match.index);
  }

  return calls.sort((a, b) => a.index - b.index);
}

/**
 * 有些模型在原生格式（DSML / <tool_call> / 原生 token / 旧版 DO）里会把包装对象原样塞进参数：
 *
 *   {"name":"bash","args":{"description":"...","command":"..."}}
 *   {"name":"bash","args":"{\"description\":...,\"command\":...}"}
 *
 * 上层拿到的应该是真正的参数对象，而不是这层包装。这里只在「键正好是 name + args/arguments」
 * 时才拆，避免误伤本来就有 name / args 字段的工具。
 */
export function unwrapCallArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const keys = Object.keys(value);
  if (!keys.every((key) => key === 'name' || key === 'args' || key === 'arguments')) return value;
  if (typeof value.name !== 'string' || !value.name.trim()) return value;
  if (!('args' in value) && !('arguments' in value)) return value;

  let inner = 'args' in value ? value.args : value.arguments;
  if (typeof inner === 'string') {
    const trimmed = inner.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
    try {
      inner = JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  if (!inner || typeof inner !== 'object' || Array.isArray(inner)) return value;
  return inner;
}

/**
 * 工具调用的参数统一成 JSON 字符串（给 OpenAI tool_calls.arguments 用）。
 * 兼容字符串 / 对象；被包装成 {name,args} 的会先拆掉（见 unwrapCallArguments）。
 */
export function normalizeArguments(args) {
  if (args === undefined || args === null) return '{}';
  let value = args;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '{}';
    try {
      value = JSON.parse(trimmed);
    } catch {
      // 不是合法 JSON 就包一层，避免下游解析炸掉
      return JSON.stringify({ input: args });
    }
  }
  return JSON.stringify(unwrapCallArguments(value));
}

/** 工具执行结果 -> ## Tool_call_result 段里的一行 JSON */
export function renderToolResult(name, content) {
  const result = typeof content === 'string' ? content : JSON.stringify(content);
  return `${JSON.stringify({ name: name || 'unknown', result })}`;
}

/** 统计工具名，用于过滤模型臆造的函数名 */
export function collectToolNames(tools = []) {
  return tools
    .map((t) => (t?.function ?? t)?.name)
    .filter((n) => typeof n === 'string' && n.trim())
    .map((n) => n.trim());
}
