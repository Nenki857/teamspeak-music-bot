import { isServerMusic, configureServerMusicBot, initialServerAuth, rememberServerAuth, refreshServerAuth } from './server-music-session.mjs';
import { musicRequestError } from './music-request-error.mjs';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { coreRoot, dataDir } from './paths.mjs';
import { pathToFileURL } from 'node:url';
import { createAudioClock } from './audio-clock.mjs';
import { createAudioHealth } from './audio-health.mjs';
import { IsolatedMusicProvider } from './music-provider.mjs';
import { normalizeNeteaseCookie } from './netease-cookie.mjs';
import { observeChannelJoins } from './channel-joins.mjs';
import { allowedShareUrl } from '../shared/public-url.mjs';
const coreImport = name => import(pathToFileURL(resolve(coreRoot, 'dist', name)).href);
export function safeError(error) {
  if ([-462, -460, 429].includes(Number(error?.neteaseCode ?? error?.body?.code ?? error?.status))) return musicRequestError(error).message;
  const status = error?.response?.status || error?.status;
  if (status === 301 || status === 401) return '登录已失效，请重新扫码';
  if (status === 403) return '音乐服务拒绝了请求，请稍后重试';
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(error?.code)) return '网络连接失败，请检查网络后重试';
  const message = String(error?.message || error?.body?.msg || '操作失败，请重试');
  if (/connect timeout/i.test(message)) return '连接服务器超时，请检查服务器地址和语音端口';
  if (/command timeout/i.test(message)) return '服务器操作响应超时，请检查频道权限后重试';
  if (/insufficient client permissions/i.test(message)) return '服务器权限不足，请检查机器人进入目标频道的权限';
  if (/invalid server password/i.test(message)) return '服务器密码不正确，请修改预设';
  if (/invalid channel password/i.test(message)) return '频道密码不正确，请修改预设';
  if (/\b(cpw|password|identity)\s*[=:]/i.test(message)) return '服务器操作失败，请检查频道设置';
  if (/cookie|MUSIC_U|csrf|token|https?:\/\//i.test(message)) return '操作失败，请检查网络、账号状态或服务器设置';
  return message.slice(0, 180);
}
export class CoreEngine {
  constructor(store, vault, onChange, onDisconnect) { Object.assign(this, { store, vault, onChange, onDisconnect }); this.serverMusic = isServerMusic(); this.activeId = null; this.lastTrack = null; this.revision = 0; this.audioHealth = createAudioHealth(); this.audioClock = createAudioClock({ onError: () => this.onChange?.({ diagnostic: { level: 'warn', message: 'Windows 音频计时优化未能启用', time: Date.now() } }) }); }
  async init() {
    // Keep anonymous music API tokens and transcoding temp files within the project.
    const temp = resolve(dataDir, 'temp'); mkdirSync(temp, { recursive: true }); process.env.TEMP = temp; process.env.TMP = temp;
    const [{ createDatabase }, { getDefaultConfig }, { BotManager }, { createAvatarStore }, { createPermissionStore }] = await Promise.all([
      coreImport('data/database.js'), coreImport('data/config.js'), coreImport('bot/manager.js'), coreImport('data/avatars.js'), coreImport('data/permissions.js')
    ]);
    this.db = createDatabase(resolve(dataDir, 'core.db'));
    const save = this.db.saveBotInstance.bind(this.db); const read = this.db.getBotInstances.bind(this.db);
    const secrets = ['identity', 'serverPassword', 'channelPassword', 'ts6ApiKey'];
    this.db.saveBotInstance = p => { const sealed = { ...p, autoStart: false }; for (const key of secrets) sealed[key] = this.vault.encrypt(p[key]); save(sealed); };
    this.db.getBotInstances = () => read().map(p => { const open = { ...p, autoStart: false }; for (const key of secrets) open[key] = this.vault.decrypt(p[key]); return open; });
    const config = getDefaultConfig(); Object.assign(config, { enabledProviders: ['netease'], localAudioEnabled: false, chatControlEnabled: false, autoReturnDelay: 0, directVoiceConnection: true });
    this.provider = new IsolatedMusicProvider(); await this.provider.ready;
    const cookie = this.store.get('neteaseCookie', ''); if (cookie) this.provider.setCookie(this.vault.decrypt(cookie));
    const quality = this.store.get('quality', 'exhigh'); this.provider.setQuality(quality); config.audioQuality.netease = quality;
    this.config = config;
    // Avoid serializing upstream errors that may contain account cookies or stream URLs.
    const log = (level, args) => { const msg = args.find(a => typeof a === 'string'); if (msg) this.onChange({ diagnostic: { level, message: safeError(new Error(msg)), time: Date.now() } }); };
    const logger = { info() {}, debug() {}, trace() {}, warn: (...args) => log('warn', args), error: (...args) => log('error', args), fatal: (...args) => log('error', args), child() { return this; }, level: 'warn' };
    this.manager = new BotManager(this.provider, this.provider, this.provider, this.db, config, logger, createAvatarStore(resolve(dataDir, 'avatars')), createPermissionStore(this.db.db), resolve(dataDir, 'core-config.json'));
    this.manager.on('botInstance', bot => {
      if (this.serverMusic) configureServerMusicBot(bot);
      bot.getPlayer().on('frame', () => { if (bot === this.bot()) this.audioClock.setActive(true); });
      bot.getPlayer().on('error', () => { if (bot === this.bot()) this.audioClock.setActive(false); });
      bot.getPlayer().on('trackEnd', () => { if (bot === this.bot()) { this.audioClock.setActive(false); this.revision++; this.onChange(); } });
      bot.on('stateChange', () => { this.observeTrack(); this.onChange(); });
      bot.on('disconnected', () => { if (bot === this.bot()) { this.stopJoinObserver(); this.audioClock.setActive(false); this.onDisconnect(); } });
    });
    await this.manager.loadSavedBots();
    this.auth = this.serverMusic ? initialServerAuth(this, cookie) : { loggedIn: false, checking: !!cookie };
    if (cookie) this.refreshAuth().catch(() => {});
  }
  bot() { return this.activeId ? this.manager?.getBot(this.activeId) : null; }
  observeTrack() { const track = this.bot()?.getQueueManager().current() || null; if (track !== this.lastTrack) { this.lastTrack = track; this.revision++; } }
  stopJoinObserver() { this.detachChannelJoins?.(); this.detachChannelJoins = null; this.connectionId = null; }
  observeChannelJoins() {
    this.stopJoinObserver(); const bot = this.bot(); if (!bot) return;
    this.connectionId = randomUUID();
    this.detachChannelJoins = observeChannelJoins(bot.tsClient, event => this.onChange({ channelJoin: { ...event, connectionId: this.connectionId } }));
  }
  announcementTarget() {
    const bot = this.bot(); const channelId = String(bot?.tsClient.getChannelId() || 0);
    return bot?.isConnected() && this.connectionId && channelId !== '0' ? { channelId, connectionId: this.connectionId } : null;
  }
  async sendShareAnnouncement({ channelId, connectionId, url }) {
    const bot = this.bot();
    if (!bot?.isConnected() || !connectionId || connectionId !== this.connectionId || String(bot.tsClient.getChannelId()) !== channelId) return false;
    if (!allowedShareUrl(url)) throw new Error('分享地址无效');
    await bot.tsClient.sendTextMessage(`音乐控制台：[URL=${url}]点此打开网页点歌 / 切歌[/URL]`, 2, true);
    return true;
  }
  async start(preset) {
    this.stopJoinObserver();
    const params = { ...preset, serverProtocol: 'ts3', autoStart: false };
    let bot = preset.coreBotId && this.manager.getBot(preset.coreBotId);
    if (!bot) {
      const sibling = this.store.list().find(p => p.id !== preset.id && p.serverAddress === preset.serverAddress && p.serverPort === preset.serverPort && p.coreBotId);
      if (sibling) bot = this.manager.getBot(sibling.coreBotId);
      if (bot) this.store.bindBot(preset.id, bot.id);
    }
    if (!bot) { bot = await this.manager.createBot(params); this.store.bindBot(preset.id, bot.id); }
    else this.manager.updateBot(bot.id, params);
    this.activeId = bot.id;
    this.audioHealth.setPlayer(bot.getPlayer(), bot.tsClient);
    try { await this.manager.startBot(bot.id); this.observeTrack(); this.observeChannelJoins(); }
    finally { const current = this.bot(); const saved = this.manager.getBotConfig(bot.id); if (saved && current?.getIdentityExport()) this.db.saveBotInstance({ ...saved, identity: current.getIdentityExport(), autoStart: false }); }
    return this.bot().getConnectionInfo();
  }
  stop() { this.stopJoinObserver(); this.audioClock.setActive(false); if (this.activeId) this.manager.stopBot(this.activeId); this.activeId = null; this.audioHealth.setPlayer(); this.lastTrack = null; this.revision++; }
  status({ includeQueue = true } = {}) {
    this.audioHealth.setPlayer(this.bot()?.getPlayer(), this.bot()?.tsClient);
    this.observeTrack(); const bot = this.bot(); this.audioClock.setActive(bot?.getPlayer().getState() === 'playing'); if (!bot) return { connected: false, playing: false, paused: false, volume: 50, playMode: 'loop', elapsed: 0, queueSize: 0, revision: this.revision, currentSong: null, queue: [] };
    const clean = song => { if (!song) return null; if (!song.entryId) song.entryId = randomUUID(); return { entryId: song.entryId, id: song.id, name: song.name, artist: song.artist, artists: song.artists, popularity: song.popularity, album: song.album, coverUrl: song.coverUrl, duration: song.duration, vip: !!song.vip, requestedBy: song.requestedBy }; };
    const status = bot.getStatus(); return { ...status, currentSong: clean(status.currentSong), ...(includeQueue ? { queue: bot.getQueue().map(clean) } : {}), revision: this.revision, ...bot.getConnectionInfo() };
  }
  health() { return { ...this.audioHealth.snapshot(this.bot()?.getPlayer()), transport: this.bot()?.tsClient.getVoiceTransportStatistics?.() || { supported: false } }; }
  exportQueue() { return this.status().queue; }
  removeBot(id) { return this.manager.removeBot(id); }
  channels() { const bot = this.bot(); if (!bot?.isConnected()) throw new Error('请先连接服务器'); return bot.listVisibleChannels(); }
  setQuality(value) { this.provider.setQuality(value); this.config.audioQuality.netease = value; }
  async refreshAuth() { if (this.serverMusic) return refreshServerAuth(this); const epoch = this.authEpoch; const auth = await this.provider.getAuthStatus(); if (epoch === this.authEpoch) { this.auth = auth; this.onChange(); } return this.auth; }
  acceptOfficialLogin(cookie, profile) {
    const value = normalizeNeteaseCookie(cookie);
    if (profile?.loggedIn !== true || typeof profile.nickname !== 'string') throw Error('官网登录尚未确认');
    const auth = { loggedIn: true, nickname: profile.nickname.slice(0, 160), avatarUrl: String(profile.avatarUrl || '').slice(0, 2048), officialBrowser: true };
    this.authEpoch = (this.authEpoch || 0) + 1;
    this.store.set('neteaseCookie', this.vault.encrypt(value)); this.provider.setCookie(value);
    this.qrKey = null; this.auth = { ...auth, ...(this.serverMusic ? { hasSession: true } : {}) }; rememberServerAuth(this, auth); this.onChange(); return this.auth;
  }
  async importCookie(input, { createProbe = () => new IsolatedMusicProvider() } = {}) {
    const cookie = normalizeNeteaseCookie(input);
    const epoch = this.authEpoch = (this.authEpoch || 0) + 1;
    const probe = createProbe();
    try {
      await probe.ready; probe.setCookie(cookie);
      const status = await probe.getAuthStatus();
      if (!status?.loggedIn) throw Error('登录会话未通过验证，可能已失效或被网易云限制；原登录未替换');
      if (epoch !== this.authEpoch) throw Error('账号状态已变化，请重新导入');
      const auth = { loggedIn: true, nickname: String(status.nickname || '').slice(0, 160), avatarUrl: String(status.avatarUrl || '').slice(0, 2048) };
      this.store.set('neteaseCookie', this.vault.encrypt(cookie));
      this.provider.setCookie(cookie); this.qrKey = null; this.auth = { ...auth, ...(this.serverMusic ? { hasSession: true } : {}) }; rememberServerAuth(this, auth); this.onChange();
      return auth;
    } catch (error) {
      if (epoch !== this.authEpoch) throw Error('账号状态已变化，请重新导入');
      if (error?.message === '登录会话未通过验证，可能已失效或被网易云限制；原登录未替换') throw error;
      throw Error('登录信息导入失败，原登录未替换；请检查会话是否有效及服务器请求是否受限');
    } finally { try { await probe.close(); } catch {} }
  }
  async qr() { const qr = await this.provider.getQrCode(); if (!qr.key || !qr.qrUrl) throw new Error('二维码获取失败，请稍后重试'); this.qrKey = qr.key; return { qrImg: qr.qrImg, qrUrl: qr.qrUrl }; }
  async qrCheck() { if (!this.qrKey) throw new Error('请刷新二维码'); const status = await this.provider.checkQrCodeStatus(this.qrKey); if (status === 'confirmed') { this.authEpoch = (this.authEpoch || 0) + 1; this.store.set('neteaseCookie', this.vault.encrypt(this.provider.getCookie())); this.qrKey = null; await this.refreshAuth(); } return { status }; }
  async logout() { this.authEpoch = (this.authEpoch || 0) + 1; this.provider.setCookie(''); this.store.set('neteaseCookie', ''); this.auth = { loggedIn: false }; rememberServerAuth(this, this.auth); this.qrKey = null; this.onChange(); }
  async command(method, args, name) {
    const bot = this.bot(); if (!bot?.isConnected()) throw new Error('机器人尚未连接 TS 服务器');
    return bot.runExclusive(async () => {
      const queue = bot.getQueueManager(); const player = bot.getPlayer(); this.observeTrack();
      if (args.expectedRevision !== undefined && args.expectedRevision !== this.revision) throw new Error('播放状态已变化，已刷新，请再次操作');
      const advance = () => { this.revision++; };
      const play = async song => { player.resetFailures(); const ok = await bot.resolveAndPlay(song); if (!ok) throw new Error(this.serverMusic ? '网易云未提供可用的播放地址，请检查账号状态或歌曲可用性' : '这首歌暂时无法播放，可能没有版权或账号权限不足'); };
      if (method === 'player.next') { advance(); await bot.playNext(); }
      else if (method === 'player.prev') { const song = queue.prev(); if (!song) throw new Error('没有上一首'); advance(); await play(song); }
      else if (method === 'player.pause') { bot.autoPaused = false; player.pause(); }
      else if (method === 'player.resume') { bot.autoPaused = false; if (player.getState() === 'idle') { const song = queue.current() || queue.play(); if (song) await play(song); else throw new Error('请先添加歌曲'); } else player.resume(); }
      else if (method === 'player.volume') { const value = Number(args.value); if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('音量范围为 0–100'); player.setVolume(value); this.db.saveVolume(bot.id, value); }
      else if (method === 'player.mode') { if (!['loop', 'single', 'random'].includes(args.value)) throw new Error('播放模式无效'); queue.setMode(args.value); this.db.savePlayMode(bot.id, args.value); }
      else if (method === 'player.seek') { const value = Number(args.value); const status = bot.getStatus(); if (!Number.isFinite(value) || value < 0 || value > (status.effectiveDuration || status.currentSong?.duration || 0)) throw new Error('进度超出范围'); bot.seek(value); }
      else if (method === 'queue.clear' || method === 'player.stop') { player.stop(); queue.clear(); advance(); }
      else if (method === 'queue.remove') { const index = queue.list().findIndex(s => s.entryId === args.entryId); if (index < 0) throw new Error('歌曲已不在队列中'); if (index === queue.getCurrentIndex()) throw new Error('请使用下一首跳过正在播放的歌曲'); queue.remove(index); advance(); }
      else if (method === 'queue.play') {
        const index = queue.list().findIndex(s => s.entryId === args.entryId);
        if (index < 0) throw new Error('歌曲已不在队列中，请刷新后重试');
        bot.autoPaused = false;
        if (index === queue.getCurrentIndex() && player.getState() === 'paused') player.resume();
        else if (index !== queue.getCurrentIndex() || player.getState() !== 'playing') {
          const restore = queue.captureNavigation();
          const selectedSong = queue.playAt(index);
          advance();
          try { await play(selectedSong); }
          catch (error) { if (queue.current() === selectedSong) restore(); bot.emit('stateChange'); throw error; }
        }
      }
      else if (method === 'queue.move') {
        const songs = queue.list();
        const from = songs.findIndex(s => s.entryId === args.entryId);
        const to = songs.findIndex(s => s.entryId === args.targetEntryId);
        if (from < 0 || to < 0) throw new Error('歌曲已不在队列中，请刷新后重试');
        const current = queue.getCurrentIndex();
        if (from <= current || to <= current) throw new Error('只能调整当前歌曲之后的待播放歌曲');
        if (queue.move(from, to)) advance();
      }
      else if (method === 'music.add' || method === 'music.playNow') {
        if (!/^\d{1,20}$/.test(String(args.id))) throw new Error('歌曲 ID 无效');
        const song = await this.provider.getSongDetail(String(args.id)); if (!song) throw new Error('歌曲不存在');
        song.entryId = randomUUID(); song.requestedBy = name;
        if (method === 'music.playNow' && queue.current()?.id === song.id) { bot.autoPaused = false; advance(); await play(queue.current()); }
        else {
          if (queue.size() >= 500) throw new Error('队列最多保存 500 首歌曲，请先移除一首');
          if (method === 'music.playNow') {
            const restore = queue.captureState();
            queue.interrupt(song, player.getState() !== 'idle'); bot.autoPaused = false; advance();
            try { await play(song); }
            catch (error) { if (queue.current() === song) restore(); bot.emit('stateChange'); throw error; }
          } else { const idle = player.getState() === 'idle'; queue.add(song); advance(); if (idle) { queue.playAt(queue.size() - 1); await play(song); } }
        }
      }
      else if (method === 'playlist.play' || method === 'playlist.loadLocal') {
        const songs = method === 'playlist.loadLocal' ? args.songs : await this.provider.getPlaylistSongs(String(args.id)); if (!Array.isArray(songs) || !songs.length) throw new Error('歌单为空或无权访问');
        if (args.append && queue.size() + songs.length > 500) throw new Error('追加后超过 500 首，请先移除部分歌曲');
        advance(); await bot.loadSavedQueue(songs.slice(0, 500).map(s => ({ ...s, entryId: randomUUID() })), args.append ? 'append' : 'replace', name);
      } else throw new Error('操作不存在');
      this.observeTrack(); bot.emit('stateChange'); return this.status();
    });
  }
  close() { this.stopJoinObserver(); this.audioHealth.close(); this.audioClock.close(); this.manager?.shutdown(); this.provider?.close(); this.db?.close(); }
}
