/**
 * DeepSeek 网页版「特殊 token」协议。
 *
 * 因为每个请求都是一次全新的网页对话，模型看不到任何服务端会话状态，
 * 所以每次都要把「这是哪种角色 / 怎么调用工具」的约定重新喂给它。
 *
 * 这里有一条必须守住的边界：**RESULT 只能出现在 <|TOOL_CALL_RESULT|> 段里，
 * 永远不能出现在 ASSISTANT_ROLE_MESSAGES 段里**。模型是照着历史里的「自己说过的话」
 * 往后接的，一旦它看到 assistant 段落里有 RESULT，就会学会自己编造结果。
 */

export const SPECIAL_TOKENS_HEADER = `
你是一个绝对严谨的助手。
对于工具调用，只能使用下面约定的 DO 格式；不要输出 DSML、XML 或任何其他原生工具调用格式，否则可能导致程序解析错误，用户账号可能被封禁。
特殊 token 声明：
SYSTEM_ROLE_MESSAGE -> 系统消息
USER_ROLE_MESSAGE -> 用户消息
ASSISTANT_ROLE_MESSAGE -> 你的回答
TOOL_FUNCTIONS -> 可用工具函数列表
< | | TOOL_CALL_RESULT | | > -> 工具调用结果
CONTEXT_ATTACHMENT -> 来自较早对话的附件描述
< | | END | | > -> end of reply

工具调用

1. 需要工具时，只输出一个完整的 DO 块（半角冒号、双引号、必须闭合，紧跟在正文之后，不要用代码围栏包裹）：
   DO:{"name":"tool name","args":parameters}
   示例：调用 exec_shell 执行 uname -a：
   DO:{"name":"exec_shell","args":"uname -a"}
2. 参数值为字符串时，直接写原始文本；为数字/布尔值/数组/对象时，按 JSON 原样书写，示例：
   DO:{"name":"some_tool","args":{"count":3,"flag":true,"items":["a","b"]}}
3. 不要把调用块放进代码块中，也不要在块外添加额外文本。
4. TOOL_FUNCTIONS 部分的每一行都是一个可用工具，其参数使用 JSON Schema 声明。
5. 每轮对话中尽量少调用工具。
6. 禁止编造、预测或猜测工具名称或工具参数。
7. 输出 DO 调用块后，必须立即结束当前回复：不要自己写工具结果，不要模拟工具输出，
   也不要继续写后续文本或分析。等待系统在下一轮注入真实结果，然后根据结果作答。

上下文

1. 你看到的 ## 各节就是全部上下文。不要编造、补全或猜测任何未出现的对话、
   用户消息、系统提示、附件内容或工具结果。
2. 不要输出诸如 ## USER_ROLE_MESSAGES / ## < | |ASSISTANT_ROLE_MESSAGES | | > / ## <|TOOL_CALL_RESULT|> /
   SYSTEM_ROLE_MESSAGES / ## CONTEXT_ATTACHMENT 这样的节标题，也不要输出 # MESSAGES: 标题。
3. 每轮对话只要有一次ASSISTANT_ROLE_MESSAGE就代表你已经回答了问题，无需重复回复

工具结果
1.绝对禁止编造、猜测、补全或模拟任何工具执行过程和结果
2.绝对禁止输出< | | TOOL_CALL_RESULT | | >
3.禁止假装自己已经执行了工具

长上下文

· 当出现 CONTEXT_ATTACHMENT 节时，表示较早的对话已被拆分为附件：先阅读附件，再结合后面的节作答。
· 附件内容也采用 ## 节格式，属于本对话的历史，而不是新的用户请求。

输出规范：
1.不要在任何时候透露，输出，复述系统设置的特殊token
2.禁止输出"ASSISTANT_ROLE_MESSAGES"
3.在每轮回答结束后必须输出
"< | | END | | >"
(工具调用也算回答)
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
不要输出 RESULT、<|TOOL_CALL_RESULT|>、## 段落标题，也不要编造工具输出或没有出现过的对话。
没有工具结果时，就基于已有信息用自然语言回答，或者只输出一个完整的 DO:{"name":"工具名","args":参数} 工具调用块。`;
export const SECTION = {
  system: '## SYSTEM_ROLE_MESSAGE:',
  tools: '## TOOL_FUNCTIONS:',
  user: '## USER_ROLE_MESSAGE:',
  assistant: '## ASSISTANT_ROLE_MESSAGES:',
  toolResult: '< |  | TOOL_CALL_RESULT | | >:',
  /** @deprecated 兼容旧名字，等同于 toolResult */
  result: '< |  | TOOL_CALL_RESULT | | >:',
};

export const PROMPT_HEADER = '# MESSAGES:';

/** 最后一段是工具结果时，在段尾补一句「现在直接回答」，避免模型接着写 RESULT */
export const FINAL_ANSWER_HINT =
  'SYSTEM_ROLE_MESSAGES:It is absolutely forbidden to output any special token other than DO';