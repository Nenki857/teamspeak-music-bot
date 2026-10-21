import { randomUUID } from 'node:crypto';

export const CATALOG_METHODS = ['getLyrics', 'search', 'getUserPlaylists', 'getRecommendPlaylists', 'getPlaylistDetail', 'getPlaylistSongs', 'getArtistPage', 'getArtistAlbums', 'getAlbumPage', 'searchUsers', 'getPublicUserPlaylists', 'getPublicPlaylist', 'getPublicSongs'];
const ALLOWED = new Set(CATALOG_METHODS);

// This port connects the control server straight to the music worker. Large
// catalog responses never enter the playback worker's event loop or heap.
export class CatalogClient {
  constructor(port, { timeoutMs = 45000 } = {}) {
    Object.assign(this, { port, timeoutMs });
    this.pending = new Map(); this.syncs = new Map(); this.cache = new Map(); this.inflight = new Map();
    this.epoch = 0; this.generation = 0; this.closed = false;
    this.ready = new Promise((accept, reject) => { this.acceptReady = accept; this.rejectReady = reject; });
    this.ready.catch(() => {});
    this.readyTimer = setTimeout(() => this.fail('音乐目录初始化超时，请重新打开工具'), timeoutMs);
    port.on('message', message => this.receive(message));
    port.on('close', () => { if (!this.closed) this.fail('音乐目录连接已关闭，请重新打开工具'); });
    port.on('messageerror', () => this.fail('音乐目录响应读取失败，请重新打开工具'));
  }
  receive(message) {
    if (this.closed || this.failure) return;
    if (message.type === 'ready') { clearTimeout(this.readyTimer); this.generation = message.generation; this.acceptReady(); return; }
    if (message.type === 'invalidate') { this.invalidate(message.generation); return; }
    if (message.type === 'synced') {
      const pending = this.syncs.get(message.id); if (!pending) return;
      this.syncs.delete(message.id); clearTimeout(pending.timer);
      if (message.generation !== this.generation) this.invalidate(message.generation);
      pending.accept(); return;
    }
    const pending = this.pending.get(message.id); if (!pending) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (pending.epoch !== this.epoch || message.generation !== this.generation) { pending.reject(new Error('账号状态已变化，请重试')); return; }
    if (!message.ok) { pending.reject(Object.assign(new Error(message.error || '音乐请求失败，请重试'), { status: message.status, neteaseCode: message.neteaseCode, localCooldown: message.localCooldown, retryAfterMs: message.retryAfterMs })); return; }
    pending.accept(message.result);
  }
  invalidate(generation = this.generation) {
    this.generation = generation; this.epoch++; this.cache.clear(); this.inflight.clear();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('账号状态已变化，请重试')); }
    this.pending.clear();
  }
  async call(method, args = []) {
    if (!ALLOWED.has(method)) throw new Error('音乐目录操作不可用');
    await this.ready;
    if (this.closed || this.failure) throw new Error(this.failure || '音乐目录已关闭');
    const key = method + ':' + JSON.stringify(args), cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 30000) return cached.value;
    if (this.inflight.has(key)) return this.inflight.get(key);
    if (this.pending.size >= 32) throw new Error('音乐请求较多，请稍后重试');
    const epoch = this.epoch;
    const promise = new Promise((accept, reject) => {
      const id = randomUUID(); const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('音乐请求超时，请重试')); }, this.timeoutMs);
      this.pending.set(id, { accept, reject, timer, epoch });
      try { this.port.postMessage({ type: 'call', id, method, args }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('音乐请求发送失败，请重试')); }
    }).then(value => {
      if (epoch === this.epoch && !this.closed && !this.failure) {
        this.cache.delete(key); this.cache.set(key, { at: Date.now(), value });
        if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value);
      }
      return value;
    });
    this.inflight.set(key, promise);
    const done = () => { if (this.inflight.get(key) === promise) this.inflight.delete(key); };
    promise.then(done, done); return promise;
  }
  async sync() {
    await this.ready;
    if (this.closed || this.failure) throw new Error(this.failure || '音乐目录已关闭');
    return new Promise((accept, reject) => {
      const id = randomUUID(); const timer = setTimeout(() => { this.syncs.delete(id); reject(new Error('音乐目录状态同步超时')); }, this.timeoutMs);
      this.syncs.set(id, { accept, reject, timer });
      try { this.port.postMessage({ type: 'sync', id }); }
      catch { clearTimeout(timer); this.syncs.delete(id); reject(new Error('音乐目录状态同步失败')); }
    });
  }
  fail(message) {
    if (this.failure) return;
    this.failure = message; clearTimeout(this.readyTimer); this.rejectReady(new Error(message));
    for (const pending of [...this.pending.values(), ...this.syncs.values()]) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear(); this.syncs.clear(); this.cache.clear(); this.inflight.clear();
    this.port.close();
  }
  close() { if (this.closed) return; this.closed = true; this.fail('音乐目录已关闭'); this.port.close(); }
}
