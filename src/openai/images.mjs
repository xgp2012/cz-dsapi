import { ApiError } from '../errors.mjs';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

/**
 * 从 OpenAI 的 image_url 里取出图片字节。
 * 支持 data:image/png;base64,... 和 http(s) 链接。
 */
export async function loadImage(url, { fetchImpl = fetch } = {}) {
  if (typeof url !== 'string' || !url.trim()) {
    throw new ApiError(400, 'image_url 为空', { code: 'invalid_image' });
  }

  const trimmed = url.trim();

  if (trimmed.startsWith('data:')) {
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(trimmed);
    if (!match) throw new ApiError(400, '无法解析 data URL 图片', { code: 'invalid_image' });
    const mime = match[1] || 'image/png';
    const isBase64 = Boolean(match[2]);
    const raw = isBase64 ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]));
    assertSize(raw.length);
    return { buffer: raw, mime, name: `image-${Date.now()}.${extOf(mime)}` };
  }

  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ApiError(400, `不支持的图片地址：${trimmed.slice(0, 60)}`, { code: 'invalid_image' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(trimmed, { signal: controller.signal });
    if (!res.ok) {
      throw new ApiError(400, `下载图片失败：HTTP ${res.status}`, { code: 'image_download_failed' });
    }
    const mime = String(res.headers.get('content-type') || 'image/png').split(';')[0];
    if (!mime.startsWith('image/')) {
      throw new ApiError(400, `这个 URL 不是图片（${mime}）`, { code: 'invalid_image' });
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    assertSize(buffer.length);
    return { buffer, mime, name: `image-${Date.now()}.${extOf(mime)}` };
  } finally {
    clearTimeout(timer);
  }
}

function assertSize(bytes) {
  if (bytes > MAX_IMAGE_BYTES) {
    throw new ApiError(400, `图片过大（${(bytes / 1024 / 1024).toFixed(1)}MB），上限 10MB`, {
      code: 'image_too_large',
    });
  }
  if (!bytes) throw new ApiError(400, '图片内容为空', { code: 'invalid_image' });
}

function extOf(mime) {
  const map = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
  return map[mime] || 'bin';
}
