import crypto from 'node:crypto';

export const MODELS = [
  { id: 'deepseek-flash', object: 'model', created: 0, owned_by: 'deepseek-web' },
  { id: 'deepseek-reasoner', object: 'model', created: 0, owned_by: 'deepseek-web' },
];

export const newCompletionId = () => `chatcmpl-${crypto.randomBytes(12).toString('hex')}`;

export function modelsResponse() {
  return { object: 'list', data: MODELS };
}

/** 非流式响应 */
export function buildChatCompletion({ id, model, content, reasoning, toolCalls, finishReason, usage }) {
  const message = { role: 'assistant', content };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls?.length) {
    message.tool_calls = toolCalls.map((call, index) => ({
      id: call.id ?? `call_${crypto.randomBytes(8).toString('hex')}`,
      index,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }));
    message.content = content ?? '';
  }
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, logprobs: null, finish_reason: finishReason }],
    usage,
  };
}

/** 流式 chunk */
export function buildChatChunk({ id, model, delta, finishReason = null }) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, logprobs: null, finish_reason: finishReason }],
  };
}

/** 粗略 usage：网页版不返回真实 token 数，这里按字符估算并标注 */
export function estimateUsage(promptText, completionText) {
  const prompt = estimate(promptText);
  const completion = estimate(completionText);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    estimated: true,
  };
}

function estimate(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) > 0x2e80) cjk += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(cjk + other / 4));
}
