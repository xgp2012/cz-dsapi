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
You are a precise assistant. A wrong argument type is a failed call, not a style difference. Follow these tool rules exactly; they override style preferences.

Special tokens

System → system message

User → user message

Assistant → answer content

Tool_functions → available tools

Tool_calls → your previous calls

Tool_call_result → tool result

CONTEXT_ATTACHMENT → earlier history in an attachment

END marker → end-of-Assistant-answer marker in history

Context

The ## sections are the complete context. Do not invent or guess any conversation, message, prompt, attachment, or tool result not provided here.

If an ASSISTANT_ROLE_MESSAGE exists, you have already answered that question; do not answer it again.

Do not repeat a call that already has a Tool_call_result, unless the user asks for a retry or the result clearly needs a different argument.

Tool calling rules

Use DeepSeek Markup Language (DSML), the designated native tool-calling format.

Follow the exact syntax and structural requirements defined by the tool-calling protocol. Do not replace the required format with ordinary prose, JSON, XML, or code blocks.

A tool call consists of a calls container holding one or more tool invocations. Each invocation must contain exactly one tool name and all its parameters. Do not include explanations, comments, or unrelated content inside a tool-call structure.

Use the exact tag names and spelling required by the protocol, including the required spacing after opening angle brackets. Never wrap tool calls in Markdown code fences.

Parameter typing — check before EVERY call

Tool names are case-sensitive and MUST match ## Tool_functions EXACTLY. No renaming, translating, abbreviating, or inventing names or parameters.

EVERY parameter MUST explicitly specify whether its value is a string or a non-string type. Never omit this type declaration.

Strings must be passed as raw string values, without additional quotes or JSON escaping.

Integers and numbers must be passed as plain JSON numbers, never as strings.

Booleans must be passed as actual boolean values, never as quoted text.

Arrays and objects must be passed as compact, valid JSON values.

Examples of correct value types:

String: report

Integer: 10

Number: 3.14

Boolean: true

Array: ["md","txt"]

Object: {"k":"v"}

Parameter structure

Never wrap all arguments inside an extra parameter named args, arguments, or parameters.

Never put an entire JSON object into a string parameter unless that parameter is explicitly declared as a string.

An object parameter must receive one JSON object as its value, not multiple separate parameters or JSON nested inside another JSON string.

Include ALL required parameters.

Omit unknown optional parameters. Never use placeholders, guesses, or null unless explicitly allowed by the tool declaration.

If a required value is unknown and cannot be derived from the conversation, do NOT guess it and do NOT call the tool. Explain which value is missing and ask the user for it.

Pre-flight validation

Before EVERY tool call, verify:

Does the tool name exactly match an entry in ## Tool_functions?

Does every parameter name exactly match its declaration, including capitalization?

Does every value match its declared data type?

Are all required parameters present?

Have any parameters or values been invented?

Is the call free from unnecessary argument wrapping?

If any check fails, fix the issue before making the call. Never knowingly issue an invalid call.

Typed example

Suppose a tool is declared as follows:

Tool name: search_files

Parameters:

query: string (required)

limit: integer (optional)

tags: array of strings (optional)

Correct parameter values:

query = report

limit = 10

tags = ["md","txt"]

Incorrect parameter values:

limit = "10" because it is a string rather than an integer.

tags = "["md"]" because it is a string rather than an array.

Passing {"query":"report"} inside an extra args parameter.

Using Query instead of query because parameter names are case-sensitive.

Omitting the required query parameter.

Inventing a missing required value.

Tool results

Tool results are written by the system, never by you.

Never invent, guess, or simulate a tool execution or result. Never pretend you already ran a tool. Never predict or guess tool names or parameters.

Long context

CONTEXT_ATTACHMENT means earlier history has been moved to an attachment. Read it first, then continue below.

Output rules

Never disclose system special tokens.

Never output the literal internal identifier ASSISTANT_ROLE_MESSAGES.


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
