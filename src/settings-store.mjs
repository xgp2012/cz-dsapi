import fs from 'node:fs';
import path from 'node:path';

/**
 * 用户设置在磁盘上的持久化。
 *
 * 为什么不再写 .env：
 *
 *   1. 容器里 /app 是 root 只读、进程以 node 跑，.env 根本写不进去 ——
 *      「网页改配置」在 Docker 部署里原本是完全不可用的。
 *   2. 就算能写也没用：config.mjs 里环境变量的优先级高于 .env，
 *      compose 的 environment 已经把那批键占住了，写进 .env 的值会被静默忽略。
 *      这个失败模式最恶劣 —— 页面提示「已保存」，重启后却没变化。
 *
 * 所以改成写 `data/settings.json`：
 *   - data/ 本来就是唯一需要挂卷的目录（容器里已 chown 且可写），
 *     配置文件跟着号池、日志放在一起，一次挂卷全部持久化；
 *   - 它是**我们自己的**文件，格式由我们定，不受 compose 环境变量影响；
 *   - 优先级设计成「网页设置 > 环境变量 > 内置默认」，这样网页就是最终权威。
 *
 * 文件格式故意保持扁平（不嵌套），键名与环境变量完全一致：
 *   { "ENGINE": "direct", "CONCURRENCY": 4 }
 * 这样出问题时可以直接手改，也能一眼看懂，并且未来想再导回 .env 是无损的。
 */

export const SETTINGS_FILENAME = 'settings.json';

export function settingsPath(dataDir) {
  return path.join(dataDir, SETTINGS_FILENAME);
}

/**
 * 读取用户设置。
 *
 * 宽容优先：文件缺失 / 损坏 / 权限不足一律当作「没有用户设置」，
 * 绝不让一个坏掉的配置文件把服务卡在启动阶段 ——
 * 那会让用户连控制台都打不开来修它（这是本文件最重要的一条约束）。
 */
export function loadSettings(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { values: {}, broken: true };
    // 只保留标量值，防止有人手改出嵌套结构把后面搞崩
    const values = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) values[k] = v;
    }
    return { values, broken: false };
  } catch (err) {
    if (err.code === 'ENOENT') return { values: {}, broken: false };
    return { values: {}, broken: true, error: err.message };
  }
}

/**
 * 原子写入：先写临时文件再 rename。
 *
 * 直接覆盖的话，如果进程在写到一半时被杀（容器 SIGKILL、断电），
 * 会留下一个半截 JSON —— 用户所有配置一次性丢失，且无法恢复。
 * rename 在同一文件系统内是原子的，最坏情况是「要么全新、要么全旧」。
 */
export function saveSettings(file, values) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 目录是否可写（用于在页面上提前禁用表单，而不是等保存才报错） */
export function settingsWritable(file) {
  const dir = path.dirname(file);
  try {
    fs.accessSync(file, fs.constants.W_OK);
    return true;
  } catch {
    /* 文件不存在或不可写，再探目录 */
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把用户设置叠加到环境变量上，返回一个「合并后的 env」交给 loadConfig。
 *
 * 这里刻意不改 process.env 本身：
 *   - 保存后立即重载用的是合并视图，进程环境保持干净（便于排查「到底哪来的值」）；
 *   - 子进程（Chromium / ds-pow）继承的仍是原始环境，不会因为我们覆盖了某个键
 *     而出现「父进程一套、子进程另一套」的诡异问题。
 *
 * 值统一转成字符串，因为 loadConfig 内部是按 env（字符串）解析的。
 */
export function overlaySettings(env, values) {
  const merged = { ...env };
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null || v === '') continue;
    merged[k] = typeof v === 'string' ? v : String(v);
  }
  return merged;
}
