import test from 'node:test';
import assert from 'node:assert/strict';

import { loadImage } from '../src/openai/images.mjs';
import { collectImages } from '../src/openai/request.mjs';

test('loadImage: 解析 data URL', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const image = await loadImage(`data:image/png;base64,${png.toString('base64')}`);
  assert.equal(image.mime, 'image/png');
  assert.deepEqual(image.buffer, png);
  assert.match(image.name, /\.png$/);
});

test('loadImage: 非图片/空地址报错', async () => {
  await assert.rejects(() => loadImage(''), /image_url 为空/);
  await assert.rejects(() => loadImage('ftp://x/y.png'), /不支持的图片地址/);
});

test('loadImage: http 下载（注入 fetch）', async () => {
  const body = Buffer.from([1, 2, 3]);
  const fakeFetch = async () => new Response(body, { headers: { 'content-type': 'image/webp' } });
  const image = await loadImage('https://example.com/a.webp', { fetchImpl: fakeFetch });
  assert.equal(image.mime, 'image/webp');
  assert.deepEqual(image.buffer, body);
});

test('collectImages: 只收 user 的图片部分', () => {
  const images = collectImages([
    { role: 'system', content: 'x' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '看这两张' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
        { type: 'input_image', image_url: 'https://x/y.jpg' },
      ],
    },
    { role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'ignored' } }] },
  ]);
  assert.equal(images.length, 2);
  assert.equal(images[1].url, 'https://x/y.jpg');
});
