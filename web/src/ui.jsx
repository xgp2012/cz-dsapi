/**
 * mdui 是 Web Components，React 不能直接绑定它的事件。
 * 这里统一用 ref + addEventListener 包一层，页面代码只写普通回调。
 */
import { useEffect, useRef } from 'react';
import { alert, confirm, snackbar } from 'mdui';

export function useEventListener(ref, type, handler) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !handler) return undefined;
    el.addEventListener(type, handler);
    return () => el.removeEventListener(type, handler);
  }, [ref, type, handler]);
}

/** 设置组件属性（优先用 property，避免布尔 attribute 的坑） */
export function useProperty(ref, name, value, dependencies = []) {
  useEffect(() => {
    const el = ref.current;
    if (el) el[name] = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
}

export function Icon({ name, src, style, className }) {
  return <mdui-icon name={name} src={src} style={style} className={className} />;
}

export function Btn({
  children,
  variant = 'filled',
  icon,
  endIcon,
  onClick,
  disabled,
  loading,
  href,
  target,
  className,
  style,
  title,
}) {
  const ref = useRef(null);
  useEventListener(
    ref,
    'click',
    onClick &&
      ((event) => {
        if (disabled) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        onClick(event);
      }),
  );
  return (
    <mdui-button
      ref={ref}
      variant={variant}
      disabled={disabled || undefined}
      loading={loading || undefined}
      href={href}
      target={target}
      className={className}
      style={style}
      title={title}
    >
      {icon ? <mdui-icon slot="icon" name={icon} /> : null}
      {children}
      {endIcon ? <mdui-icon slot="end-icon" name={endIcon} /> : null}
    </mdui-button>
  );
}

export function IconBtn({ icon, onClick, title, disabled, style, variant }) {
  const ref = useRef(null);
  useEventListener(ref, 'click', onClick);
  return (
    <mdui-button-icon
      ref={ref}
      icon={icon}
      title={title}
      disabled={disabled || undefined}
      variant={variant}
      style={style}
    />
  );
}

export function TextField({
  value,
  onChange,
  label,
  placeholder,
  helper,
  rows,
  autosize,
  minRows,
  maxRows,
  type = 'text',
  variant = 'outlined',
  disabled,
  togglePassword,
  inputMode,
  style,
  className,
}) {
  const ref = useRef(null);
  useProperty(ref, 'value', value ?? '', [value]);
  useEventListener(ref, 'input', (event) => onChange?.(event.target.value));
  return (
    <mdui-text-field
      ref={ref}
      label={label}
      placeholder={placeholder}
      helper={helper}
      rows={rows}
      autosize={autosize ? '' : undefined}
      minRows={minRows}
      maxRows={maxRows}
      type={type}
      variant={variant}
      disabled={disabled || undefined}
      togglePassword={togglePassword || undefined}
      inputMode={inputMode}
      style={style}
      className={className}
    />
  );
}

export function Select({ value, onChange, label, options, disabled, style, className }) {
  const ref = useRef(null);
  useProperty(ref, 'value', value, [value]);
  useEventListener(ref, 'change', () => onChange?.(ref.current.value));
  return (
    <mdui-select
      ref={ref}
      label={label}
      disabled={disabled || undefined}
      style={style}
      className={className}
    >
      {options.map((option) => (
        <mdui-menu-item key={option.value} value={option.value}>
          {option.label}
        </mdui-menu-item>
      ))}
    </mdui-select>
  );
}

export function Toggle({ checked, onChange, disabled, style, className }) {
  const ref = useRef(null);
  useProperty(ref, 'checked', Boolean(checked), [checked]);
  useEventListener(ref, 'change', () => onChange?.(ref.current.checked));
  return <mdui-switch ref={ref} disabled={disabled || undefined} style={style} className={className} />;
}

export function ListItem({ icon, endIcon, active, onClick, children, href, target }) {
  const ref = useRef(null);
  useProperty(ref, 'active', Boolean(active), [active]);
  useEventListener(ref, 'click', onClick);
  return (
    <mdui-list-item ref={ref} icon={icon} endIcon={endIcon} href={href} target={target}>
      {children}
    </mdui-list-item>
  );
}

export function Card({ title, subtitle, actions, children, className = '', style }) {
  return (
    <mdui-card variant="filled" className={`card ${className}`} style={style}>
      {(title || actions) && (
        <header className="card-head">
          <div>
            {title ? <h2>{title}</h2> : null}
            {subtitle ? <p className="muted">{subtitle}</p> : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </header>
      )}
      {children}
    </mdui-card>
  );
}

export function Chip({ children, tone = 'neutral', title }) {
  return (
    <span className={`chip chip-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function Stat({ label, value, hint, tone = 'neutral', icon }) {
  return (
    <mdui-card variant="filled" className="stat">
      <div className="stat-head">
        {icon ? <mdui-icon name={icon} /> : null}
        <span className="muted">{label}</span>
      </div>
      <div className={`stat-value tone-${tone}`}>{value}</div>
      {hint ? <div className="stat-hint muted">{hint}</div> : null}
    </mdui-card>
  );
}

export function Empty({ children = '暂无数据' }) {
  return <div className="empty muted">{children}</div>;
}

export function ErrorBanner({ message, onRetry }) {
  return (
    <div className="banner banner-error">
      <mdui-icon name="error_outline" />
      <span>{message}</span>
      {onRetry ? (
        <Btn variant="text" onClick={onRetry}>
          重试
        </Btn>
      ) : null}
    </div>
  );
}

export function Banner({ tone = 'info', icon, children, actions }) {
  return (
    <div className={`banner banner-${tone}`}>
      {icon ? <mdui-icon name={icon} /> : null}
      <span>{children}</span>
      {actions}
    </div>
  );
}

/* ---------------- 全局提示 ---------------- */

export function toast(message) {
  snackbar({ message });
}

export async function notify(description, headline = '提示') {
  try {
    await alert({ headline, description, confirmText: '知道了' });
  } catch {
    /* 用户直接关掉 */
  }
}

export async function askConfirm(description, headline = '确认操作', confirmText = '确定') {
  try {
    await confirm({ headline, description, confirmText, cancelText: '取消' });
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 格式化 ---------------- */

export function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  if (minutes) return `${minutes} 分 ${secs} 秒`;
  return `${secs} 秒`;
}

export function formatMs(ms) {
  const value = Number(ms) || 0;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

export function formatTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return date.toLocaleString('zh-CN', { hour12: false });
}
