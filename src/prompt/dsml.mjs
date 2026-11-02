/**
 * DeepSeek DSML（XML 风格工具调用）解析。
 *
 * 网页版模型有时不按 prompt 约定输出 `DO:{...}`，而是原生吐出 DSML：
 *
 *   <｜DSML｜calls>
 *   <｜DSML｜invoke name="bash">
 *   <｜DSML｜parameter name="command" string="true">uname -a</｜DSML｜parameter>
 *   </｜DSML｜invoke>
 *   </｜DSML｜calls>
 *
 * 实际见到的写法不统一，这里都认：
 * - 竖线是全角 `｜`（U+FF5C）或 ASCII `|`，单层 / 双层都行
 * - 外层标签叫 `calls` 或 `tool_calls`
 * - 标签内外允许空格；attribute 值允许单引号 / 双引号 / 不带引号
 * - `string="false"` 的参数按 JSON 解码（数字 / 布尔 / 数组 / 对象）
 */

const PIPE = '[｜|]';
const PIPES = `(?:${PIPE}[ \\t]*){1,2}`;
const OPEN = `<[ \\t]*${PIPES}DSML[ \\t]*${PIPES}`;
const CLOSE = `</[ \\t]*${PIPES}DSML[ \\t]*${PIPES}`;
const CALLS = '(?:tool_)?calls';
const TAG_START = '(?=[ \\t/>])';

const CALLS_BLOCK = new RegExp(`${OPEN}${CALLS}[ \\t]*>([\\s\\S]*?)${CLOSE}${CALLS}[ \\t]*>`, 'gi');
const INVOKE_BLOCK = new RegExp(`${OPEN}invoke${TAG_START}([^>]*)>([\\s\\S]*?)${CLOSE}invoke[ \\t]*>`, 'gi');
const PARAM_BLOCK = new RegExp(`${OPEN}parameter${TAG_START}([^>]*)>([\\s\\S]*?)${CLOSE}parameter[ \\t]*>`, 'gi');

const CALLS_OPEN = new RegExp(`${OPEN}${CALLS}[ \\t]*>`, 'i');
const INVOKE_OPEN = new RegExp(`${OPEN}invoke${TAG_START}`, 'i');
const PARAM_OPEN = new RegExp(`${OPEN}parameter${TAG_START}`, 'i');

const INVOKE_NEXT = new RegExp(INVOKE_OPEN.source, 'i');
const CALLS_OPEN_G = new RegExp(CALLS_OPEN.source, 'gi');
const INVOKE_OPEN_G = new RegExp(INVOKE_OPEN.source, 'gi');
const PARAM_OPEN_G = new RegExp(PARAM_OPEN.source, 'gi');

const TAG_NAMES = ['calls', 'tool_calls', 'invoke', 'parameter'];

function readAttr(attrs, key) {
  const pattern = new RegExp(`(?:^|[ \\s])${key}[ \\t]*=[ \\t]*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = pattern.exec(attrs);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
}

function decodeParameter(value, stringAttr) {
  const raw = value.replace(/^[ \t]*\r?\n/, '').trimEnd();
  // string 缺省视为 "true"：值原样保留成字符串
  const asString = stringAttr === null || !/^(?:false|0|no)$/i.test(stringAttr.trim());
  if (asString) return raw.trim();

  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function parseJsonObject(text) {
  if (!text || text[0] !== '{') return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function parseParameters(body) {
  const args = {};
  let count = 0;
  PARAM_BLOCK.lastIndex = 0;
  let match;
  while ((match = PARAM_BLOCK.exec(body)) !== null) {
    const name = (readAttr(match[1], 'name') || '').trim();
    if (!name) continue;
    args[name] = decodeParameter(match[2], readAttr(match[1], 'string'));
    count += 1;
  }
  return { args, count };
}

/**
 * 从文本里解析 DSML 工具调用。
 *
 * 注意：不再按「已知工具名」过滤。模型调一个没声明过的名字时，把调用丢掉会让整轮输出变空
 * （客户端只会看到「模型未返回正文或工具调用」），未知名字应照实返回，交给客户端报 unknown tool。
 *
 * @param {string} text
 * @param {Set<string>|null} allowed 保留参数（历史上用于过滤，现已忽略）
 * @returns {{ name: string, arguments: string, raw: string, index: number }[]}
 */
export function parseDsmlCalls(text, allowed = null) {
  if (!text || typeof text !== 'string') return [];

  const scopes = [];
  CALLS_BLOCK.lastIndex = 0;
  let block;
  while ((block = CALLS_BLOCK.exec(text)) !== null) {
    scopes.push({ body: block[1], index: block.index });
  }
  // 没有 calls 包装（模型直接吐 invoke）时，退回全文本扫描
  if (!scopes.length) scopes.push({ body: text, index: 0 });

  const calls = [];
  const seen = new Set();
  const push = (name, argsJson, raw, position) => {
    if (!name) return;
    const signature = `${name}\u0000${argsJson}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    calls.push({ name, arguments: argsJson, raw, index: position });
  };

  for (const scope of scopes) {
    const ranges = [];
    INVOKE_BLOCK.lastIndex = 0;
    let invoke;
    while ((invoke = INVOKE_BLOCK.exec(scope.body)) !== null) {
      ranges.push({ start: invoke.index, end: invoke.index + invoke[0].length });
      const name = (readAttr(invoke[1], 'name') || '').trim();
      const { args, count } = parseParameters(invoke[2]);
      const parsed = count ? args : parseJsonObject(invoke[2].trim());
      push(name, JSON.stringify(parsed ?? args), invoke[0], scope.index + invoke.index);
    }

    // 输出被截断 / 少了闭合标签时退一步：只认 invoke 开头 + 完整的 parameter
    INVOKE_OPEN_G.lastIndex = 0;
    let open;
    while ((open = INVOKE_OPEN_G.exec(scope.body)) !== null) {
      if (ranges.some((range) => range.start <= open.index && open.index < range.end)) continue;

      const attrStart = open.index + open[0].length;
      const end = scope.body.indexOf('>', attrStart);
      if (end === -1) continue;

      const name = (readAttr(scope.body.slice(attrStart, end), 'name') || '').trim();
      if (!name) continue;

      const rest = scope.body.slice(end + 1);
      const next = INVOKE_NEXT.exec(rest);
      const { args, count } = parseParameters(next ? rest.slice(0, next.index) : rest);
      if (!count) continue;

      push(name, JSON.stringify(args), scope.body.slice(open.index, end + 1), scope.index + open.index);
    }
  }

  return calls;
}

/**
 * 找出文本里的 DSML 片段（用于从 content 里剔除）。
 * 未闭合的标签会一直吞到结尾：流式截断 / 模型只吐了半个调用时，
 * 剩下的内容本来也属于协议。
 */
export function findDsmlBlocks(text) {
  if (!text) return [];

  const blocks = [];
  const covered = (index) => blocks.some((block) => block.start <= index && index < block.end);

  CALLS_BLOCK.lastIndex = 0;
  let match;
  while ((match = CALLS_BLOCK.exec(text)) !== null) {
    blocks.push({ start: match.index, end: match.index + match[0].length });
  }

  INVOKE_BLOCK.lastIndex = 0;
  while ((match = INVOKE_BLOCK.exec(text)) !== null) {
    if (covered(match.index)) continue;
    blocks.push({ start: match.index, end: match.index + match[0].length });
  }

  for (const pattern of [CALLS_OPEN_G, INVOKE_OPEN_G, PARAM_OPEN_G]) {
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text)) !== null) {
      if (covered(match.index)) continue;
      blocks.push({ start: match.index, end: text.length });
      break;
    }
  }

  blocks.sort((a, b) => a.start - b.start);

  // 合并重叠区间，避免 strip 时重复切片
  const merged = [];
  for (const block of blocks) {
    const last = merged.at(-1);
    if (last && block.start <= last.end) last.end = Math.max(last.end, block.end);
    else merged.push({ ...block });
  }
  return merged;
}

/** 从 `<` 开始的一段文本，是否像 DSML 标签（完整的或半截的） */
function looksLikeDsmlPrefix(tail) {
  let i = 0;
  const skipSpace = () => {
    while (i < tail.length && (tail[i] === ' ' || tail[i] === '\t')) i += 1;
  };
  const eatPipe = () => {
    if (tail[i] === '｜' || tail[i] === '|') {
      i += 1;
      return true;
    }
    return false;
  };

  if (tail[0] !== '<') return false;
  i = 1;
  if (tail[i] === '/') i += 1;
  skipSpace();
  if (!eatPipe()) return false;
  skipSpace();
  eatPipe(); // 第二个竖线可有可无
  skipSpace();

  const MAGIC = 'DSML';
  let k = 0;
  while (k < MAGIC.length && i < tail.length && tail[i].toUpperCase() === MAGIC[k]) {
    i += 1;
    k += 1;
  }
  if (k === 0) return false;
  if (k < MAGIC.length) return i >= tail.length; // 半截的 "<｜DS"

  skipSpace();
  if (!eatPipe()) return i >= tail.length;
  skipSpace();
  eatPipe();
  skipSpace();

  const name = tail.slice(i).split(/[>\n]/)[0].trim().toLowerCase();
  if (!name) return true;
  return TAG_NAMES.some((tag) => tag.startsWith(name));
}

function isCompleteOpen(tail) {
  return [CALLS_OPEN, INVOKE_OPEN, PARAM_OPEN].some((pattern) => {
    const match = pattern.exec(tail);
    return Boolean(match) && match.index === 0;
  });
}

/**
 * 找到第一个 DSML 标签起点（complete=false 表示还只吐了一半）。
 * 流式过滤器用它提前截断，避免标签漏进 content。
 * @returns {{ index: number, complete: boolean } | null}
 */
export function findDsmlStart(text, from = 0) {
  if (!text) return null;
  let index = text.indexOf('<', Math.max(0, from));
  while (index !== -1) {
    const tail = text.slice(index);
    if (looksLikeDsmlPrefix(tail)) {
      return { index, complete: isCompleteOpen(tail) };
    }
    index = text.indexOf('<', index + 1);
  }
  return null;
}
