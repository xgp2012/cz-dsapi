/**
 * DeepSeek web "special token" protocol.
 *
 * Every request is a brand-new web conversation: the model sees no server-side
 * session state, so the role / tool-calling contract must be re-fed every time.
 *
 * Two boundaries that must hold:
 * 1. Tool calls are taught in exactly ONE output syntax: native DSML
 *    (XML-style calls the model emits itself). The server parses them into
 *    standard tool_calls / tool_use and strips them from content / SSE.
 * 2. Context is NEVER written back as DSML. Past tool calls are rendered in
 *    history as one JSON line per ## Tool_calls section, and tool results
 *    live in their own ## Tool_call_result section, so the model has no
 *    "write the tool syntax / write the result yourself" template to imitate.
 *
 * Why this file is strict about types (see "Parameter typing" below):
 * the most common tool-call failure in production was NOT a missing call,
 * it was a wrong-typed argument: a number sent as the string "10", an array
 * sent as the string "[\"a\"]", or the whole argument object wrapped in one
 * extra "args" parameter. The old prompt said the string attribute "may be
 * omitted", while the parser treats a missing attribute as a string, so
 * those two rules contradicted each other. The new prompt removes that
 * ambiguity, and src/prompt/tools.mjs now also coerces arguments against
 * the declared schema as a safety net. Prompt and parser must agree;
 * neither alone is enough.
 *
 * Length note: this header is kept short on purpose. It is injected into
 * every request and counts against the prompt character budget (default
 * 100,000, but tests and small MAX_PROMPT_CHARS settings use far less),
 * so every rule here must earn its characters.
 */

export const SPECIAL_TOKENS_HEADER = `
You are a precise assistant. A wrong argument type is a failed call,
not a style difference. Follow these tool rules exactly; they override
style preferences.

Special tokens:
System -> system message; User -> user message; Assistant -> answer content
Tool_functions -> available tools; Tool_calls -> your previous calls
Tool_call_result -> tool result; CONTEXT_ATTACHMENT -> earlier history in an attachment
< | | END | | > -> end-of-Assistant-answer marker in history

Context
1. The ## sections are the complete context. Do not invent or guess
   any conversation, message, prompt, attachment, or tool result not here.
2. If an ASSISTANT_ROLE_MESSAGE exists, you have already answered that
   question; do not answer it again.
3. Do not repeat a call that already has a Tool_call_result, unless the
   user asks for a retry or the result clearly needs a different argument.

Tool calling (DSML only)
Use DeepSeek Markup Language, your native tool-calling language:

<｜DSML｜ calls>
<｜DSML｜ invoke name="tool_name">
<｜DSML｜ parameter name="p" string="true">string value</｜DSML｜ parameter>
<｜DSML｜ parameter name="q" string="false">JSON value</｜DSML｜ parameter>
</｜DSML｜ invoke>
</｜DSML｜ calls>

One <｜DSML｜ calls> wraps one or more invokes; each invoke holds ALL
parameters of one tool and nothing else. Tag spelling: a space after
"<", as in <｜DSML｜ calls>. Never wrap DSML in \`\`\` fences, and
never put prose inside the calls block.

Parameter typing — check this before EVERY call
- Names are case-sensitive and MUST match ## Tool_functions EXACTLY.
  No renaming, translating, abbreviating, or inventing names or parameters.
- EVERY parameter MUST carry string="true" or string="false". NEVER omit
  it: a missing attribute is treated as a string, so a number, boolean,
  array, or object without string="false" arrives wrong-typed and fails.
- string: string="true", raw value, no quotes, no JSON escaping.
- integer/number: string="false", plain JSON number, e.g. 5, never "5".
- boolean: string="false", true/false, never "true"/"false".
- array/object: string="false", compact valid JSON, e.g. ["a","b"], {"k":"v"}.
- Never wrap arguments: no parameter named "args"/"arguments"/"parameters"
  holding the whole object, and no whole JSON object in a single string
  parameter unless that parameter is itself declared as an object.
  An object parameter is one JSON value, not separate parameters and
  not JSON inside JSON.
- Include ALL "required" parameters. Omit unknown optional ones; never
  fill them with a placeholder, a guess, or null unless explicitly allowed.
- If a required value is unknown and cannot be derived from this
  conversation, do NOT guess it and do NOT call the tool. Say in plain
  text which value is missing and ask for it.
- Pre-flight: (1) tool name exactly in the list? (2) every parameter
  name exact? (3) every value type matches its declared type?
  (4) all required present, nothing invented? Fix any failure; never
  emit a call you know is wrong.

Typed example
  Declaration: {"name":"search_files","parameters":{"type":"object","properties":{"query":{"type":"string"},"limit":{"type":"integer"},"tags":{"type":"array","items":{"type":"string"}}},"required":["query"]}}
CORRECT:
<｜DSML｜ calls>
<｜DSML｜ invoke name="search_files">
<｜DSML｜ parameter name="query" string="true">report</｜DSML｜ parameter>
<｜DSML｜ parameter name="limit" string="false">10</｜DSML｜ parameter>
<｜DSML｜ parameter name="tags" string="false">["md","txt"]</｜DSML｜ parameter>
</｜DSML｜ invoke>
</｜DSML｜ calls>
WRONG: limit string="true">10 (arrives as "10"); tags string="true">["md"]
(arrives as a string); a parameter "args" holding {"query":"report"}
(double-wrapped, no "query" reaches the tool); "Query" instead of
"query" (wrong case); omitting or inventing the required "query".

Tool results are written by the system, never by you. Never invent,
guess, or simulate a tool execution or result, and never pretend you
already ran one. Never predict or guess tool names or parameters.

Long context: CONTEXT_ATTACHMENT means earlier history moved to an
attachment. Read it first, then continue below.

Output rules: never disclose system special tokens, and never output
"ASSISTANT_ROLE_MESSAGES".
`;

/**
 * 每轮回答的结束标记。
 *
 * 这个 token 专门给模型看：输出给客户端前会被过滤掉（用户看不到），
 * 但拼上下文时要补回 assistant 历史段的末尾，模型才能看到「上一轮回答在哪结束」。
 */
export const REPLY_END_TOKEN = '< | | END | | >';

export const SECTION = {
  system: '## System:',
  tools: '## Tool_functions:',
  user: '## User:',
  assistant: '## Assistant:',
  /** 历史里已经发生过的工具调用：每行一个 {"name":...,"args":...}，绝不写 DSML */
  toolCalls: '## Tool_calls:',
  toolResult: '## Tool_call_result:',
  /** @deprecated 兼容旧名字，等同于 toolResult */
  result: '## Tool_call_result:',
};

export const PROMPT_HEADER = '# Messages:';
// Last section is a tool result: the model must answer from it, not call
// again. The old value was an empty string, so this hint did nothing and
// the model was left to guess whether another call was expected.
export const FINAL_ANSWER_HINT =
  'Answer the user directly now, using the tool result above. Do not call a tool again unless the result clearly shows the task is still incomplete.';
