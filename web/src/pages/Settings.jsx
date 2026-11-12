import { useCallback, useEffect, useMemo, useState } from 'react';

import { adminApi } from '../api.js';
import {
  Banner,
  Btn,
  Card,
  ErrorBanner,
  Select,
  TextField,
  Toggle,
  askConfirm,
  notify,
  toast,
} from '../ui.jsx';

export default function Settings() {
  const [config, setConfig] = useState(null);
  const [values, setValues] = useState({});
  const [initial, setInitial] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await adminApi('/config');
      setConfig(data);
      setValues(data.values ?? {});
      setInitial(data.values ?? {});
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const changedKeys = useMemo(
    () => Object.keys(values).filter((key) => values[key] !== initial[key]),
    [values, initial],
  );

  const writable = config?.writable !== false;

  /**
   * 按后端 schema 里的 group 字段分组渲染。
   * 51 项平铺成一列太难找，分组后每组之间还有小标题。
   * 组顺序按 schema 里首次出现的顺序（也就是后端的排列顺序），不另立一套。
   */
  const groups = useMemo(() => {
    const schema = config?.schema ?? [];
    const order = [];
    const map = new Map();
    for (const item of schema) {
      const name = item.group || '其它';
      if (!map.has(name)) {
        map.set(name, []);
        order.push(name);
      }
      map.get(name).push(item);
    }
    return order.map((name) => ({ name, items: map.get(name) }));
  }, [config]);

  const setValue = (key, value) => setValues((prev) => ({ ...prev, [key]: value }));

  const save = async () => {
    if (!changedKeys.length) {
      toast('没有改动');
      return;
    }
    if (changedKeys.includes('API_KEY') && values.API_KEY === '') {
      const ok = await askConfirm('清空 API_KEY 后接口将不再鉴权（任何能访问端口的人都能调用），确定吗？', '清空 API Key', '清空');
      if (!ok) return;
    }
    setSaving(true);
    try {
      const payload = {};
      for (const key of changedKeys) payload[key] = values[key];
      const result = await adminApi('/config', { method: 'PUT', body: { values: payload } });
      toast(`已写入 ${result.saved.length} 项配置`);
      await load();
      if (result.restartRequired) {
        const ok = await askConfirm(result.message, '需要重启生效', '立即重启');
        if (ok) await restart();
      }
    } catch (err) {
      await notify(err.message, '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const restart = async () => {
    setRestarting(true);
    try {
      await adminApi('/restart', { method: 'POST' });
      toast('正在重启，等待服务恢复…');
      let recovered = false;
      for (let i = 0; i < 45; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          const res = await fetch(`/healthz?ts=${Date.now()}`, { cache: 'no-store' });
          if (res.ok) {
            recovered = true;
            break;
          }
        } catch {
          /* 继续等 */
        }
      }
      if (recovered) {
        toast('服务已恢复');
        await load();
      } else {
        await notify('重启后 45 秒内没有恢复，请到日志页查看原因。', '重启超时');
      }
    } catch (err) {
      await notify(err.message, '重启失败');
    } finally {
      setRestarting(false);
    }
  };

  if (error) {
    return (
      <div className="page">
        <ErrorBanner message={error} onRetry={load} />
      </div>
    );
  }

  if (!config) {
    return (
      <div className="page">
        <div className="loading-bar" />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>设置</h1>
          <p className="muted">
            改完保存在数据目录的 settings.json，重启服务后生效。这里显示的是当前生效值；
            清空某一项等于恢复默认。
          </p>
        </div>
        <div className="page-actions">
          <Btn variant="tonal" icon="refresh" onClick={load}>
            重新读取
          </Btn>
          <Btn variant="filled" icon="save" loading={saving} disabled={!changedKeys.length || !writable} onClick={save}>
            保存{changedKeys.length ? `（${changedKeys.length} 项）` : ''}
          </Btn>
        </div>
      </div>

      {config.broken ? (
        <Banner tone="warn" icon="warning">
          settings.json 读取失败，当前显示的是环境变量 / 默认值。保存一次即可覆盖修复。
        </Banner>
      ) : null}

      {!writable ? (
        <Banner tone="warn" icon="lock">
          {config.writableHint || '配置目录不可写，无法保存。'}
        </Banner>
      ) : null}

      {changedKeys.length ? (
        <Banner tone="warn" icon="edit_note">
          有 {changedKeys.length} 项改动还没保存：{changedKeys.join(' / ')}
        </Banner>
      ) : null}

      {groups.map(({ name, items }) => (
        <Card key={name} title={name} subtitle={name === groups[0].name ? config.settingsFile : undefined}>
          <div className="form-grid">
            {items.map((item) => (
              <div className="field" key={item.key}>
                <span className="field-label">
                  {item.label} <span className="mono muted">{item.key}</span>
                </span>
                <SettingControl
                  item={item}
                  value={values[item.key] ?? ''}
                  disabled={!writable}
                  onChange={(value) => setValue(item.key, value)}
                />
                {item.help ? <span className="field-help">{item.help}</span> : null}
              </div>
            ))}
          </div>
        </Card>
      ))}

      <Card title="服务操作">
        <div className="row">
          <Btn variant="outlined" icon="restart_alt" loading={restarting} onClick={restart}>
            重启服务
          </Btn>
          <span className="field-note">
            重启会断开正在进行的对话；如果服务被 pm2 托管，请直接 pm2 restart。
          </span>
        </div>
      </Card>
    </div>
  );
}

function SettingControl({ item, value, onChange }) {
  if (item.type === 'select') {
    return (
      <Select
        value={value}
        onChange={onChange}
        options={item.options.map((option) => ({ value: option, label: option }))}
      />
    );
  }

  if (item.type === 'boolean') {
    return (
      <div className="field-row">
        <Toggle checked={value === 'true'} onChange={(checked) => onChange(checked ? 'true' : 'false')} />
        <span className="field-note">{value === 'true' ? '开启' : '关闭'}</span>
      </div>
    );
  }

  return (
    <TextField
      value={value}
      onChange={onChange}
      type={item.type === 'password' ? 'password' : item.type === 'number' ? 'number' : 'text'}
      togglePassword={item.type === 'password'}
      placeholder={item.type === 'password' && value ? '（已设置，留空表示清空）' : ''}
    />
  );
}
