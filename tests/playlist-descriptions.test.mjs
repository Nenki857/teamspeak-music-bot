import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {createVault,ALL_PERMISSIONS} from '../src/shared/security.mjs';
import {playlistDescription,playlistFile,readPlaylistFile} from '../src/shared/playlist-format.mjs';
process.env.TSMD_DATA_DIR=resolve('work/playlist-descriptions-'+randomUUID());
const {Service}=await import('../src/worker/service.mjs');
const key=randomBytes(32),song=id=>({id:String(id),name:'Song '+id,artist:'Artist',duration:180});
async function fixture(){
 const reads=[];const provider={getPublicSongs:async ids=>{reads.push(ids);return ids.map(song);}};
 const s=new Service(createVault(key),()=>{}, {createCore:()=>({init(){},close(){},provider,health:()=>({}),status:()=>({queue:[song(1)]}),exportQueue:async()=>[song(1)]})});
 await s.init();s.phase='running';s.authority.beginRun();
 const guest=(permissions=ALL_PERMISSIONS)=>{const grant=s.authority.create('Friends',permissions),auth=s.authority.exchange(grant.raw);return{owner:false,session:auth.session,csrf:auth.csrf};};
 const create=(a,description='')=>s.rpc('playlist.create',{name:'Description list',description,ids:['1','2'],runId:s.authority.runId},a);
 return{s,guest,create,reads};
}

test('web collaborators can create, edit and clear a persistent plain-text introduction without changing attribution',async()=>{
 const f=await fixture(),{s}=f;try{
  const alice=f.guest(),bob=f.guest();await s.rpc('identity.set',{name:'Alice'},alice);await s.rpc('identity.set',{name:'Bob'},bob);
  const list=await f.create(alice,'  夜间歌单\r\n一起听 <b>音乐</b>\u0000  ');assert.equal(list.description,'夜间歌单\n一起听 <b>音乐</b>');
  assert.equal(s.publications.find(item=>item.id===list.id).description,list.description);assert.equal((await s.rpc('playlist.detail',{id:list.id},f.guest(['view']))).description,list.description);
  const args={id:list.id,name:list.name,ids:['2','1'],expectedUpdatedAt:list.updatedAt,runId:s.authority.runId};
  const edited=await s.rpc('playlist.update',{...args,description:'Bob 补充的简介'},bob);assert.equal(edited.description,'Bob 补充的简介');assert.equal(edited.openedBy,'Alice');assert.equal(edited.createdAt,list.createdAt);
  await assert.rejects(s.rpc('playlist.update',{...args,description:'过期简介'},alice),/已被更新/);
  const cleared=await s.rpc('playlist.update',{...args,description:'',expectedUpdatedAt:edited.updatedAt},alice);assert.equal(cleared.description,'');
  await assert.rejects(s.rpc('playlist.update',{...args,description:'Unauthorized',expectedUpdatedAt:cleared.updatedAt},f.guest(['view'])),/权限/);
 }finally{await s.close();}
});

test('older clients and song-picker additions preserve descriptions; queue saving and import/export carry them',async()=>{
 const f=await fixture(),{s}=f;try{
  const a=f.guest(),list=await f.create(a,'保留这个简介');
  const appended=await s.rpc('playlist.addSong',{id:list.id,songId:'3',expectedUpdatedAt:list.updatedAt,runId:s.authority.runId},a);assert.equal(appended.playlist.description,list.description);
  const legacy=await s.rpc('playlist.update',{id:list.id,name:'Older client edit',ids:['3','2'],expectedUpdatedAt:appended.playlist.updatedAt,runId:s.authority.runId},a);assert.equal(legacy.description,list.description);
  const queue=await s.rpc('playlist.saveQueue',{name:'Queue intro',description:'队列简介',runId:s.authority.runId},a);assert.equal(queue.description,'队列简介');
  const overwritten=await s.rpc('playlist.saveQueue',{id:queue.id,name:queue.name});assert.equal(overwritten.description,queue.description);
  const file=playlistFile('Portable',legacy.songs,[],legacy.description);assert.equal(readPlaylistFile(file).description,legacy.description);
  const imported=await s.rpc('playlist.import',{file});assert.equal(imported.description,legacy.description);assert.notEqual(imported.id,list.id);
  const oldFile={...file};delete oldFile.description;assert.equal(readPlaylistFile(oldFile).description,'');
 }finally{await s.close();}
});

test('description migration preserves legacy snapshots and new descriptions survive service restart and a fresh sharing session',async()=>{
 let f=await fixture();const list=await f.create(f.guest(),'Before migration');f.s.store.db.exec('ALTER TABLE local_playlists DROP COLUMN description');await f.s.close();
 f=await fixture();let updated;try{const a=f.guest(),legacy=await f.s.rpc('playlist.detail',{id:list.id},a);assert.equal(legacy.description,'');assert.equal(legacy.name,list.name);assert.equal(legacy.createdAt,list.createdAt);assert.deepEqual(legacy.songs.map(song=>song.id),['1','2']);
  updated=await f.s.rpc('playlist.update',{id:list.id,name:list.name,description:'重启仍保留\n第二行',ids:['1','2'],expectedUpdatedAt:legacy.updatedAt,runId:f.s.authority.runId},a);
 }finally{await f.s.close();}
 f=await fixture();try{const a=f.guest();assert.equal((await f.s.rpc('playlist.detail',{id:list.id},a)).description,updated.description);assert.equal(f.s.publications.find(item=>item.id===list.id).description,updated.description);}finally{await f.s.close();}
});

test('descriptions accept 500 characters and reject invalid or oversized input before catalog work',async()=>{
 assert.equal(playlistDescription('a'.repeat(500)).length,500);assert.equal(playlistDescription(undefined),'');assert.equal(playlistDescription('one\r\ntwo\tthree'),'one\ntwo\tthree');
 for(const value of[null,12,{},'a'.repeat(501)])assert.throws(()=>playlistDescription(value),/简介/);
 const f=await fixture(),{s}=f;try{const a=f.guest();for(const value of[null,{},'a'.repeat(501)])await assert.rejects(f.create(a,value),/简介/);assert.equal(f.reads.length,0);
  const list=await f.create(a,'a'.repeat(500));await assert.rejects(s.rpc('playlist.update',{id:list.id,name:list.name,description:'a'.repeat(501),ids:['9'],expectedUpdatedAt:list.updatedAt,runId:s.authority.runId},a),/500/);assert.equal(f.reads.length,1);assert.equal(s.store.localPlaylist(list.id).description,list.description);
 }finally{await s.close();}
});
