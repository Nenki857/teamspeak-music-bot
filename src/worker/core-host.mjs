import { Worker, MessageChannel } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { CatalogClient, CATALOG_METHODS } from './catalog-client.mjs';

// The control server must never execute on the audio/TS event loop.
export class IsolatedCore {
  constructor({ key, dataDirectory, onChange = () => {}, onDisconnect = () => {}, onFailure = () => {}, engineModule, timeoutMs = 60000 }) {
    Object.assign(this, { onChange, onDisconnect, onFailure, timeoutMs });
    this.pending = new Map(); this.closed = false; this.player = { connected: false, playing: false, paused: false, queue: [], revision: 0 };
    this.auth = { loggedIn: false }; this.healthState = { supported: false, isolatedCore: true };
    const { port1, port2 } = new MessageChannel();
    this.catalog = new CatalogClient(port1, { timeoutMs }); this.configuration = Promise.resolve();
    this.worker = new Worker(new URL('./core-worker-entry.mjs', import.meta.url), { stdout: true, stderr: true,
      env: { ...process.env, TSMD_DATA_DIR: dataDirectory }, workerData: { key, dataDirectory, engineModule, catalogPort: port2 }, transferList: [port2] });
    this.worker.stdout.resume(); this.worker.stderr.resume();
    this.ready = new Promise((accept, reject) => { this.acceptReady = accept; this.rejectReady = reject; });
    this.ready.catch(() => {});
    this.catalog.ready.catch(() => this.fail('音乐目录初始化失败，请重新打开工具'));
    this.readyTimer = setTimeout(() => this.fail('播放内核初始化超时，请重新打开工具'), timeoutMs);
    this.worker.on('message', message => {
      if (message.type === 'state' || message.type === 'ready' || message.type === 'reply') this.applyState(message.state);
      if (message.type === 'ready') { clearTimeout(this.readyTimer); this.acceptReady(); }
      else if (message.type === 'state' && message.notify) this.onChange();
      else if (message.type === 'diagnostic') this.onChange({ diagnostic: message.diagnostic });
      else if (message.type === 'channelJoin' && !this.closed && !this.failure) this.onChange({ channelJoin: message.event });
      else if (message.type === 'disconnected') this.onDisconnect();
      else if (message.type === 'fatal') this.fail('播放内核初始化失败，请重新打开工具');
      else if (message.type === 'reply') {
        const request = this.pending.get(message.id); if (!request) return;
        this.pending.delete(message.id); clearTimeout(request.timer);
        if (message.ok) request.accept(message.result);
        else request.reject(new Error(message.error || '播放操作失败，请重试'));
      } else if (message.type === 'closed') this.acceptClose?.();
    });
    this.worker.on('error', () => this.fail('播放内核工作线程异常，请重新打开工具'));
    this.worker.on('exit', () => { this.exited = true; this.acceptClose?.(); if (!this.closed) this.fail('播放内核已停止，请重新打开工具'); });
    this.provider = Object.fromEntries(CATALOG_METHODS.map(method => [method, async (...args) => {
      await this.configuration;
      if (this.closed || this.failure) throw new Error(this.failure || '播放内核已关闭');
      return this.catalog.call(method, args);
    }]));
  }
  applyState(state) {
    if (!state || this.failure || this.closed) return;
    this.player = { ...this.player, ...state.player };
    this.auth = state.auth; this.healthState = state.audioHealth;
  }
  fail(message) {
    if (this.failure || this.closed) return;
    this.failure = message; clearTimeout(this.readyTimer); this.rejectReady(new Error(message));
    this.catalog.close();
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error(message)); }
    this.pending.clear(); this.player = { ...this.player, connected: false, playing: false, paused: false };
    this.healthState = { ...this.healthState, state: 'idle', supported: false };
    this.onDisconnect();
    this.onFailure();
  }
  async init() { await this.ready; await this.catalog.ready; }
  status() { return this.player; }
  health() { return this.healthState; }
  exportQueue() { return this.call('exportQueue'); }
  sendShareAnnouncement(event) { return this.call('sendShareAnnouncement', [event]); }
  announcementTarget() { return this.call('announcementTarget'); }
  call(method, args = []) {
    if (this.closed || this.failure) return Promise.reject(new Error(this.failure || '播放内核已关闭'));
    if (this.pending.size >= 64) return Promise.reject(new Error('播放请求较多，请稍后重试'));
    return new Promise((accept, reject) => {
      const id = randomUUID(); const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('播放操作超时，请重试')); }, this.timeoutMs);
      this.pending.set(id, { accept, reject, timer });
      try { this.worker.postMessage({ type: 'call', id, method, args }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('播放操作发送失败，请重试')); }
    });
  }
  start(preset) { return this.call('start', [preset]); }
  stop() { return this.failure ? Promise.resolve() : this.call('stop'); }
  removeBot(id) { return this.call('removeBot', [id]); }
  channels() { return this.call('channels'); }
  configureMusic(method, args = []) {
    const operation = this.configuration.then(async () => {
      if (method === 'setQuality' || method === 'logout' || method === 'importCookie' || method === 'acceptOfficialLogin') this.catalog.invalidate();
      try { return await this.call(method, args); }
      // The audio worker fences its configuration messages before replying.
      // Drain invalidations on the direct port before releasing new reads;
      // ordinary auth checks and pending QR polls must retain the cache.
      finally { await this.catalog.sync().catch(() => {}); }
    });
    this.configuration = operation.catch(() => {}); return operation;
  }
  setQuality(value) { return this.configureMusic('setQuality', [value]); }
  qr() { return this.call('qr'); }
  qrCheck() { return this.configureMusic('qrCheck'); }
  refreshAuth() { return this.configureMusic('refreshAuth'); }
  importCookie(cookie) { return this.configureMusic('importCookie', [cookie]); }
  acceptOfficialLogin(cookie, profile) { return this.configureMusic('acceptOfficialLogin', [cookie, profile]); }
  logout() { return this.configureMusic('logout'); }
  command(method, args, name) { return this.call('command', [method, args, name]); }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true; clearTimeout(this.readyTimer); this.rejectReady(new Error('播放内核已关闭'));
    this.catalog.close();
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('播放内核已关闭')); }
    this.pending.clear();
    this.closePromise = (async () => {
      if (this.exited) return;
      let timer;
      const exited = new Promise(accept => { this.acceptClose = accept; timer = setTimeout(accept, 2500); });
      try { this.worker.postMessage({ type: 'close' }); await exited; }
      finally { clearTimeout(timer); await this.worker.terminate(); }
    })();
    return this.closePromise;
  }
}
