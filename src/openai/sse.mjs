/**
 * 极简 SSE writer：只依赖 node:http 的 ServerResponse。
 */
export class SseWriter {
  constructor(res, { keepAliveMs = 15_000 } = {}) {
    this.res = res;
    this.closed = false;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    this.keepAlive = setInterval(() => {
      if (!this.closed) this.res.write(': keep-alive\n\n');
    }, keepAliveMs);
    this.keepAlive.unref?.();
  }

  send(payload) {
    if (this.closed) return false;
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return this.res.write(`data: ${data}\n\n`);
  }

  done() {
    if (this.closed) return;
    this.send('[DONE]');
    this.end();
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    this.res.end();
  }
}
