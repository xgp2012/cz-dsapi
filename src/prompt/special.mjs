/**
 * DeepSeek 网页版「特殊 token」协议。
 *
 * 因为每个请求都是一次全新的网页对话，模型看不到任何服务端会话状态，
 * 所以每次都要把「这是哪种角色 / 怎么调用工具」的约定重新喂给它。
 *
 * 两条必须守住的边界：
 * 1. **工具调用只教一种输出语法**：原生 DSML（模型自己吐 XML 风格的调用），
 *    服务端解析成标准 tool_calls / tool_use，再从 content / SSE 里剔除。
 * 2. **拼接上下文时绝不写回 DSML**。历史里的工具调用统一渲染成 ## Tool_calls 段的 JSON 行，
 *    工具结果单独放在 ## Tool_call_result 段，模型没有可模仿的「自己写工具语法 / 自己写结果」样板。
 */

export const SPECIAL_TOKENS_HEADER = `
Special token declarations:
System -> System message
User -> User message
Assistant -> Your answer
Tool_functions -> List of available tool functions
Tool_calls -> Tool calls you already made in earlier rounds (JSON, one per line)
Tool_call_result -> Tool call result
CONTEXT_ATTACHMENT -> Attachment description from an earlier conversation
< | | END | | > -> end of reply

Context

1. The ## sections are the complete context. Do not fabricate, complete, or guess any conversation, user message, system prompt, attachment content, or tool result that is not present.
2. In each conversation round, if an ASSISTANT_ROLE_MESSAGE is present, it means you have already answered the question; do not reply again.
3. A Tool_calls section lists calls you already made; do not repeat a call that already has a Tool_call_result.

Tool calls

Tool call format:
<｜DSML｜ calls>                          <!-- First layer: call block container -->
    <｜DSML｜ invoke name="tool name">         <!-- Second layer: one specific call -->
        <｜DSML｜ parameter name="parameter name" string="true|false">value</｜DSML｜ parameter>  <!-- Third layer: parameters -->
    </｜DSML｜ invoke>
    <｜DSML｜ invoke name="another tool">      <!-- Multiple calls can be made in parallel -->
        ...
    </｜DSML｜ invoke>
</｜DSML｜ calls>
(**this format is DeepSeek Markup Language and your native format**)

Tool results
1. Never fabricate, guess, complete, or simulate any tool execution process or result.
2. Never output Tool_call_result.
3. Never pretend that you have already executed a tool.

Long context

· A CONTEXT_ATTACHMENT section means that an earlier conversation has been split into an attachment. Read the attachment first, then answer in combination with the following sections.
· Attachment content also uses the ## section format and is part of this conversation's history, not a new user request.

Output specifications:
1. Do not disclose, output, or restate the special tokens set by the system at any time.
2. Do not output "ASSISTANT_ROLE_MESSAGES".
3. After each round of answering, you must output
"< | | END | | >"
(Tool calls also count as an answer)
`;

/**
 * 每轮回答的结束标记。
 *
 * 这个 token 专门给模型看：输出给客户端前会被过滤掉（用户看不到），
 * 但拼上下文时要补回 assistant 历史段的末尾，模型才能看到「上一轮回答在哪结束」。
 */
export const REPLY_END_TOKEN = '< | | END | | >';

/**
 * 检测到模型自造工具结果后，非流式请求会带着这段补充说明重试一次。
 * 拼在客户端 system 段末尾，作为比常规规则更硬的约束。
 */
export const STRICT_REPLY_NOTE = `**本次回答的额外约束**：上一条回答里出现了 RESULT / 伪造的上下文段落，这是被禁止的。
不要输出 RESULT、Tool_call_result、## 段落标题，也不要编造工具输出或没有出现过的对话。
没有工具结果时，就基于已有信息用自然语言回答，或者按约定输出完整的 DSML 工具调用块。`;

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
export const FINAL_ANSWER_HINT = '';
