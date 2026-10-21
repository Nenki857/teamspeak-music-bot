import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { requireCore, dataDir } from './paths.mjs';
import { playlistName, playlistDescription, playlistSongs, isLocalPlaylist, imageMetadataUrl } from '../shared/playlist-format.mjs';
import { visitorName } from '../shared/visitor.mjs';

export class Store {
  constructor(vault) {
    mkdirSync(dataDir, { recursive: true }); this.vault = vault;
    const Database = requireCore('better-sqlite3'); this.db = new Database(resolve(dataDir, 'app.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS presets(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
    this.db.exec('CREATE TABLE IF NOT EXISTS local_playlists(id TEXT PRIMARY KEY,name TEXT NOT NULL,songs TEXT NOT NULL,cover_url TEXT NOT NULL,song_count INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,published INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS open_playlists(id TEXT PRIMARY KEY,json TEXT NOT NULL);');
    this.db.exec('CREATE TABLE IF NOT EXISTS visitor_names(name TEXT PRIMARY KEY,last_used INTEGER NOT NULL);');
    if (!this.db.prepare('PRAGMA table_info(local_playlists)').all().some(column => column.name === 'opened_by')) this.db.exec("ALTER TABLE local_playlists ADD COLUMN opened_by TEXT NOT NULL DEFAULT '主人'");
    if (!this.db.prepare('PRAGMA table_info(local_playlists)').all().some(column => column.name === 'description')) this.db.exec("ALTER TABLE local_playlists ADD COLUMN description TEXT NOT NULL DEFAULT ''");
    // Local snapshots are shared by policy, including older unpublished snapshots.
    this.db.prepare('UPDATE local_playlists SET published=1,updated_at=MAX(updated_at+1,?) WHERE published<>1').run(Date.now());
  }
  get(key, fallback = null) { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, JSON.stringify(value)); }
  visitorNames() { return this.db.prepare('SELECT name FROM visitor_names ORDER BY last_used DESC,rowid DESC LIMIT 200').all().map(row => row.name); }
  removeVisitorName(value) { const name = visitorName(value); return { name, removed: this.db.prepare('DELETE FROM visitor_names WHERE name=?').run(name).changes > 0 }; }
  rememberVisitorName(value) {
    const name = visitorName(value);
    this.db.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO visitor_names(name,last_used) VALUES(?,?)').run(name, Date.now());
      this.db.prepare('DELETE FROM visitor_names WHERE name NOT IN (SELECT name FROM visitor_names ORDER BY last_used DESC,rowid DESC LIMIT 200)').run();
    })();
    return name;
  }
  list() { return this.db.prepare('SELECT json FROM presets').all().map(r => this.public(JSON.parse(r.json))); }
  read(id) { const row = this.db.prepare('SELECT json FROM presets WHERE id=?').get(id); if (!row) throw new Error('预设不存在'); const p = JSON.parse(row.json); return { ...p, serverPassword: this.vault.decrypt(p.serverPassword), channelPassword: this.vault.decrypt(p.channelPassword) }; }
  public(p) { const { serverPassword, channelPassword, ...rest } = p; return { ...rest, hasServerPassword: !!serverPassword, hasChannelPassword: !!channelPassword }; }
  save(input) {
    if (!input || typeof input !== 'object') throw new Error('预设格式错误');
    const name = String(input.name || '').trim().slice(0, 80); if (!name) throw new Error('请填写预设名称');
    let host = String(input.serverAddress || '').trim(); let port = Number(input.serverPort || 9987);
    if (host.startsWith('ts3server://')) { const url = new URL(host); host = url.hostname; port = Number(url.searchParams.get('port') || url.port || port); }
    else if (/^[^:]+:\d+$/.test(host)) { const split = host.lastIndexOf(':'); port = Number(host.slice(split + 1)); host = host.slice(0, split); }
    host = host.replace(/^\[|\]$/g, '');
    if (!host || host.length > 253 || /[\s/?#@\\]/.test(host)) throw new Error('请输入域名或 IP，例如 ts.example.com:9987');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口范围为 1–65535');
    const channelId = String(input.channelId || '').trim(); if (channelId && !/^\d+$/.test(channelId)) throw new Error('频道 ID 必须为数字');
    const old = input.id ? this.read(input.id) : null;
    const p = { id: old?.id || randomUUID(), name, serverAddress: host, serverPort: port, nickname: String(input.nickname || 'Music Bot').trim().slice(0, 30) || 'Music Bot', channelId, defaultChannel: String(input.defaultChannel || '').trim().slice(0, 100),
      serverPassword: this.vault.encrypt(input.serverPassword === undefined ? old?.serverPassword : input.serverPassword), channelPassword: this.vault.encrypt(input.channelPassword === undefined ? old?.channelPassword : input.channelPassword), coreBotId: old?.coreBotId || null, updatedAt: Date.now() };
    this.db.prepare('INSERT OR REPLACE INTO presets VALUES(?,?)').run(p.id, JSON.stringify(p));
    if (!this.get('defaultPreset')) this.set('defaultPreset', p.id);
    return this.public(p);
  }
  bindBot(id, coreBotId) { const p = this.read(id); const sealed = { ...p, coreBotId, serverPassword: this.vault.encrypt(p.serverPassword), channelPassword: this.vault.encrypt(p.channelPassword) }; this.db.prepare('UPDATE presets SET json=? WHERE id=?').run(JSON.stringify(sealed), id); }
  remove(id) { this.db.prepare('DELETE FROM presets WHERE id=?').run(id); if (this.get('defaultPreset') === id) this.set('defaultPreset', this.list()[0]?.id || null); }
  localPlaylists() { return this.db.prepare('SELECT id,name,description,cover_url AS coverUrl,song_count AS songCount,created_at AS createdAt,updated_at AS updatedAt,published,opened_by AS openedBy FROM local_playlists ORDER BY updated_at DESC,id').all().map(row => ({ ...row, source: 'local', platform: 'netease', published: true })); }
  playlistTargets(songId) {
    return this.db.prepare(`SELECT p.id,p.name,p.cover_url AS coverUrl,p.song_count AS songCount,p.updated_at AS updatedAt,p.published,p.opened_by AS openedBy,
      EXISTS(SELECT 1 FROM json_each(p.songs) WHERE CAST(json_extract(value,'$.id') AS TEXT)=?) AS containsSong
      FROM local_playlists p
      ORDER BY p.updated_at DESC,p.id`).all(String(songId)).map(row => ({ ...row, source: 'local', published: true, containsSong: !!row.containsSong }));
  }
  localPlaylist(id) {
    if (!isLocalPlaylist(id)) throw new Error('本地歌单 ID 无效');
    const row = this.db.prepare('SELECT * FROM local_playlists WHERE id=?').get(id); if (!row) throw new Error('歌单不存在');
    return { id: row.id, name: row.name, description: row.description, coverUrl: row.cover_url, songCount: row.song_count, createdAt: row.created_at, updatedAt: row.updated_at,
      published: true, openedBy: row.opened_by, source: 'local', platform: 'netease', songs: JSON.parse(row.songs) };
  }
  saveLocalPlaylist({ id, name, description, songs, openedBy = '主人' }) {
    const tracks = playlistSongs(songs); const existing = id ? this.localPlaylist(id) : null;
    if (!existing && this.db.prepare('SELECT count(*) AS n FROM local_playlists').get().n >= 200) throw new Error('最多保存 200 个本地歌单');
    const now = Math.max(Date.now(), (existing?.updatedAt || 0) + 1); const key = existing?.id || 'local:' + randomUUID();
    this.db.prepare('INSERT OR REPLACE INTO local_playlists(id,name,description,songs,cover_url,song_count,created_at,updated_at,published,opened_by) VALUES(?,?,?,?,?,?,?,?,?,?)').run(key, playlistName(name === undefined ? existing?.name : name), playlistDescription(description === undefined ? existing?.description : description), JSON.stringify(tracks), tracks.find(song => song.coverUrl)?.coverUrl || '', tracks.length, existing?.createdAt || now, now, 1, visitorName(openedBy));
    return this.localPlaylist(key);
  }
  updateLocalPlaylist({ id, name, description, songs, expectedUpdatedAt }) {
    const existing = this.localPlaylist(id); const tracks = playlistSongs(songs);
    if (!Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt !== existing.updatedAt) throw new Error('歌单已被更新，请重新打开后编辑，或另存为新歌单');
    const changed = this.db.prepare('UPDATE local_playlists SET name=?,description=?,songs=?,cover_url=?,song_count=?,updated_at=?,published=1 WHERE id=? AND updated_at=?').run(playlistName(name), playlistDescription(description === undefined ? existing.description : description), JSON.stringify(tracks), tracks.find(song => song.coverUrl)?.coverUrl || '', tracks.length, Math.max(Date.now(), existing.updatedAt + 1), id, expectedUpdatedAt);
    if (!changed.changes) throw new Error('歌单已被更新，请重新打开后编辑');
    return this.localPlaylist(id);
  }
  removeLocalPlaylist(id) { this.localPlaylist(id); this.db.prepare('DELETE FROM local_playlists WHERE id=?').run(id); }
  openPlaylists() { return this.db.prepare('SELECT json FROM open_playlists ORDER BY rowid DESC').all().map(row => ({ openedBy: '主人', ...JSON.parse(row.json) })); }
  publishPlaylist(value, openedBy = '主人') {
    const id = String(value.id); if (!/^\d{1,20}$/.test(id)) throw new Error('歌单 ID 无效');
    if (!this.db.prepare('SELECT id FROM open_playlists WHERE id=?').get(id) && this.db.prepare('SELECT count(*) AS n FROM open_playlists').get().n >= 200) throw new Error('最多开放 200 个网易云歌单');
    const record = { id, name: String(value.name || '网易云歌单').slice(0, 160), coverUrl: imageMetadataUrl(value.coverUrl), songCount: Math.max(0, Math.min(1000000, Number(value.songCount) || 0)), source: 'netease', platform: 'netease', published: true, openedBy: visitorName(openedBy) };
    this.db.prepare('INSERT OR REPLACE INTO open_playlists(id,json) VALUES(?,?)').run(id, JSON.stringify(record));
  }
  unpublishPlaylist(id) { this.db.prepare('DELETE FROM open_playlists WHERE id=?').run(String(id)); }
  close() { this.db.close(); }
}
