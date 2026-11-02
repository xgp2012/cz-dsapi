import { useCallback, useEffect, useRef, useState } from 'react';

import { adminApi, request, streamChat } from '../api.js';
import {
  Btn,
  Card,
  Chip,
  ErrorBanner,
  Select,
  TextField,
  Toggle,
  formatMs,
  notify,
  toast,
} from '../ui.jsx';

export default function Playground() {
  const [models, setModels] = useState(['deepseek-flash']);
  const [model, setModel] = useState('deepseek-flash');
  const [thinking, setThinking] = useState(true);
  const [streaming, setStreaming] = useState(true);
  const [system, setSystem] = useState('你是一个简洁的助手。');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => {
    adminApi('/overview')
      .then((data) => {
        const list = data.models?.length ? data.models : ['deepseek-flash'];
        setModels(list);
        if (!list.includes(model)) setModel(list[0]);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const patchMessage = useCallback((index, updater) => {
    setMessages((prev) => prev.map((item, i) => (i === index ? updater(item) : item)));
  }, []);

  const buildBody = (history) => ({
    model,
    thinking,
    messages: [
      ...(system.trim() ? [{ role: 'system', content: system }] : []),
      ...history.map(({ role, content }) => ({ role, content })),
    ],
  });

  const send = async () => {
    const text = input.trim();
    if (!text || sending) return;
    setInput('');
    setError('');
    setSending(true);

    const history = [...messages, { role: 'user', content: text }];
    const assistantIndex = history.length;
    setMessages([...history, { role: 'assistant', content: '', reasoning: '', pending: true, startedAt: Date.now() }]);

    const body = buildBody(history);

    try {
      if (streaming) {
        const startedAt = Date.now();
        const { toolCalls } = await streamChat(body, {
          onDelta: (delta) =>
            patchMessage(assistantIndex, (item) => ({ ...item, content: item.content + delta })),
          onReasoning: (delta) =>
            patchMessage(assistantIndex, (item) => ({ ...item, reasoning: item.reasoning + delta })),
          onFinish: (calls) =>
            patchMessage(assistantIndex, (item) => ({
              ...item,
              pending: false,
              toolCalls: calls,
              ms: Date.now() - startedAt,
            })),
        });
        patchMessage(assistantIndex, (item) => ({
          ...item,
          pending: false,
          toolCalls: item.toolCalls?.length ? item.toolCalls : toolCalls,
          ms: item.ms ?? Date.now() - startedAt,
        }));
      } else {
        const startedAt = Date.now();
        const result = await request('/v1/chat/completions', {
          method: 'POST',
          body: { ...body, stream: false },
        });
        const choice = result.choices?.[0];
        patchMessage(assistantIndex, (item) => ({
          ...item,
          pending: false,
          content: choice?.message?.content ?? '',
          reasoning: choice?.message?.reasoning_content ?? '',
          toolCalls: choice?.message?.tool_calls ?? [],
          usage: result.usage,
          ms: Date.now() - startedAt,
        }));
      }
    } catch (err) {
      setError(err.message);
      patchMessage(assistantIndex, (item) => ({ ...item, pending: false, error: err.message }));
    } finally {
      setSending(false);
    }
  };

  const clear = () => {
    setMessages([]);
    setError('');
  };

  const copyConversation = async () => {
    const text = messages
      .map((item) => `${item.role === 'user' ? 'USER' : 'ASSISTANT'}: ${item.content}`)
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(text);
      toast('对话已复制');
    } catch {
      await notify('复制失败，浏览器不允许访问剪贴板', '提示');
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>测试</h1>
          <p className="muted">直接调 /v1/chat/completions，和真实客户端走同一条链路（会真的访问 DeepSeek）。</p>
        </div>
        <div className="page-actions">
          <Btn variant="text" icon="content_copy" onClick={copyConversation}>
            复制对话
          </Btn>
          <Btn variant="tonal" icon="delete_sweep" onClick={clear}>
            清空
          </Btn>
        </div>
      </div>

      <Card>
        <div className="form-grid">
          <div className="field">
            <span className="field-label">模型</span>
            <Select
              value={model}
              onChange={setModel}
              options={models.map((id) => ({ value: id, label: id }))}
            />
          </div>
          <div className="field">
            <span className="field-label">深度思考</span>
            <div className="field-row">
              <Toggle checked={thinking} onChange={setThinking} />
              <span className="field-note">{thinking ? '打开（reasoning_content）' : '关闭'}</span>
            </div>
          </div>
          <div className="field">
            <span className="field-label">流式输出</span>
            <div className="field-row">
              <Toggle checked={streaming} onChange={setStreaming} />
              <span className="field-note">{streaming ? 'SSE 逐字显示' : '一次性返回'}</span>
            </div>
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <TextField
            label="System prompt（可留空）"
            rows={2}
            value={system}
            onChange={setSystem}
          />
        </div>
      </Card>

      {error ? <ErrorBanner message={error} /> : null}

      <Card title="对话">
        <div className="chat" ref={scrollRef} style={{ maxHeight: '48vh', overflow: 'auto' }}>
          {messages.length ? (
            messages.map((item, index) => (
              <div key={index} className={`msg ${item.role === 'user' ? 'msg-user' : 'msg-assistant'}`}>
                {item.role === 'assistant' && item.reasoning ? (
                  <details>
                    <summary>思考过程（{item.reasoning.length} 字）</summary>
                    <pre>{item.reasoning}</pre>
                  </details>
                ) : null}
                <div>
                  {item.content ||
                    (item.pending ? '…' : item.error ? '' : '（空回答）')}
                </div>
                {item.toolCalls?.length ? (
                  <div className="tool-calls">
                    <Chip tone="warn">工具调用 × {item.toolCalls.length}</Chip>
                    <pre>{JSON.stringify(item.toolCalls, null, 2)}</pre>
                  </div>
                ) : null}
                {item.error ? <div className="msg-error">{item.error}</div> : null}
                {item.role === 'assistant' && (item.ms || item.usage) ? (
                  <div className="msg-meta">
                    {item.ms ? `${formatMs(item.ms)}` : ''}
                    {item.usage ? ` · 输入 ${item.usage.prompt_tokens} / 输出 ${item.usage.completion_tokens} tokens` : ''}
                  </div>
                ) : null}
              </div>
            ))
          ) : (
            <div className="empty muted">还没有对话，在下面输入一句话试试</div>
          )}
        </div>

        <div className="row" style={{ marginTop: 16, alignItems: 'flex-end' }}>
          <div className="grow">
            <TextField
              label="输入消息"
              placeholder="Enter 发送，Shift + Enter 换行"
              rows={2}
              value={input}
              onChange={setInput}
            />
          </div>
          <Btn variant="filled" icon="send" loading={sending} onClick={send}>
            发送
          </Btn>
        </div>
        <div className="field-note" style={{ marginTop: 8 }}>
          请求会作为一次全新的网页对话发给 chat.deepseek.com（历史由服务端拼进 prompt）。
        </div>
      </Card>
    </div>
  );
}
