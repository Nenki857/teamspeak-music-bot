import { LEGACY_PLAYLIST_KIND } from './legacy-brand.mjs';
export const PLAYLIST_FILE_KIND = 'TS Music Bot playlist';
export function playlistDateName(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
export function playlistName(value) { return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || playlistDateName(); }
export function playlistDescription(value) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new Error('歌单简介格式无效');
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (text.length > 500) throw new Error('歌单简介最多 500 字');
  return text;
}
export function isLocalPlaylist(id) { return /^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id)); }
export function imageMetadataUrl(value) {
  try {
    const url = new URL(String(value || '').slice(0, 2000));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) return '';
    if (url.hostname !== 'music.126.net' && !url.hostname.endsWith('.music.126.net')) return '';
    const size = url.searchParams.get('param'); url.search = ''; url.hash = '';
    if (/^\d{1,4}y\d{1,4}$/.test(size || '')) url.searchParams.set('param', size);
    url.protocol = 'https:'; url.port = ''; return url.href;
  } catch { return ''; }
}
export function songMetadata(value) {
  if (!value || typeof value !== 'object' || !/^\d{1,20}$/.test(String(value.id))) throw new Error('歌单中含无效歌曲 ID');
  const text = (input, max) => typeof input === 'string' ? input.slice(0, max) : '';
  const artists = (Array.isArray(value.artists) ? value.artists : []).filter(artist => artist && /^\d{1,20}$/.test(String(artist.id)) && typeof artist.name === 'string').slice(0, 20).map(artist => ({ id: String(artist.id), name: text(artist.name, 100) }));
  const popularity = Number.isFinite(value.popularity) ? Math.max(0, Math.min(100, value.popularity)) : undefined;
  return { id: String(value.id), name: text(value.name, 300) || '未知歌曲', artist: text(value.artist, 300), album: text(value.album, 300),
    duration: Number.isFinite(value.duration) ? Math.max(0, Math.min(86400, value.duration)) : 0,
    coverUrl: imageMetadataUrl(value.coverUrl), platform: 'netease', vip: !!value.vip, ...(artists.length ? { artists } : {}), ...(popularity !== undefined ? { popularity } : {}) };
}
export function playlistSongs(values) {
  if (!Array.isArray(values) || !values.length) throw new Error('歌单不能为空');
  if (values.length > 500) throw new Error('歌单最多保存 500 首歌曲');
  return values.map(songMetadata);
}
export function openPlaylistMetadata(value) {
  if (!value || !/^\d{1,20}$/.test(String(value.id))) throw new Error('开放歌单 ID 无效');
  return { id: String(value.id), name: String(value.name || '网易云歌单').slice(0, 160), coverUrl: imageMetadataUrl(value.coverUrl), songCount: Math.max(0, Math.min(1000000, Number(value.songCount) || 0)), source: 'netease', platform: 'netease', published: true };
}
export function playlistFile(name, songs, openPlaylists = [], description = '') { return { kind: PLAYLIST_FILE_KIND, version: 1, name: playlistName(name), description: playlistDescription(description), savedAt: new Date().toISOString(), songs: playlistSongs(songs), openPlaylists: openPlaylists.filter(item => /^\d{1,20}$/.test(String(item.id))).slice(0, 200).map(openPlaylistMetadata) }; }
export function readPlaylistFile(value) {
  if (!value || ![PLAYLIST_FILE_KIND, LEGACY_PLAYLIST_KIND].includes(value.kind) || value.version !== 1) throw new Error('请选择本工具导出的歌单 JSON 文件');
  if (value.openPlaylists !== undefined && (!Array.isArray(value.openPlaylists) || value.openPlaylists.length > 200)) throw new Error('开放歌单列表无效');
  return { name: playlistName(value.name), description: playlistDescription(value.description), songs: playlistSongs(value.songs), openPlaylists: (value.openPlaylists || []).map(openPlaylistMetadata) };
}
