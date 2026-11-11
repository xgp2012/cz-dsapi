const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

const COLORS = {
  error: '\u001b[31m',
  warn: '\u001b[33m',
  info: '\u001b[36m',
  debug: '\u001b[90m',
  trace: '\u001b[90m',
};
const RESET = '\u001b[0m';

/**
 * 本地时间戳，精确到毫秒。
 *
 * 不能用 `toISOString().slice(11, 23)`：那是**永远 UTC** 的。
 * 容器里默认 TZ=UTC，而用户看日志时心里想的是本地时间 ——
 * 排查「上游限流窗口」「冷却还有多久」时，差 8 小时的日志会直接把判断带偏。
 * 这里按进程时区（Dockerfile 里设了 TZ=Asia/Shanghai）输出。
 */
function timestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function createLogger(level = 'info', scope = '') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  // docker logs / 重定向到文件时 isTTY 为 false，颜色自动关闭
  const color = process.stdout.isTTY && !process.env.NO_COLOR;

  const emit = (lvl, args) => {
    if ((LEVELS[lvl] ?? 99) > threshold) return;
    const tag = color ? `${COLORS[lvl]}${lvl.toUpperCase().padEnd(5)}${RESET}` : lvl.toUpperCase().padEnd(5);
    const prefix = scope ? `[${scope}] ` : '';
    const line = `${timestamp()} ${tag} ${prefix}`;
    const out = lvl === 'error' || lvl === 'warn' ? console.error : console.log;
    out(line, ...args);
  };

  const logger = {
    level,
    error: (...a) => emit('error', a),
    warn: (...a) => emit('warn', a),
    info: (...a) => emit('info', a),
    debug: (...a) => emit('debug', a),
    trace: (...a) => emit('trace', a),
    child: (childScope) => createLogger(level, scope ? `${scope}:${childScope}` : childScope),
  };
  return logger;
}
