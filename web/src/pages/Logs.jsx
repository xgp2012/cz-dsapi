import { useCallback, useEffect, useRef, useState } from 'react';

import { adminApi } from '../api.js';
import { Btn, Card, ErrorBanner, Select, TextField, Toggle, toast } from '../ui.jsx';

const LEVEL_OPTIONS = [
  { value: 'all', label: '全部级别' },
  { value: 'warn', label: 'WARN 及以上' },
  { value: 'error', label: '只看 ERROR' },
];

const LINE_OPTIONS = [
  { value: '200', label: '最近 200 行' },
  { value: '500', label: '最近 500 行' },
  { value: '2000', label: '最近 2000 行' },
];

const LEVEL_RANK = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };

export default function Logs() {
  const [lines, setLines] = useState([]);
  const [error, setError] = useState('');
  const [level, setLevel] = useState('all');
  const [count, setCount] = useState('500');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [keyword, setKeyword] = useState('');
  const viewRef = useRef(null);
  const stickToBottom = useRef(true);

  const load = useCallback(async () => {
    try {
      const data = await adminApi(`/logs?lines=${count}`);
      setLines(data.lines ?? []);
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [count]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [autoRefresh, load]);

  useEffect(() => {
    const el = viewRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const threshold = level === 'warn' ? 1 : level === 'error' ? 0 : 99;
  const filtered = lines.filter((line) => {
    if (keyword && !line.toLowerCase().includes(keyword.toLowerCase())) return false;
    const match = /^\d{2}:\d{2}:\d{2}\.\d{3}\s+([A-Z]+)/.exec(line);
    const rank = LEVEL_RANK[match?.[1]] ?? 9;
    return rank <= threshold;
  });

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(filtered.join('\n'));
      toast(`已复制 ${filtered.length} 行日志`);
    } catch {
      toast('复制失败');
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>日志</h1>
          <p className="muted">服务日志写在使用 npm run up 时重定向的 data/server.log 里。</p>
        </div>
        <div className="page-actions">
          <Btn variant="tonal" icon="refresh" onClick={load}>
            刷新
          </Btn>
          <Btn variant="text" icon="content_copy" onClick={copyAll}>
            复制当前视图
          </Btn>
        </div>
      </div>

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      <Card>
        <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          <div className="field">
            <span className="field-label">级别</span>
            <Select value={level} onChange={setLevel} options={LEVEL_OPTIONS} />
          </div>
          <div className="field">
            <span className="field-label">范围</span>
            <Select value={count} onChange={setCount} options={LINE_OPTIONS} />
          </div>
          <div className="field">
            <span className="field-label">关键字</span>
            <TextField placeholder="过滤包含该文本的行" value={keyword} onChange={(value) => setKeyword(value)} />
          </div>
          <div className="field">
            <span className="field-label">自动刷新</span>
            <div className="field-row">
              <Toggle checked={autoRefresh} onChange={setAutoRefresh} />
              <span className="field-note">{autoRefresh ? '每 3 秒刷新' : '已关闭'}</span>
            </div>
          </div>
        </div>
      </Card>

      <Card title={`日志输出（${filtered.length} / ${lines.length} 行）`}>
        <div
          className="log-view"
          ref={viewRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {filtered.length ? (
            filtered.map((line, index) => <LogLine key={index} line={line} />)
          ) : (
            <span className="muted">没有匹配的日志</span>
          )}
        </div>
      </Card>
    </div>
  );
}

function LogLine({ line }) {
  const match = /^(\d{2}:\d{2}:\d{2}\.\d{3})\s+([A-Z]+)\s(.*)$/.exec(line);
  if (!match) {
    return <span className="log-line">{line}</span>;
  }
  return (
    <span className="log-line">
      <span className="log-time">{match[1]} </span>
      <span className={`log-level log-level-${match[2]}`}>{match[2].padEnd(5)}</span>
      <span> {match[3]}</span>
    </span>
  );
}
