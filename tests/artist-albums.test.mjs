import test from 'node:test';
import assert from 'node:assert/strict';
import { artistAlbums, albumPage } from '../src/worker/album-catalog.mjs';
import { IsolatedMusicProvider } from '../src/worker/music-provider.mjs';
import { METHOD_PERMISSIONS } from '../src/worker/service.mjs';
import { createRequire } from 'node:module';
import { createNeteaseBrowserApi } from '../src/worker/netease-browser-api.mjs';
test('artist album catalog validates IDs, offset and response identity without profile or artist song calls',async()=>{
  const calls=[];const provider={getCookie:()=> 'PRIVATE',api:{get:async(route,{params})=>{calls.push({route,params});return{data:{artist:{id:params.id},hotAlbums:[{id:params.id+'01',name:'Album',picUrl:'https://p1.music.126.net/cover.jpg?token=PRIVATE',size:3,artist:{name:'Singer'},cookie:'PRIVATE'}],more:true}};}}};
  const first=await artistAlbums(provider,'21');const second=await artistAlbums(provider,'33',30);
  assert.equal(first.albums[0].id,'2101');assert.equal(second.albums[0].id,'3301');assert.equal(second.offset,30);assert.ok(calls.every(c=>c.route==='/artist/album'));assert.doesNotMatch(JSON.stringify(first),/PRIVATE|cookie|token/);
  await assert.rejects(artistAlbums(provider,'../1'));await assert.rejects(artistAlbums(provider,'1',-1));assert.equal(calls.length,2);
  provider.api.get=async()=>({data:{artist:{id:'99'},hotAlbums:[]}});await assert.rejects(artistAlbums(provider,'21'),/不匹配/);
});
test('album content verifies the returned ID and exposes only safe song metadata',async()=>{
  const provider={getCookie:()=>'',api:{get:async()=>({data:{album:{id:'10',name:'Album',cookie:'PRIVATE'},songs:[{id:1,name:'Song',cookie:'PRIVATE'}]}})}};
  const result=await albumPage(provider,'10',s=>s);assert.equal(result.id,'10');assert.equal(result.songs[0].name,'Song');assert.doesNotMatch(JSON.stringify(result),/PRIVATE|cookie/);await assert.rejects(albumPage(provider,'11',s=>s),/不匹配/);
});
test('album catalog travels through the isolated music worker with per-artist paging and uses search permissions',async t=>{
  const provider=new IsolatedMusicProvider({apiModule:new URL('./fixtures/music-api.mjs',import.meta.url).href});t.after(()=>provider.close());await provider.ready;provider.setCookie('fixture');
  const a=await provider.getArtistAlbums('21',0),b=await provider.getArtistAlbums('33',30);assert.equal(a.albums[0].id,'21000');assert.equal(b.albums[0].id,'33030');assert.equal(b.offset,30);const album=await provider.getAlbumPage(a.albums[0].id);assert.equal(album.songs.length,2);assert.equal(album.id,a.albums[0].id);assert.doesNotMatch(JSON.stringify(album),/PRIVATE/);
  assert.equal(METHOD_PERMISSIONS['music.artistAlbums'],'search');assert.equal(METHOD_PERMISSIONS['music.album'],'search');
});
test('real album builders keep album-specific web routes without calling artist profiles or artist songs',async()=>{
  const requireLibrary=createRequire(new URL('../vendor/teamspeak-music-bot-1.13.2/node_modules/NeteaseCloudMusicApi/main.js',import.meta.url));const calls=[];
  const api=createNeteaseBrowserApi({requireLibrary,fetchImpl:async(url)=>{calls.push(new URL(url).pathname);return new Response(JSON.stringify({code:200}));}});
  await api.artist_album({id:'21',limit:30,offset:0});await api.artist_album({id:'33',limit:30,offset:30});await api.album({id:'21001'});
  assert.deepEqual(calls,['/','/weapi/artist/albums/21','/weapi/artist/albums/33','/weapi/v1/album/21001']);
});
