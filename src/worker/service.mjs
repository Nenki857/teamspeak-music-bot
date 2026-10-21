import { createMusicAudit } from './music-audit.mjs';
import { isServerMusic } from './server-music-session.mjs';
import { randomUUID } from 'node:crypto';
import { ShareAuthority, CommandGate, ALL_PERMISSIONS } from '../shared/security.mjs';
import { Store } from './store.mjs';
import { CoreEngine, safeError } from './core-engine.mjs';
import { Tunnel } from './tunnel.mjs';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { dataDir } from './paths.mjs';
import { isLocalPlaylist, readPlaylistFile, playlistDescription } from '../shared/playlist-format.mjs';
import { ShareAnnouncement } from './share-announcement.mjs';
import { publicUserQuery } from '../shared/visitor.mjs';
import { allowedShareUrl } from '../shared/public-url.mjs';
export const METHOD_PERMISSIONS = { 'status': 'view', 'music.lyrics': 'view', 'identity.set': 'view', 'identity.history': 'view', 'identity.remove': 'view', 'music.users': 'search', 'music.userPlaylists': 'search', 'playlist.preview': 'search', 'playlist.share': 'savePlaylist', 'playlist.create': 'savePlaylist', 'playlists.targets': 'savePlaylist', 'playlist.addSong': 'savePlaylist', 'playlist.update': 'savePlaylist', 'playlist.delete': 'savePlaylist', 'music.search': 'search', 'music.artist': 'search', 'music.artistAlbums': 'search', 'music.album': 'search', 'music.add': 'add', 'music.playNow': 'playNow', 'player.next': 'skip', 'player.prev': 'skip', 'player.pause': 'transport', 'player.resume': 'transport', 'player.stop': 'queue', 'player.volume': 'volume', 'player.seek': 'seek', 'player.mode': 'mode', 'queue.remove': 'queue', 'queue.clear': 'queue', 'queue.move': 'reorder', 'queue.play': 'playNow', 'playlists.list': 'view', 'playlist.detail': 'view', 'playlist.play': 'playlist', 'playlist.saveQueue': 'savePlaylist' };
const mutations = new Set(Object.keys(METHOD_PERMISSIONS).filter(m => !['status', 'music.lyrics', 'identity.set', 'identity.history', 'identity.remove', 'music.users', 'music.userPlaylists', 'playlist.preview', 'playlists.targets', 'music.search', 'music.artist', 'music.artistAlbums', 'music.album', 'playlists.list', 'playlist.detail'].includes(m)));
export class Service {
  constructor(vault, onChange, { createCore = (...args) => new CoreEngine(...args), createTunnel = onChange => new Tunnel(onChange), createAuthority = () => new ShareAuthority(), autoShareRetryMs = 2000 } = {}) {
    this.onChange = onChange; this.store = new Store(vault); this.authority = createAuthority(this.store, vault); this.gate = new CommandGate(); this.phase = 'stopped'; this.activePreset = null; this.diagnostics = []; this.publications = [];
    this.reloadPlaylists();
    this.autoShareEnabled = this.store.get('autoShareOnConnect', true) !== false; this.autoShareState = { status: 'idle', error: '' }; this.autoShareEpoch = 0; this.autoGrantId = ''; this.autoShareRetryMs = autoShareRetryMs;
    this.announcement = new ShareAnnouncement({ gate: this.gate, current: id => this.announcementContext(id), send: event => this.core.sendShareAnnouncement(event), changed: () => this.changed() });
    this.musicAudit = isServerMusic() ? createMusicAudit(resolve(dataDir, 'logs/netease-sessions.jsonl')) : () => {};
    this.core = createCore(this.store, vault, event => { if (event?.channelJoin) { this.announcement.joined(event.channelJoin); return; } if (event?.diagnostic?.kind === 'music-session') this.musicAudit(event.diagnostic); if (event?.diagnostic) this.diagnostics = [...this.diagnostics.slice(-39), event.diagnostic]; this.changed(); }, () => { if (this.phase === 'running') { this.endRun(); this.phase = 'disconnected'; this.error = '机器人与 TS 断开，旧分享授权已失效。请重新启动。'; this.changed(); } });
    this.tunnel = createTunnel(() => {
      const url = this.tunnel.state.status === 'online' ? this.tunnel.state.url : '';
      if (!url) this.announcement.clearPending();
      if (url && url !== this.lastPublicUrl) this.queueLinkAnnouncements();
      this.lastPublicUrl = url; this.changed();
    });
  }
  changed() { this.onChange?.(); }
  recordConnection(message) { try { const dir = resolve(dataDir, 'logs'); mkdirSync(dir, { recursive: true }); appendFileSync(resolve(dir, 'bot-connection.log'), `${new Date().toISOString()} ${message}\n`); } catch {} }
  async init() { await this.core.init(); this.ready = true; this.changed(); }
  cancelAutomaticSharing(status = 'idle') { this.autoShareEpoch++; this.cancelAutoShareWait?.(); this.autoShareTask = null; this.autoShareState = { status, error: '' }; }
  waitForAutomaticRetry() {
    return new Promise(resolveWait => {
      const finish = () => { clearTimeout(timer); if (this.cancelAutoShareWait === finish) this.cancelAutoShareWait = null; resolveWait(); };
      const timer = setTimeout(finish, this.autoShareRetryMs); this.cancelAutoShareWait = finish;
    });
  }
  endRun() { this.cancelAutomaticSharing(); this.autoGrantId = ''; this.announcement.reset(); this.announcement.links.clear(); this.authority.endRun(); this.tunnel.stop(); }
  async publishLink(grantId, expected = this.announcementContext(grantId)) {
    if (!expected) return false;
    try {
      const target = await this.core.announcementTarget();
      if (!target) { this.announcement.linkFailed(grantId, expected); return false; }
      return this.announcement.publishLink(grantId, target, expected);
    } catch { this.announcement.linkFailed(grantId, expected); return false; }
  }
  queueLinkAnnouncements() {
    for (const grant of this.authority.grants.values()) {
      const expected = this.announcementContext(grant.id);
      if (expected) this.gate.run('link-announcement', randomUUID(), () => this.publishLink(grant.id, expected)).catch(() => {});
    }
  }
  startAutomaticSharing() {
    if (!this.autoShareEnabled || this.phase !== 'running' || !this.authority.runId) return Promise.resolve();
    if (this.autoShareTask) return this.autoShareTask;
    const epoch = ++this.autoShareEpoch; const runId = this.authority.runId;
    const current = () => epoch === this.autoShareEpoch && this.autoShareEnabled && runId === this.authority.runId && this.phase === 'running';
    this.autoShareState = { status: 'starting', attempt: 1, error: '' }; this.changed();
    const task = Promise.resolve().then(async () => {
      try {
        for (let attempt = 1; attempt <= 2 && current(); attempt++) {
          try {
            if (!Number.isInteger(this.sharePort) || this.sharePort <= 0) throw new Error('分享服务尚未就绪，请稍后重试');
            if (this.tunnel.state.status !== 'online') await this.tunnel.start(this.sharePort);
            if (!current()) return;
            await this.gate.run('automatic-sharing', randomUUID(), async () => {
              if (!current()) return;
              if (this.tunnel.state.status !== 'online') throw new Error('公网入口已断开');
              let grant = this.authority.grants.get(this.autoGrantId);
              if (!grant) { grant = this.authority.createAutomatic ? this.authority.createAutomatic(ALL_PERMISSIONS) : this.authority.create('频道共享（自动）', ALL_PERMISSIONS); this.autoGrantId = grant.id; }
              this.announcement.configure(grant.id); this.changed();
              const sent = await this.publishLink(grant.id);
              if (!current()) return;
              if (!sent) throw new Error('首次发送未完成');
              this.autoShareState = { status: 'ready', attempt, error: '' }; this.changed();
            });
            if (current()) return;
          } catch {
            if (!current()) return;
            if (attempt === 2) { this.autoShareState = { status: 'error', attempt, error: '自动共享已重试一次仍未完成，请检查公网连接或频道文字消息权限后手动重试' }; this.changed(); return; }
            this.autoShareState = { status: 'retrying', attempt: 2, error: '' }; this.changed();
            await this.waitForAutomaticRetry();
            if (current()) { this.autoShareState = { status: 'starting', attempt: 2, error: '' }; this.changed(); }
          }
        }
      } finally { if (epoch === this.autoShareEpoch) this.autoShareTask = null; }
    });
    this.autoShareTask = task; return task;
  }
  announcementContext(id) {
    const grant = this.authority.grants.get(id);
    if (this.phase !== 'running' || !this.authority.runId || grant?.runId !== this.authority.runId || this.tunnel?.state.status !== 'online') return null;
    const base = this.tunnel.state.url;
    if (!allowedShareUrl(`${base}/#invite=${grant.raw}`)) return null;
    return { runId: this.authority.runId, url: `${base}/#invite=${grant.raw}` };
  }
  reloadPlaylists() { this.localPlaylists = this.store.localPlaylists(); this.publications = [...this.localPlaylists, ...this.store.openPlaylists()]; }
  snapshot(owner = true, permissions = ALL_PERMISSIONS, displayName = '') {
    const common = { ready: !!this.ready, phase: this.phase, runId: this.authority.runId, player: this.ready ? this.core.status() : {}, permissions, publications: this.publications, capabilities: { serverResources: Boolean(this.runtime?.serverResources), lyrics: true, savedPlaylists: true, sharedPlaylistSaving: true, channelAnnouncements: true, artists: !isServerMusic(), artistNameSearch: isServerMusic(), artistAlbums: isServerMusic(), queueInterruption: true }, title: this.activePreset ? this.store.list().find(p => p.id === this.activePreset)?.name : 'Music Bot' };
    common.capabilities.community = true; common.capabilities.automaticSharing = true; common.capabilities.visitorHistory = true; common.capabilities.visitorHistoryRemoval = true; common.capabilities.linkAnnouncements = true; common.capabilities.playlistEditing = true; common.capabilities.playlistPicker = true; common.capabilities.collaborativePlaylists = true; common.capabilities.openLocalPlaylists = true; common.capabilities.playlistDescriptions = true;
    if (!owner) return { ...common, visitor: { name: displayName } };
    if (this.runtime) common.runtime = this.runtime;
    return { ...common, autoSharing: { enabled: this.autoShareEnabled, ...this.autoShareState }, shareAnnouncement: this.announcement.state(), audioHealth: this.core.health(), presets: this.store.list(), defaultPreset: this.store.get('defaultPreset'), activePreset: this.activePreset, auth: this.core.auth || { loggedIn: false }, quality: this.store.get('quality', 'exhigh'), tunnel: this.tunnel.state, grants: [...this.authority.grants.values()].map(g => ({ ...this.authority.public(g), url: this.tunnel.state.url ? `${this.tunnel.state.url}/#invite=${g.raw}` : '', localUrl: this.sharePort ? `http://127.0.0.1:${this.sharePort}/#invite=${g.raw}` : '', delivery: this.announcement.linkState(g.id) })), localPlaylists: this.localPlaylists, diagnostics: this.diagnostics, error: this.error || '' };
  }
  async rpc(method, args = {}, access = { owner: true }, requestId = randomUUID()) {
    if (!this.ready) throw new Error('组件正在初始化，请稍候');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('请求格式错误');
    const check = () => {
      if (access.owner) return { name: '主人', permissions: ALL_PERMISSIONS };
      const permission = METHOD_PERMISSIONS[method]; if (!permission) throw new Error('此操作仅限本机');
      const authenticated = this.authority.authenticate(access.session, permission, access.csrf);
      return { ...authenticated.grant, actorName: authenticated.displayName || [...authenticated.grant.name].slice(0, 32).join(''), displayName: authenticated.displayName || '' };
    };
    let grant = check();
    if (!access.owner && (mutations.has(method))) {
      if (args.runId !== this.authority.runId) throw new Error('机器人已重新启动，请打开新的分享链接');
      if (['player.next', 'player.prev', 'music.playNow', 'playlist.play', 'queue.clear', 'queue.move', 'queue.play', 'player.stop'].includes(method) && !Number.isInteger(args.expectedRevision)) throw new Error('请刷新播放状态后重试');
    }
    const execute = async () => {
      grant = check();
      if (!access.owner && mutations.has(method) && args.runId !== this.authority.runId) throw new Error('授权已失效');
      if (['playlist.create', 'playlist.update', 'playlist.saveQueue'].includes(method) && Object.hasOwn(args, 'description')) playlistDescription(args.description);
      if (method === 'status') return this.snapshot(access.owner, grant.permissions, grant.displayName);
      if (method === 'identity.history') return { names: this.store.visitorNames() };
      if (method === 'identity.remove') return this.store.removeVisitorName(args.name);
      if (method === 'identity.set') {
        if (access.owner) throw new Error('请在朋友页面设置点播 ID');
        if (Object.hasOwn(args, 'remember') && typeof args.remember !== 'boolean') throw new Error('昵称记忆设置无效');
        const identity = this.authority.setIdentity(access.session, args.name, access.csrf);
        if (args.remember !== false) this.store.rememberVisitorName(identity.name); return identity;
      }
      if (method === 'music.users') { const parsed = publicUserQuery(args.query, args.mode); return this.core.provider.searchUsers(parsed.query, parsed.mode, Math.max(0, Math.min(270, Math.floor(Number(args.offset) || 0)))); }
      if (method === 'music.userPlaylists') { if (!/^\d{1,20}$/.test(String(args.id))) throw new Error('用户 UID 无效'); return this.core.provider.getPublicUserPlaylists(String(args.id), Math.max(0, Math.min(270, Math.floor(Number(args.offset) || 0)))); }
      if (method === 'playlist.preview') { if (!/^\d{1,20}$/.test(String(args.id))) throw new Error('歌单 ID 无效'); const detail = await this.core.provider.getPublicPlaylist(String(args.id)); return { ...detail, openedBy: this.publications.find(item => item.id === detail.id)?.openedBy || '', publicPreview: true, published: this.publications.some(item => item.id === detail.id) }; }
      if (method === 'playlists.targets') { if (!/^\d{1,20}$/.test(String(args.songId))) throw new Error('歌曲 ID 无效'); return this.store.playlistTargets(args.songId); }
      if (method === 'playlist.addSong') {
        if (!/^\d{1,20}$/.test(String(args.songId))) throw new Error('歌曲 ID 无效');
        this.validatePlaylistEditing(args.id, access); const existing = this.store.localPlaylist(args.id);
        if (existing.songs.some(song => song.id === String(args.songId))) return { added: false, playlist: existing };
        if (args.expectedUpdatedAt !== existing.updatedAt) throw new Error('歌单已被更新，请重新打开歌单选择器后重试');
        if (existing.songs.length >= 500) throw new Error('歌单已达到 500 首上限');
        const songs = await this.core.provider.getPublicSongs([String(args.songId)]); const song = songs.find(item => String(item.id) === String(args.songId)); if (!song) throw new Error('歌曲资料暂时无法读取，请稍后重试');
        grant = check(); if (!access.owner && args.runId !== this.authority.runId) throw new Error('授权已失效'); this.validatePlaylistEditing(args.id, access);
        const saved = this.store.updateLocalPlaylist({ id: existing.id, name: existing.name, songs: [...existing.songs, song], expectedUpdatedAt: args.expectedUpdatedAt });
        this.reloadPlaylists(); return { added: true, playlist: saved };
      }
      if (method === 'playlist.update') {
        this.validatePlaylistEditing(args.id, access);
        if (Object.hasOwn(args, 'openedBy') || Object.hasOwn(args, 'requestedBy')) throw new Error('不能修改歌单原有署名');
        const existing = this.store.localPlaylist(args.id);
        if (args.expectedUpdatedAt !== existing.updatedAt) throw new Error('歌单已被更新，请重新打开后编辑，或另存为新歌单');
        if (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > 500 || args.ids.some(id => !/^\d{1,20}$/.test(String(id)))) throw new Error('请选择 1–500 首有效歌曲');
        const ids = [...new Set(args.ids.map(String))]; const known = new Map(existing.songs.map(song => [song.id, song])); const missing = ids.filter(id => !known.has(id));
        if (missing.length) for (const song of await this.core.provider.getPublicSongs(missing)) known.set(String(song.id), song);
        if (ids.some(id => !known.has(id))) throw new Error('部分新增歌曲无法读取，请稍后重试');
        grant = check(); if (!access.owner && args.runId !== this.authority.runId) throw new Error('授权已失效');
        this.validatePlaylistEditing(args.id, access);
        const saved = this.store.updateLocalPlaylist({ id: existing.id, name: args.name, description: args.description, songs: ids.map(id => known.get(id)), expectedUpdatedAt: args.expectedUpdatedAt });
        this.reloadPlaylists(); return saved;
      }
      if (method === 'playlist.share' || method === 'playlist.create') {
        if (Object.hasOwn(args, 'openedBy') || Object.hasOwn(args, 'requestedBy')) throw new Error('署名由当前会话决定');
        if (method === 'playlist.share') {
          if (!/^\d{1,20}$/.test(String(args.id))) throw new Error('歌单 ID 无效');
          if (this.publications.some(item => item.id === String(args.id))) return this.publications.find(item => item.id === String(args.id));
          const detail = await this.core.provider.getPublicPlaylist(String(args.id)); grant = check();
          if (!access.owner && args.runId !== this.authority.runId) throw new Error('授权已失效');
          this.store.publishPlaylist(detail, access.owner ? '主人' : grant.actorName); this.reloadPlaylists(); return this.publications.find(item => item.id === String(args.id));
        }
        if (Object.hasOwn(args, 'id')) throw new Error('覆盖已有歌单仅限本机主人');
        if (!Array.isArray(args.ids) || !args.ids.length || args.ids.length > 500 || args.ids.some(id => !/^\d{1,20}$/.test(String(id)))) throw new Error('请选择 1–500 首有效歌曲');
        const ids = [...new Set(args.ids.map(String))];
        const songs = await this.core.provider.getPublicSongs(ids); grant = check();
        if (!access.owner && args.runId !== this.authority.runId) throw new Error('授权已失效');
        const saved = this.store.saveLocalPlaylist({ name: args.name, description: args.description, songs, openedBy: access.owner ? '主人' : grant.actorName }); this.reloadPlaylists(); return saved;
      }
      if (method === 'presets.save') { if (args.id && args.id === this.activePreset && this.phase === 'running') throw new Error('请停止机器人后修改当前预设'); return this.store.save(args); }
      if (method === 'presets.remove') { if (args.id === this.activePreset && this.phase === 'running') throw new Error('请停止机器人后删除当前预设'); const preset = this.store.read(args.id); const stillUsed = this.store.list().some(p => p.id !== preset.id && p.coreBotId === preset.coreBotId); if (preset.coreBotId && !stillUsed) await this.core.removeBot(preset.coreBotId); this.store.remove(args.id); return true; }
      if (method === 'presets.default') { this.store.read(args.id); this.store.set('defaultPreset', args.id); return true; }
      if (method === 'bot.start') {
        if (this.phase === 'running' || this.phase === 'disconnected') { this.endRun(); await this.core.stop(); }
        const preset = this.store.read(args.id); this.phase = 'starting'; this.error = ''; this.activePreset = preset.id; this.changed();
        this.recordConnection('Connecting');
        try { await this.core.start(preset); this.authority.beginRun(); this.phase = 'running'; this.recordConnection('Connected'); this.startAutomaticSharing(); }
        catch (error) { await this.core.stop(); this.endRun(); this.phase = 'stopped'; this.error = safeError(error); this.recordConnection('Failed: ' + this.error); throw error; }
        finally { this.changed(); }
        return this.snapshot();
      }
      if (method === 'bot.stop') { this.endRun(); this.phase = 'stopped'; await this.core.stop(); this.changed(); return true; }
      if (method === 'bot.channels') return this.core.channels();
      if (method === 'auth.qr') return this.core.qr();
      if (method === 'auth.check') return this.core.qrCheck();
      if (method === 'auth.refresh') return this.core.refreshAuth();
      if (method.startsWith('auth.browser.')) {
        if (!access.owner || this.runtime?.deployment !== 'server') throw Error('此操作仅限服务器主人控制台');
        if (!this.browserLogin) throw Error('请先运行“安装服务器官网登录组件.cmd”，再刷新主人控制台');
        if (method === 'auth.browser.start') return this.browserLogin.start();
        if (method === 'auth.browser.frame') return this.browserLogin.frame();
        if (method === 'auth.browser.input') return this.browserLogin.input(args);
        if (method === 'auth.browser.home') return this.browserLogin.home();
        if (method === 'auth.browser.close') { await this.browserLogin.close(); return true; }
        if (method === 'auth.browser.finish') {
          const verified = await this.browserLogin.finish();
          const result = await this.core.acceptOfficialLogin(verified.cookie, verified.auth);
          await this.browserLogin.close(); return result;
        }
        throw Error('浏览器操作无效');
      }
      if (method === 'auth.importCookie') {
        if (!access.owner || this.runtime?.deployment !== 'server') throw Error('此操作仅限服务器主人控制台');
        return this.core.importCookie(args.cookie);
      }
      if (method === 'auth.logout') { await this.core.logout(); await this.browserLogin?.clear(); return true; }
      if (method === 'settings.quality') { if (!['standard', 'higher', 'exhigh', 'lossless', 'hires', 'jymaster'].includes(args.value)) throw new Error('音质无效'); await this.core.setQuality(args.value); this.store.set('quality', args.value); return true; }
      if (method === 'music.lyrics') {
        const id=String(args.id);if(!/^\d{1,20}$/.test(id))throw new Error('歌曲 ID 无效');
        const current=this.core.status().currentSong;
        if(!current || String(current.id)!==id || current.platform && current.platform!=='netease')throw new Error('播放歌曲已变化，请查看当前歌曲歌词');
        const lines=await this.core.provider.getLyrics(id);check();
        if(String(this.core.status().currentSong?.id)!==id)throw new Error('播放歌曲已变化，请查看当前歌曲歌词');
        return {songId:id,lines};
      }
      if (method === 'music.search') { const query = String(args.query || '').trim().slice(0, 100); if (!query) throw new Error('请输入歌名或歌手'); return this.core.provider.search(query, 30, Math.max(0, Math.min(600, Number(args.offset) || 0))); }
      if (method === 'music.artistAlbums') { if (!isServerMusic()) throw new Error('此功能仅限服务器版'); if (!/^\d{1,20}$/.test(String(args.id))) throw new Error('歌手 ID 无效'); return this.core.provider.getArtistAlbums(String(args.id), Math.max(0,Math.min(270,Math.floor(Number(args.offset)||0)))); }
      if (method === 'music.album') { if (!isServerMusic()) throw new Error('此功能仅限服务器版'); if (!/^\d{1,20}$/.test(String(args.id))) throw new Error('专辑 ID 无效'); return this.core.provider.getAlbumPage(String(args.id)); }
      if (method === 'music.artist') { if (isServerMusic()) throw new Error('歌手歌曲专用接口已停用，请直接搜索歌手名字'); if (!/^\d{1,20}$/.test(String(args.id))) throw new Error('歌手 ID 无效'); if (!['hot', 'time'].includes(args.order || 'hot')) throw new Error('歌曲排序无效'); return this.core.provider.getArtistPage(String(args.id), args.order || 'hot', Math.max(0, Math.min(480, Math.floor(Number(args.offset) || 0)))); }
      if (method === 'playlists.list') { if (!access.owner || args.type === 'shared') return this.publications; if (args.type === 'local') return this.localPlaylists; return args.type === 'mine' ? this.core.provider.getUserPlaylists() : this.core.provider.getRecommendPlaylists(); }
      if (method === 'playlist.detail') { this.validatePlaylist(args.id, access); if (isLocalPlaylist(args.id)) return this.store.localPlaylist(args.id); const detail = await this.core.provider.getPlaylistDetail(String(args.id)); return { ...detail, source: 'netease', openedBy: this.publications.find(item => item.id === String(args.id))?.openedBy || '', published: this.publications.some(item => item.id === String(args.id)), songs: (await this.core.provider.getPlaylistSongs(String(args.id))).slice(0, 500) }; }
      if (method === 'playlist.saveQueue') {
        if (!access.owner && Object.hasOwn(args, 'id')) throw new Error('覆盖已有歌单仅限本机主人');
        const songs = await this.core.exportQueue();
        // Export crosses the playback worker boundary; recheck before writing permanent data.
        check();
        if (!access.owner && args.runId !== this.authority.runId) throw new Error('授权已失效');
        grant = check();
        const saved = this.store.saveLocalPlaylist({ id: access.owner ? args.id : undefined, name: args.name, description: args.description, songs, openedBy: access.owner ? '主人' : grant.actorName });
        this.reloadPlaylists(); return saved;
      }
      if (method === 'playlist.import') { const file = readPlaylistFile(args.file); const saved = this.store.db.transaction(() => { const saved = this.store.saveLocalPlaylist(file); for (const item of file.openPlaylists) this.store.publishPlaylist(item); return saved; })(); this.reloadPlaylists(); return saved; }
      if (method === 'playlist.delete') { this.validatePlaylistRemoval(args.id, access); if (isLocalPlaylist(args.id)) { const existing = this.store.localPlaylist(args.id); if (!access.owner && args.expectedUpdatedAt !== existing.updatedAt) throw new Error('歌单已被更新，请重新打开后删除'); this.store.removeLocalPlaylist(args.id); } else { if (!this.publications.some(item => item.id === String(args.id))) throw new Error('歌单不存在'); this.store.unpublishPlaylist(args.id); } this.reloadPlaylists(); return true; }
      if (method === 'playlist.publish') { this.validatePlaylist(args.id, access); if (isLocalPlaylist(args.id)) this.store.localPlaylist(args.id); else { const detail = await this.core.provider.getPlaylistDetail(String(args.id)); if (!detail) throw new Error('歌单不存在'); this.store.publishPlaylist(detail); } this.reloadPlaylists(); return this.publications; }
      if (method === 'playlist.unpublish') { if (isLocalPlaylist(args.id)) throw new Error('自建歌单统一开放；如需移除，请删除歌单'); this.store.unpublishPlaylist(args.id); this.reloadPlaylists(); return this.publications; }
      if (method === 'sharing.auto') {
        if (typeof args.enabled !== 'boolean') throw new Error('自动共享设置无效');
        this.autoShareEnabled = args.enabled; this.store.set('autoShareOnConnect', args.enabled);
        if (!args.enabled) { const pending = this.autoShareState.status === 'starting'; this.cancelAutomaticSharing('off'); if (pending && this.tunnel.state.status === 'connecting') this.tunnel.stop(); }
        else if (this.phase === 'running') this.startAutomaticSharing();
        return true;
      }
      if (method === 'sharing.autoRetry') { if (this.phase !== 'running' || !this.autoShareEnabled) throw new Error('请先连接机器人并开启自动共享'); this.startAutomaticSharing(); return true; }
      if (method === 'sharing.enable') { if (this.phase !== 'running') throw new Error('请先启动机器人'); this.cancelAutomaticSharing(); return this.tunnel.start(this.sharePort); }
      if (method === 'sharing.disable') { this.cancelAutomaticSharing('off'); this.announcement.reset(); this.tunnel.stop(); return true; }
      if (method === 'sharing.send') {
        if (!this.announcementContext(args.grantId)) throw new Error('请先连接机器人、开启公网入口并选择有效授权');
        return this.publishLink(args.grantId);
      }
      if (method === 'sharing.announce') {
        if (typeof args.enabled !== 'boolean') throw new Error('自动分发设置无效');
        if (args.enabled && !this.announcementContext(args.grantId)) throw new Error('请先连接机器人、开启公网入口并选择有效授权');
        this.cancelAutomaticSharing(); this.announcement.configure(args.enabled ? args.grantId : '');
        if (args.enabled) await this.publishLink(args.grantId);
        return this.announcement.state();
      }
      if (method === 'sharing.create') {
        const created = this.authority.create(args.name, args.permissions); this.announcement.configure(created.id);
        await this.publishLink(created.id); return this.authority.public(created);
      }
      if (method === 'sharing.revoke') { if (this.autoGrantId === args.id) { this.cancelAutomaticSharing('off'); this.autoGrantId = ''; } if (this.announcement.grantId === args.id) this.announcement.reset(); this.announcement.links.delete(args.id); this.authority.revoke(args.id); return true; }
      if (method === 'sharing.permissions') { this.authority.update(args.id, args.permissions); return true; }
      if (mutations.has(method)) { if (this.phase !== 'running') throw new Error('机器人尚未运行'); if (method === 'playlist.play') { this.validatePlaylist(args.id, access); if (isLocalPlaylist(args.id)) return this.core.command('playlist.loadLocal', { append: !!args.append, expectedRevision: args.expectedRevision, songs: this.store.localPlaylist(args.id).songs }, access.owner ? grant.name : grant.actorName); } return this.core.command(method, args, access.owner ? grant.name : grant.actorName); }
      throw new Error('操作不存在');
    };
    // Screenshots must not hold the mutation gate while the owner is typing.
    // Browser controls remain ordered with login/logout and lifecycle changes.
    if (method === 'auth.browser.frame') return execute();
    if (/^auth\.browser\.(start|input|home|close)$/.test(method)) return this.gate.run('owner', requestId, execute);
    // Lifecycle changes and all mutations are serialized, with permissions checked again at execution.
    if (mutations.has(method) || /^(auth\.(importCookie|logout|browser\.)|bot\.(start|stop)|presets\.|sharing\.|playlist\.(publish|unpublish|saveQueue|import|delete|update)|identity\.(set|remove))/.test(method)) return this.gate.run(access.owner ? 'owner' : grant.id, requestId, async () => { try { return await execute(); } finally { this.changed(); } });
    return execute();
  }
  validatePlaylistEditing(id, access) { this.validatePlaylist(id, access); if (!isLocalPlaylist(id)) throw new Error('请先将网易云歌单另存为自建歌单后编辑'); }
  validatePlaylistRemoval(id, access) { this.validatePlaylist(id, access); if (!access.owner && !isLocalPlaylist(id)) throw new Error('网易云歌单引用只能由本机主人移除'); }
  validatePlaylist(id, access) { if (!isLocalPlaylist(id) && !/^\d{1,20}$/.test(String(id))) throw new Error('歌单 ID 无效'); if (!access.owner && !this.publications.some(p => p.id === String(id))) throw new Error('主人尚未开放此歌单'); }
  async close() { this.endRun(); this.phase = 'stopped'; try { await this.browserLogin?.close(); await this.core.close(); } finally { this.store.close(); } }
}
