import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

const METHODS = ['search', 'getSongUrl', 'getSongDetail', 'getPlaylistSongs', 'getRecommendPlaylists', 'getAlbumSongs',
  'getLyrics', 'getQrCode', 'checkQrCodeStatus', 'getAuthStatus', 'getPersonalFm', 'getDailyRecommendSongs', 'getUserPlaylists', 'getPlaylistDetail', 'getArtistPage', 'getArtistAlbums', 'getAlbumPage', 'searchUsers', 'getPublicUserPlaylists', 'getPublicPlaylist', 'getPublicSongs'];
const CACHED = new Set(['getUserPlaylists', 'getRecommendPlaylists', 'getPlaylistSongs', 'getPlaylistDetail', 'search', 'getArtistPage', 'getArtistAlbums', 'getAlbumPage', 'searchUsers', 'getPublicUserPlaylists', 'getPublicPlaylist', 'getPublicSongs']);

// Music API crypto, JSON parsing and metadata mapping must not share the 20ms audio loop.
export class IsolatedMusicProvider {
  constructor({ apiModule, timeoutMs = 45000 } = {}) {
    this.platform = 'netease'; this.cookie = ''; this.quality = 'exhigh'; this.epoch = 0;
    this.pending = new Map(); this.cache = new Map(); this.inflight = new Map(); this.closed = false; this.timeoutMs = timeoutMs;
    this.worker = new Worker(new URL('./music-worker-entry.mjs', import.meta.url), { stdout: true, stderr: true, workerData: { apiModule } });
    // Upstream logs can contain credentials and signed URLs; never forward them.
    this.worker.stdout.resume(); this.worker.stderr.resume();
    this.ready = new Promise((accept, reject) => { this.acceptReady = accept; this.rejectReady = reject; });
    this.ready.catch(() => {});
    this.readyTimer = setTimeout(() => this.fail('音乐服务初始化超时，请重新打开工具'), timeoutMs);
    this.worker.on('message', message => {
      if (message.type === 'ready') { clearTimeout(this.readyTimer); this.acceptReady(); return; }
      if (message.type === 'fatal') { this.fail('音乐服务初始化失败，请重新打开工具'); return; }
      const request = this.pending.get(message.id); if (!request) return;
      this.pending.delete(message.id); clearTimeout(request.timer);
      if (request.epoch !== this.epoch) { request.reject(new Error('账号状态已变化，请重试')); return; }
      if (!message.ok) { request.reject(Object.assign(new Error(message.error || '音乐请求失败，请重试'), { status: message.status, neteaseCode: message.neteaseCode, localCooldown: message.localCooldown, retryAfterMs: message.retryAfterMs })); return; }
      if (typeof message.cookie === 'string' && message.cookie !== this.cookie) this.setCookie(message.cookie);
      request.accept(message.result);
    });
    this.worker.on('error', () => this.fail('音乐服务工作线程异常，请重新打开工具'));
    this.worker.on('exit', () => { if (!this.closed) this.fail('音乐服务工作线程已停止，请重新打开工具'); });
    for (const method of METHODS) this[method] = (...args) => this.call(method, args);
  }
  fail(message) {
    clearTimeout(this.readyTimer); this.failure = message; this.rejectReady(new Error(message));
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)); }
    this.pending.clear(); this.inflight.clear(); this.cache.clear();
  }
  setCookie(cookie) {
    this.cookie = cookie; this.epoch++; this.cache.clear(); this.inflight.clear();
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('账号状态已变化，请重试')); }
    this.pending.clear();
    if (!this.closed) this.worker.postMessage({ type: 'config', cookie, quality: this.quality });
  }
  getCookie() { return this.cookie; }
  setQuality(quality) { this.quality = quality; if (!this.closed) this.worker.postMessage({ type: 'config', cookie: this.cookie, quality }); }
  getQuality() { return this.quality; }
  async attachCatalogPort(port) {
    await this.ready;
    if (this.closed || this.failure) throw new Error(this.failure || '音乐服务已关闭');
    this.worker.postMessage({ type: 'catalog-port', port }, [port]);
  }
  flushConfiguration() { return this.call('syncConfiguration', []); }
  call(method, args) {
    if (this.closed || this.failure) return Promise.reject(new Error(this.failure || '音乐服务已关闭'));
    const key = method + ':' + JSON.stringify(args); const cached = this.cache.get(key);
    if (CACHED.has(method) && cached && Date.now() - cached.at < 30000) return Promise.resolve(cached.value);
    if (CACHED.has(method) && this.inflight.has(key)) return this.inflight.get(key);
    if (this.pending.size >= 32) return Promise.reject(new Error('音乐请求较多，请稍后重试'));
    const epoch = this.epoch;
    const promise = new Promise((accept, reject) => {
      const id = randomUUID(); const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('音乐请求超时，请重试')); }, this.timeoutMs);
      this.pending.set(id, { accept, reject, timer, epoch });
      try { this.worker.postMessage({ type: 'call', id, method, args }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('音乐请求发送失败，请重试')); }
    }).then(value => {
      if (CACHED.has(method) && epoch === this.epoch) {
        this.cache.delete(key); this.cache.set(key, { at: Date.now(), value });
        if (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value);
      }
      return value;
    });
    if (CACHED.has(method)) {
      this.inflight.set(key, promise);
      const done = () => { if (this.inflight.get(key) === promise) this.inflight.delete(key); };
      promise.then(done, done);
    }
    return promise;
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.fail('音乐服务已关闭'); this.cookie = '';
    return this.worker.terminate();
  }
}
