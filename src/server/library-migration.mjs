import { requireCore } from '../worker/paths.mjs';
import { isLocalPlaylist, playlistName, playlistDescription, playlistSongs, openPlaylistMetadata } from '../shared/playlist-format.mjs';
import { visitorName } from '../shared/visitor.mjs';

const kind = 'TS Music Desk server library';
function normalize(value) {
  if (value?.kind !== kind || value.version !== 1 || !Array.isArray(value.localPlaylists) || value.localPlaylists.length > 200 || !Array.isArray(value.openPlaylists) || value.openPlaylists.length > 200) throw new Error('歌单迁移文件无效');
  return { kind, version: 1,
    localPlaylists: value.localPlaylists.map(item => {
      if (!isLocalPlaylist(item.id)) throw new Error('自建歌单 ID 无效');
      return { id: item.id, name: playlistName(item.name), description: playlistDescription(item.description), songs: playlistSongs(item.songs), openedBy: visitorName(item.openedBy || '主人') };
    }),
    openPlaylists: value.openPlaylists.map(item => ({ ...openPlaylistMetadata(item), openedBy: visitorName(item.openedBy || '主人') }))
  };
}
export function exportLibrary(databaseFile) {
  const Database = requireCore('better-sqlite3'); const db = new Database(databaseFile, { readonly: true, fileMustExist: true });
  try {
    return db.transaction(() => normalize({ kind, version: 1,
      localPlaylists: db.prepare('SELECT id,name,description,songs,opened_by AS openedBy FROM local_playlists ORDER BY created_at').all().map(row => ({ ...row, songs: JSON.parse(row.songs) })),
      openPlaylists: db.prepare('SELECT json FROM open_playlists ORDER BY rowid').all().map(row => JSON.parse(row.json))
    }))();
  } finally { db.close(); }
}
export function importLibrary(store, input) {
  const value = normalize(input);
  return store.db.transaction(() => {
    let added = 0; let skipped = 0; const at = Date.now();
    const insert = store.db.prepare('INSERT INTO local_playlists(id,name,description,songs,cover_url,song_count,created_at,updated_at,published,opened_by) VALUES(?,?,?,?,?,?,?,?,?,?)');
    for (const item of value.localPlaylists) {
      if (store.db.prepare('SELECT 1 FROM local_playlists WHERE id=?').get(item.id)) { skipped++; continue; }
      if (store.db.prepare('SELECT count(*) AS n FROM local_playlists').get().n >= 200) throw new Error('迁移后自建歌单超过 200 个');
      insert.run(item.id, item.name, item.description, JSON.stringify(item.songs), item.songs.find(song => song.coverUrl)?.coverUrl || '', item.songs.length, at, at, 1, item.openedBy); added++;
    }
    for (const item of value.openPlaylists) {
      if (store.db.prepare('SELECT 1 FROM open_playlists WHERE id=?').get(item.id)) { skipped++; continue; }
      if (store.db.prepare('SELECT count(*) AS n FROM open_playlists').get().n >= 200) throw new Error('迁移后开放歌单超过 200 个');
      store.publishPlaylist(item, item.openedBy); added++;
    }
    return { added, skipped };
  })();
}
