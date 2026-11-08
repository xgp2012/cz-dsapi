import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import { ApiError } from './errors.mjs';

/**
 * SSRF 防护：限制「服务端主动去拉取的 URL」只能落在公网。
 *
 * 为什么要做：`/v1/chat/completions` 的 `image_url` 支持 http(s) 链接，
 * 服务端会直接 fetch 它。不做限制的话，任何能调用 API 的人都能让服务器
 * 去请求内网地址（`http://127.0.0.1:8787/admin/api/overview`、
 * `http://169.254.169.254/` 云元数据、内网数据库面板……），
 * 并且通过「下载失败 / 不是图片 / 图片过大」这些错误差异做**内网端口探活**。
 *
 * 三层防护，缺一不可：
 * 1. **协议白名单**：只允许 http / https；
 * 2. **DNS 解析后校验 IP**：域名可以解析到 127.0.0.1，光看主机名没用；
 * 3. **连接时再校验一次**（`lookup` 回调）——只做第 2 步不够：攻击者可以
 *    让第一次解析返回公网 IP 通过校验，第二次解析返回 127.0.0.1（DNS rebinding）。
 *    把校验放进实际建立 TCP 连接用的 `lookup` 里，校验的 IP 和真正连的 IP
 *    永远是同一个。
 *
 * 另外还要禁止跟随重定向：公网地址 302 到内网地址是绕过单次校验的经典手法。
 */

/** 私网 / 保留网段（IPv4 + IPv6） */
const BLOCKED_V4 = [
  ['0.0.0.0', 8], // "本网络"
  ['10.0.0.0', 8], // 私有
  ['100.64.0.0', 10], // 运营商级 NAT
  ['127.0.0.0', 8], // 环回
  ['169.254.0.0', 16], // 链路本地（含云元数据 169.254.169.254）
  ['172.16.0.0', 12], // 私有
  ['192.0.0.0', 24], // IETF 协议分配
  ['192.0.2.0', 24], // 文档用
  ['192.168.0.0', 16], // 私有
  ['198.18.0.0', 15], // 基准测试
  ['198.51.100.0', 24], // 文档用
  ['203.0.113.0', 24], // 文档用
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留 / 广播
];

const BLOCKED_V6 = [
  ['::', 128], // 未指定
  ['::1', 128], // 环回
  ['fc00::', 7], // 唯一本地地址
  ['fe80::', 10], // 链路本地
  ['ff00::', 8], // 组播
  ['100::', 64], // 丢弃前缀
  ['2001:db8::', 32], // 文档用
];

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inV4Range(ipInt, base, bits) {
  const baseInt = ipv4ToInt(base);
  if (baseInt === null || ipInt === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

/** 把 IPv6 文本展开成 16 个字节；失败返回 null */
function ipv6ToBytes(ip) {
  let addr = ip;
  // 去掉 zone id（fe80::1%eth0）
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);

  // 处理内嵌 IPv4（::ffff:127.0.0.1）
  let tail = [];
  const lastColon = addr.lastIndexOf(':');
  if (lastColon >= 0 && addr.slice(lastColon + 1).includes('.')) {
    const v4 = ipv4ToInt(addr.slice(lastColon + 1));
    if (v4 === null) return null;
    tail = [(v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff];
    addr = addr.slice(0, lastColon + 1);
    if (addr.endsWith('::')) addr = addr.slice(0, -1);
    else if (addr.endsWith(':')) addr = addr.slice(0, -1);
  }

  const halves = addr.split('::');
  if (halves.length > 2) return null;

  const parseGroups = (s) =>
    s
      ? s.split(':').filter((x) => x !== '').map((g) => Number.parseInt(g, 16))
      : [];

  const head = parseGroups(halves[0]);
  const rest = halves.length === 2 ? parseGroups(halves[1]) : [];
  if ([...head, ...rest].some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;

  const totalGroups = 8 - tail.length / 2;
  const missing = totalGroups - head.length - rest.length;
  if (missing < 0) return null;
  const groups = [...head, ...new Array(halves.length === 2 ? missing : 0).fill(0), ...rest];

  const bytes = [];
  for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
  return [...bytes, ...tail];
}

function inV6Range(bytes, base, bits) {
  const baseBytes = ipv6ToBytes(base);
  if (!baseBytes || !bytes) return false;
  const fullBytes = bits >> 3;
  for (let i = 0; i < fullBytes; i += 1) {
    if (bytes[i] !== baseBytes[i]) return false;
  }
  const remBits = bits & 7;
  if (remBits) {
    const mask = 0xff << (8 - remBits);
    if ((bytes[fullBytes] & mask) !== (baseBytes[fullBytes] & mask)) return false;
  }
  return true;
}

/**
 * 判断一个 IP 字面量是否属于禁止访问的网段。
 * @param {string} ip
 * @returns {boolean} true = 禁止
 */
export function isBlockedAddress(ip) {
  if (typeof ip !== 'string' || !ip) return true;

  const family = net.isIP(ip);
  if (family === 4) {
    const value = ipv4ToInt(ip);
    if (value === null) return true;
    return BLOCKED_V4.some(([base, bits]) => inV4Range(value, base, bits));
  }
  if (family === 6) {
    const bytes = ipv6ToBytes(ip);
    if (!bytes) return true;
    // IPv4-mapped（::ffff:1.2.3.4）要按 IPv4 规则再判一次
    const isMapped =
      bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
    if (isMapped) return isBlockedAddress(bytes.slice(12).join('.'));
    return BLOCKED_V6.some(([base, bits]) => inV6Range(bytes, base, bits));
  }
  // 不是合法 IP 字面量：交给 DNS 解析，这里不当成"已通过"
  return true;
}

/** 不允许访问的主机名（DNS 层也可能拦，这里先挡掉明显的内网名字） */
export function isBlockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  // localhost 及其子域
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  // 常见内网后缀
  if (/\.(local|internal|intranet|lan|home|corp|localdomain)$/.test(host)) return true;
  // 云元数据主机名
  if (host === 'metadata.google.internal') return true;
  return false;
}

/**
 * 校验目标 URL 是否允许服务端主动访问。
 * @param {string} rawUrl
 * @throws {ApiError} 400 当协议/主机不允许
 * @returns {URL}
 */
export function assertSafeRemoteUrl(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ApiError(400, `图片地址不是合法 URL：${String(rawUrl).slice(0, 80)}`, { code: 'invalid_image' });
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(400, `图片地址只支持 http/https，收到 ${url.protocol}`, { code: 'image_url_blocked' });
  }
  // URL 里的 userinfo 常被用来混淆真实主机（http://evil.com@127.0.0.1/）
  if (url.username || url.password) {
    throw new ApiError(400, '图片地址不允许包含账号密码信息', { code: 'image_url_blocked' });
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (isBlockedHostname(hostname)) {
    throw new ApiError(400, `图片地址指向内网主机，已拒绝：${hostname}`, { code: 'image_url_blocked' });
  }
  // 主机名本身就是 IP 字面量的情况（URL 不会做 DNS 解析）
  if (net.isIP(hostname) && isBlockedAddress(hostname)) {
    throw new ApiError(400, `图片地址指向内网 IP，已拒绝：${hostname}`, { code: 'image_url_blocked' });
  }

  return url;
}

/**
 * 一个在连接阶段做 IP 校验的 lookup。
 * Node 的 http/https agent 都支持 `lookup` 选项，传入后**真正用于建连的地址**
 * 就是这里返回的地址 —— 校验和连接是同一个 IP，DNS rebinding 无法绕过。
 */
export function safeLookup(logger) {
  return function lookup(hostname, options, callback) {
    // Node ≥ 18 的签名可能是 (hostname, options, cb)，也可能是 (hostname, cb)
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options ? options : {};
    const wantAll = opts.all === true;

    dns
      .lookup(hostname, { all: true, family: opts.family || 0 })
      .then((addresses) => {
        if (!addresses?.length) {
          const err = new Error(`DNS 解析失败：${hostname}`);
          err.code = 'ENOTFOUND';
          return cb(err);
        }
        const blocked = addresses.filter((a) => isBlockedAddress(a.address));
        if (blocked.length) {
          logger?.warn?.('拒绝连接到内网地址', { hostname, address: blocked[0].address });
          const err = new Error(`拒绝连接到内网地址：${hostname} → ${blocked[0].address}`);
          err.code = 'ERR_SSRF_BLOCKED';
          return cb(err);
        }
        if (wantAll) return cb(null, addresses);
        const first = addresses[0];
        return cb(null, first.address, first.family);
      })
      .catch((err) => cb(err));
  };
}

/**
 * 带 SSRF 防护的 HTTP(S) 请求，等价于一个极简的 fetch：
 * - 不跟随重定向（3xx 直接当失败，避免公网 302 到内网）；
 * - 建连时校验 IP（safeLookup）；
 * - 有总超时和大小上限，超了就断开，不把整个内网文件读进内存。
 *
 * @param {string} rawUrl
 * @param {{ maxBytes: number, timeoutMs: number, logger?: object }} options
 * @returns {Promise<{ status: number, headers: object, buffer: Buffer }>}
 */
export async function fetchRemoteSafely(rawUrl, { maxBytes, timeoutMs, logger } = {}) {
  const url = assertSafeRemoteUrl(rawUrl);
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    const req = client.request(
      url,
      {
        method: 'GET',
        lookup: safeLookup(logger),
        // 不跟随重定向：直接拒绝
        headers: { accept: 'image/*' },
        timeout: timeoutMs,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return finish(
            reject,
            new ApiError(400, `图片地址返回了重定向（${status}），出于安全考虑不跟随`, {
              code: 'image_url_blocked',
            }),
          );
        }
        if (status < 200 || status >= 300) {
          res.resume();
          const err = new ApiError(400, `下载图片失败：HTTP ${status}`, { code: 'image_download_failed' });
          return finish(reject, err);
        }

        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && maxBytes && declared > maxBytes) {
          res.destroy();
          return finish(
            reject,
            new ApiError(400, `图片过大（${(declared / 1024 / 1024).toFixed(1)}MB）`, {
              code: 'image_too_large',
            }),
          );
        }

        const chunks = [];
        let size = 0;

        res.on('data', (chunk) => {
          size += chunk.length;
          if (maxBytes && size > maxBytes) {
            res.destroy();
            finish(
              reject,
              new ApiError(400, `图片过大（超过 ${(maxBytes / 1024 / 1024).toFixed(0)}MB）`, {
                code: 'image_too_large',
              }),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => finish(resolve, { status, headers: res.headers, buffer: Buffer.concat(chunks) }));
        res.on('error', (err) => finish(reject, err));
      },
    );

    const timer = setTimeout(() => {
      req.destroy();
      finish(reject, new ApiError(400, `下载图片超时（${timeoutMs}ms）`, { code: 'image_download_failed' }));
    }, timeoutMs);
    timer.unref?.();

    req.on('timeout', () => {
      req.destroy();
      finish(reject, new ApiError(400, `下载图片超时（${timeoutMs}ms）`, { code: 'image_download_failed' }));
    });
    req.on('error', (err) => {
      if (err?.code === 'ERR_SSRF_BLOCKED') {
        return finish(
          reject,
          new ApiError(400, `图片地址解析到了内网 IP，已拒绝：${url.hostname}`, { code: 'image_url_blocked' }),
        );
      }
      finish(reject, new ApiError(400, `下载图片失败：${err.message}`, { code: 'image_download_failed' }));
    });
    req.end();
  });
}
