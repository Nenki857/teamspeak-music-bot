import { imageMetadataUrl, songMetadata } from '../shared/playlist-format.mjs';
import { publicUserQuery } from '../shared/visitor.mjs';
const validId = value => { if (!/^\d{1,20}$/.test(String(value))) throw new Error('网易云 ID 无效'); return String(value); };
const person = value => ({ id: validId(value.userId), name: String(value.nickname || '网易云用户').slice(0, 100), avatarUrl: imageMetadataUrl(value.avatarUrl) });
const playlist = value => ({ id: validId(value.id), name: String(value.name || '网易云歌单').slice(0, 160), coverUrl: imageMetadataUrl(value.coverImgUrl), songCount: Math.max(0, Math.min(1000000, Number(value.trackCount) || 0)), creatorName: String(value.creator?.nickname || '').slice(0, 100), source: 'netease', platform: 'netease', publicPreview: true });
export async function publicMusic(method, provider, mapSongs, ...args) {
  if (method === 'searchUsers') {
    const [input, mode = 'nickname', offset = 0] = args; const parsed = publicUserQuery(input, mode);
    if (parsed.mode === 'uid') {
      const result = await provider.api.get('/user/detail', { params: { uid: parsed.query } });
      return { users: result.data?.profile ? [person(result.data.profile)] : [], more: false };
    }
    const result = await provider.api.get('/search', { params: { keywords: parsed.query, type: 1002, limit: 30, offset } });
    const users = (result.data?.result?.userprofiles || []).slice(0, 30).map(person);
    return { users, more: users.length === 30 && offset + users.length < Math.min(300, Number(result.data?.result?.userprofileCount) || 300) };
  }
  if (method === 'getPublicUserPlaylists') {
    const [input, offset = 0] = args; const uid = validId(input);
    const [detail, list] = await Promise.all([provider.api.get('/user/detail', { params: { uid } }), provider.api.get('/user/playlist', { params: { uid, offset, limit: 30 } })]);
    if (!detail.data?.profile) throw new Error('未找到用户');
    const raw = list.data?.playlist || [];
    return { user: person(detail.data.profile), playlists: raw.filter(item => !item.privacy).slice(0, 30).map(playlist), more: !!list.data?.more && offset + 30 < 300 };
  }
  if (method === 'getPublicPlaylist') {
    const id = validId(args[0]); const detail = await provider.api.get('/playlist/detail', { params: { id } }); const raw = detail.data?.playlist;
    if (!raw || raw.privacy || String(raw.id) !== id) throw new Error('歌单未公开或不存在');
    return { ...playlist(raw), songs: (await provider.getPlaylistSongs(id)).slice(0, 500).map(songMetadata) };
  }
  if (method === 'getPublicSongs') {
    const ids = args[0];
    if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw new Error('歌单需要 1–500 首歌曲');
    const checked = ids.map(validId); const unique = [...new Set(checked)];
    const result = await provider.api.get('/song/detail', { params: { ids: unique.join(',') } });
    const songs = new Map(mapSongs(result.data?.songs).map(song => [song.id, songMetadata(song)]));
    if (checked.some(id => !songs.has(id))) throw new Error('有歌曲无法读取，请移除后重试');
    return checked.map(id => songs.get(id));
  }
  throw new Error('公开音乐操作不存在');
}
