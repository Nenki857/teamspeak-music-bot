// Explicit dependency injection only. Never launches cloudflared or uses the network.
export class TestTunnel {
  constructor(changed, options = {}) { this.changed = changed; this.options = options; this.state = { status: 'off', url: '' }; this.starts = 0; this.waiting = []; }
  async start(port) {
    this.stop(); this.starts++; this.port = port; this.state = { status: 'connecting', url: '' }; this.changed();
    if (this.options.defer) await new Promise((accept, reject) => this.waiting.push({ accept, reject }));
    if (this.options.fail || this.starts <= (this.options.failStarts || 0)) { this.state = { status: 'error', url: '', error: 'Synthetic tunnel failure' }; this.changed(); throw new Error('Synthetic tunnel failure'); }
    this.state = { status: 'online', url: 'https://fixture.trycloudflare.com' }; this.changed(); return this.state;
  }
  complete() { const waiting = this.waiting.splice(0); for (const item of waiting) item.accept(); }
  stop() { for (const item of this.waiting.splice(0)) item.reject(new Error('Synthetic cancellation')); this.state = { status: 'off', url: '' }; this.changed(); }
}
