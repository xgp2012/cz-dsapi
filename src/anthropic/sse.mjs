/**
 * Anthropic 的 SSE 格式比 OpenAI 多一个 event: 行：
 *
 *   event: content_block_delta
 *   data: {"type":"content_block_delta",...}
 *
 * data 里也带一份 type，两边保持一致。
 */
export class AnthropicSse {
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

  event(name, payload) {
    if (this.closed) return false;
    return this.res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  end() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    this.res.end();
  }
}
