import { BaseSse } from '../sse.mjs';

/** 极简 SSE writer：只依赖 node:http 的 ServerResponse。 */
export class SseWriter extends BaseSse {
  send(payload) {
    if (this.closed) return false;
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    return this.writeFrame(`data: ${data}\n\n`);
  }

  done() {
    if (this.closed) return;
    this.send('[DONE]');
    this.end();
  }
}
