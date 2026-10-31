const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

const COLORS = {
  error: '\u001b[31m',
  warn: '\u001b[33m',
  info: '\u001b[36m',
  debug: '\u001b[90m',
  trace: '\u001b[90m',
};
const RESET = '\u001b[0m';

export function createLogger(level = 'info', scope = '') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const color = process.stdout.isTTY && !process.env.NO_COLOR;

  const emit = (lvl, args) => {
    if ((LEVELS[lvl] ?? 99) > threshold) return;
    const time = new Date().toISOString().slice(11, 23);
    const tag = color ? `${COLORS[lvl]}${lvl.toUpperCase().padEnd(5)}${RESET}` : lvl.toUpperCase().padEnd(5);
    const prefix = scope ? `[${scope}] ` : '';
    const line = `${time} ${tag} ${prefix}`;
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
