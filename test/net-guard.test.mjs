import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  assertSafeRemoteUrl,
  fetchRemoteSafely,
  isBlockedAddress,
  isBlockedHostname,
} from '../src/net-guard.mjs';
import { loadImage } from '../src/openai/images.mjs';

/**
 * SSRF 防护。
 *
 * 背景：image_url 支持 http(s) 链接，服务端会主动去拉。
 * 不设防的话，任何能调 API 的人都能让服务器请求内网地址
 * （127.0.0.1 / 169.254.169.254 云元数据 / 内网面板），
 * 并靠错误差异做内网端口探活。
 */

test('isBlockedAddress: 环回 / 私网 / 链路本地全部拦截', () => {
  const blocked = [
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.5',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // 云元数据
    '100.64.0.1', // CGNAT
    '224.0.0.1', // 组播
    '255.255.255.255',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
  ];
  for (const ip of blocked) {
    assert.equal(isBlockedAddress(ip), true, `${ip} 应该被拦截`);
  }
});

test('isBlockedAddress: 公网地址放行', () => {
  const allowed = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2001:4860::8888'];
  for (const ip of allowed) {
    assert.equal(isBlockedAddress(ip), false, `${ip} 应该放行`);
  }
});

test('isBlockedAddress: IPv4-mapped IPv6 按 IPv4 规则判', () => {
  assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedAddress('::ffff:8.8.8.8'), false);
});

test('isBlockedAddress: 非法输入一律当禁止', () => {
  for (const bad of ['', null, undefined, 'not-an-ip', '999.1.1.1']) {
    assert.equal(isBlockedAddress(bad), true);
  }
});

test('isBlockedHostname: localhost / 内网后缀 / 元数据主机名', () => {
  for (const host of ['localhost', 'LOCALHOST', 'a.localhost', 'x.internal', 'y.local', 'metadata.google.internal']) {
    assert.equal(isBlockedHostname(host), true, `${host} 应该拦截`);
  }
  for (const host of ['example.com', 'cdn.example.org', '8.8.8.8']) {
    assert.equal(isBlockedHostname(host), false, `${host} 应该放行`);
  }
});

test('assertSafeRemoteUrl: 拒绝非 http(s) 协议', () => {
  assert.throws(() => assertSafeRemoteUrl('file:///etc/passwd'), /只支持 http\/https/);
  assert.throws(() => assertSafeRemoteUrl('ftp://x/y.png'), /只支持 http\/https/);
  assert.throws(() => assertSafeRemoteUrl('gopher://x/'), /只支持 http\/https/);
});

test('assertSafeRemoteUrl: 拒绝内网 IP 字面量', () => {
  assert.throws(() => assertSafeRemoteUrl('http://127.0.0.1:8787/admin/api/overview'), /内网/);
  assert.throws(() => assertSafeRemoteUrl('http://169.254.169.254/latest/meta-data/'), /内网/);
  assert.throws(() => assertSafeRemoteUrl('http://[::1]:8080/'), /内网/);
  assert.throws(() => assertSafeRemoteUrl('http://192.168.0.1/'), /内网/);
});

test('assertSafeRemoteUrl: 拒绝 localhost 与内网域名', () => {
  assert.throws(() => assertSafeRemoteUrl('http://localhost:8787/'), /内网/);
  assert.throws(() => assertSafeRemoteUrl('http://db.internal/'), /内网/);
});

test('assertSafeRemoteUrl: 拒绝带 userinfo 的混淆地址', () => {
  // http://evil.com@127.0.0.1/ 的真实主机是 127.0.0.1
  assert.throws(() => assertSafeRemoteUrl('http://evil.com@127.0.0.1/'), /账号密码|内网/);
});

test('assertSafeRemoteUrl: 公网地址放行', () => {
  const url = assertSafeRemoteUrl('https://example.com/a.png');
  assert.equal(url.hostname, 'example.com');
});

test('fetchRemoteSafely: 真连本地服务会被拦截，且不发出请求', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('内网机密');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    await assert.rejects(
      () => fetchRemoteSafely(`http://127.0.0.1:${port}/`, { maxBytes: 1024, timeoutMs: 2000 }),
      (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.code, 'image_url_blocked');
        return true;
      },
    );
    // 关键断言：内网服务一次都没被打到
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hits, 0, '被拦截的地址不应该真正建立连接');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('safeLookup: 解析到内网 IP 的主机名在建连前被拒绝', async () => {
  const { safeLookup } = await import('../src/net-guard.mjs');
  const lookup = safeLookup();

  // localhost 会解析到 127.0.0.1 / ::1，必须被拦
  await new Promise((resolve) => {
    lookup('localhost', {}, (err) => {
      assert.ok(err, '应该返回错误');
      assert.equal(err.code, 'ERR_SSRF_BLOCKED');
      resolve();
    });
  });
});

test('loadImage: data URL 不受影响', async () => {
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const image = await loadImage(`data:image/png;base64,${png.toString('base64')}`);
  assert.equal(image.mime, 'image/png');
});

test('loadImage: 内网地址直接 400，且不发起请求', async () => {
  await assert.rejects(
    () => loadImage('http://169.254.169.254/latest/meta-data/'),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'image_url_blocked');
      return true;
    },
  );
  await assert.rejects(() => loadImage('http://localhost/a.png'), (err) => err.code === 'image_url_blocked');
});

test('loadImage: 注入 fetchImpl 时仍先做静态校验', async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return new Response(Buffer.from([1]), { headers: { 'content-type': 'image/png' } });
  };
  await assert.rejects(
    () => loadImage('http://127.0.0.1/x.png', { fetchImpl: fakeFetch }),
    (err) => err.code === 'image_url_blocked',
  );
  assert.equal(called, false, '被拦截的地址不应该发起任何请求');
});
