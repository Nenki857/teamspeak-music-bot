import test from 'node:test';
import assert from 'node:assert/strict';
import { playlistFile,readPlaylistFile } from '../src/shared/playlist-format.mjs';
import { LEGACY_PLAYLIST_KIND,LEGACY_LIBRARY_KIND,LEGACY_VERIFICATION_KIND } from '../src/shared/legacy-brand.mjs';
import { verificationPage,completeVerificationUrl } from '../scripts/netease-verification.mjs';
import { importLibrary } from '../src/server/library-migration.mjs';
const song={id:'12',name:'A song',artist:'An artist'};
test('new playlist exports use Music Bot while older exports can still be imported',()=>{
  const current=playlistFile('My songs',[song]);assert.equal(current.kind,'TS Music Bot playlist');
  assert.deepEqual(readPlaylistFile({...current,kind:LEGACY_PLAYLIST_KIND}),readPlaylistFile(current));
  assert.throws(()=>readPlaylistFile({...current,kind:'unknown'}),/本工具导出/);
});
test('legacy server libraries normalize without account changes or weakened validation',()=>{
  const store={db:{transaction:fn=>fn,prepare:()=>({run:()=>{throw Error('Empty migration must not write data');}})}};
  const file={kind:LEGACY_LIBRARY_KIND,version:1,localPlaylists:[],openPlaylists:[]};
  assert.deepEqual(importLibrary(store,file),{added:0,skipped:0});
  assert.throws(()=>importLibrary(store,{...file,version:2}),/迁移文件无效/);
});
test('unexpired official verification records remain valid across the rename',()=>{
  const now=Date.now(),url=completeVerificationUrl({verifyUrl:'https://st.music.163.com/encrypt-pages',verifyToken:'token',verifyId:1,verifyType:40,params:{event_id:'event'}});
  const record={kind:LEGACY_VERIFICATION_KIND,createdAt:new Date(now).toISOString(),state:'verification-available',contextComplete:true,url};
  assert.equal(verificationPage(record,now),url);assert.equal(verificationPage(record,now+600001),null);
});
