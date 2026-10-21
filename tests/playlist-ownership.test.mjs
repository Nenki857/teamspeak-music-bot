import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {createVault,ALL_PERMISSIONS} from '../src/shared/security.mjs';
process.env.TSMD_DATA_DIR=resolve('work/shared-playlists-'+randomUUID());
const {Service}=await import('../src/worker/service.mjs');
const key=randomBytes(32);const track=id=>({id:String(id),name:'Song '+id,artist:'Artist',duration:180});
async function fixture(){
 const calls=[];const provider={getPublicSongs:async ids=>ids.map(track),getPublicPlaylist:async id=>({id,name:'Cloud '+id,songCount:2,songs:[track(1),track(2)]})};
 const s=new Service(createVault(key),()=>{}, {createCore:()=>({init(){},close(){},provider,status:()=>({queue:[track(1)]}),exportQueue:async()=>[track(1)],health:()=>({}),command:async()=>calls.push('playback')})});
 await s.init();s.phase='running';s.authority.beginRun();const grant=s.authority.create('All',ALL_PERMISSIONS);
 const access=(permissions=null)=>{const g=permissions?s.authority.create('Limited',permissions):grant;const auth=s.authority.exchange(g.raw);return{owner:false,session:auth.session,csrf:auth.csrf};};
 const create=(a,name='Shared')=>s.rpc('playlist.create',{name,ids:['1','2','3'],runId:s.authority.runId},a);
 return{s,provider,calls,grant,access,create};
}

test('every authorized visitor can rename, reorder, add, remove and delete local playlists without management identity',async()=>{
 const f=await fixture();const{s}=f;try{
 const alice=f.access(),bob=f.access();await s.rpc('identity.set',{name:'Alice'},alice);await s.rpc('identity.set',{name:'Bob'},bob);
 const list=await f.create(alice);const ownerList=s.store.saveLocalPlaylist({name:'Host playlist',songs:[track(8)]});s.reloadPlaylists();
 const args={id:list.id,name:'Edited by Bob',ids:['3','2','4','3'],expectedUpdatedAt:list.updatedAt,runId:s.authority.runId};
 const edited=await s.rpc('playlist.update',args,bob);assert.deepEqual(edited.songs.map(x=>x.id),['3','2','4']);assert.equal(edited.openedBy,'Alice');assert.equal(edited.published,true);assert.equal(edited.createdAt,list.createdAt);
 await assert.rejects(s.rpc('playlist.update',args,alice),/已被更新/);
 await assert.rejects(s.rpc('playlist.update',{...args,expectedUpdatedAt:edited.updatedAt,openedBy:'Bob'},bob),/署名/);
 const hostEdit=await s.rpc('playlist.update',{id:ownerList.id,name:'Host shared edit',ids:['8','9'],expectedUpdatedAt:ownerList.updatedAt,runId:s.authority.runId},bob);assert.equal(hostEdit.openedBy,'主人');
 await assert.rejects(s.rpc('playlist.delete',{id:list.id,expectedUpdatedAt:list.updatedAt,runId:s.authority.runId},bob),/已被更新/);
 await s.rpc('playlist.delete',{id:list.id,expectedUpdatedAt:edited.updatedAt,runId:s.authority.runId},bob);assert.throws(()=>s.store.localPlaylist(list.id),/不存在/);assert.deepEqual(f.calls,[]);
 }finally{await s.close();}
});

test('restart opens legacy unpublished snapshots and a fresh web session can edit and delete them without recovery',async()=>{
 let f=await fixture();const oldAccess=f.access();await f.s.rpc('identity.set',{name:'Legacy creator'},oldAccess);const oldRun=f.s.authority.runId;const list=await f.create(oldAccess,'Old hidden playlist');
 f.s.store.db.prepare('UPDATE local_playlists SET published=0 WHERE id=?').run(list.id);
 f.s.store.db.exec("CREATE TABLE IF NOT EXISTS playlist_owners(playlist_id TEXT PRIMARY KEY,owner_hash TEXT NOT NULL DEFAULT '',claim_hash TEXT NOT NULL DEFAULT '')");f.s.store.db.prepare('INSERT OR REPLACE INTO playlist_owners VALUES(?,?,?)').run(list.id,'unused-old-owner','unused-old-code');await f.s.close();
 f=await fixture();try{const a=f.access(),s=f.s;const loaded=await s.rpc('playlist.detail',{id:list.id},a);assert.equal(loaded.published,true);assert.equal(loaded.name,list.name);assert.equal(loaded.openedBy,'Legacy creator');assert.equal(loaded.createdAt,list.createdAt);assert.ok(loaded.updatedAt>list.updatedAt);assert.equal(s.store.db.prepare('SELECT published FROM local_playlists WHERE id=?').get(list.id).published,1);
 assert.ok((await s.rpc('playlists.targets',{songId:'4'},a)).some(item=>item.id===list.id));const status=await s.rpc('status',{},a);assert.equal(status.capabilities.openLocalPlaylists,true);assert.deepEqual(status.visitor,{name:''});assert.equal(status.capabilities.ownPlaylists,undefined);
 await assert.rejects(s.rpc('playlist.update',{id:list.id,name:'Stale',ids:['1'],expectedUpdatedAt:list.updatedAt,runId:s.authority.runId},a),/已被更新/);
 const edited=await s.rpc('playlist.update',{id:list.id,name:'After restart',ids:['2','1'],expectedUpdatedAt:loaded.updatedAt,runId:s.authority.runId},a);assert.equal(edited.openedBy,'Legacy creator');
 await assert.rejects(s.rpc('playlist.update',{id:list.id,ids:['1'],runId:oldRun},oldAccess),/失效/);
 await s.rpc('playlist.delete',{id:list.id,expectedUpdatedAt:edited.updatedAt,runId:s.authority.runId},a);assert.throws(()=>s.store.localPlaylist(list.id),/不存在/);
 }finally{await f.s.close();}
});

test('shared editing still requires saving permission, CSRF, a live link and a current version after metadata loading',async()=>{
 const f=await fixture();const{s}=f;try{const a=f.access(),limited=f.access(['view']);const list=await f.create(a);const args={id:list.id,name:'Attempt',ids:['1','9'],expectedUpdatedAt:list.updatedAt,runId:s.authority.runId};
 for(const method of['playlist.update','playlist.delete','playlist.addSong','playlists.targets'])await assert.rejects(s.rpc(method,{...args,songId:'9'},limited),/权限/);
 await assert.rejects(s.rpc('playlist.update',args,{...a,csrf:'wrong'}),/校验/);await assert.rejects(s.rpc('playlist.update',{...args,runId:'old-run'},a),/重新启动/);
 f.provider.getPublicSongs=async ids=>{s.authority.update(f.grant.id,['view']);return ids.map(track);};await assert.rejects(s.rpc('playlist.update',args,a),/权限/);assert.equal(s.store.localPlaylist(list.id).name,'Shared');
 s.authority.update(f.grant.id,ALL_PERMISSIONS);f.provider.getPublicSongs=async ids=>{s.store.removeLocalPlaylist(list.id);s.reloadPlaylists();return ids.map(track);};await assert.rejects(s.rpc('playlist.update',args,a),/未开放|不存在/);
 s.authority.revoke(f.grant.id);await assert.rejects(s.rpc('playlist.update',args,a),/失效/);assert.deepEqual(f.calls,[]);
 }finally{await s.close();}
});

test('management-code APIs are removed and local snapshots cannot be made private',async()=>{
 const f=await fixture();const{s}=f;try{const a=f.access();const list=await f.create(a);
 for(const method of['identity.bind','playlist.claim','playlist.issueClaim']){await assert.rejects(s.rpc(method,{id:list.id,runId:s.authority.runId},a),/本机|不存在/);await assert.rejects(s.rpc(method,{id:list.id}),/不存在/);}
 await assert.rejects(s.rpc('playlist.unpublish',{id:list.id}),/统一开放/);assert.ok(s.publications.some(item=>item.id===list.id));const before=s.store.localPlaylist(list.id);await s.rpc('playlist.publish',{id:list.id});const after=s.store.localPlaylist(list.id);assert.equal(after.updatedAt,before.updatedAt);assert.equal(after.openedBy,before.openedBy);
 const queue=await s.rpc('playlist.saveQueue',{name:'Shared queue',runId:s.authority.runId,published:false},a);assert.equal(queue.published,true);const edited=await s.rpc('playlist.update',{id:queue.id,name:'Queue edit',ids:['1','4'],expectedUpdatedAt:queue.updatedAt,runId:s.authority.runId,published:false},a);assert.equal(edited.published,true);
 }finally{await s.close();}
});

test('NetEase references stay read-only and a local copy is shared without changing the original cloud playlist',async()=>{
 const f=await fixture();const{s}=f;try{const alice=f.access(),bob=f.access();await s.rpc('identity.set',{name:'Alice'},alice);await s.rpc('identity.set',{name:'Bob'},bob);await s.rpc('playlist.share',{id:'555',runId:s.authority.runId},alice);await s.rpc('playlist.share',{id:'555',runId:s.authority.runId},bob);assert.equal(s.publications.find(item=>item.id==='555').openedBy,'Alice');
 await assert.rejects(s.rpc('playlist.update',{id:'555',name:'Cloud edit',ids:['1'],runId:s.authority.runId},bob),/另存/);await assert.rejects(s.rpc('playlist.addSong',{id:'555',songId:'9',runId:s.authority.runId},bob),/另存/);await assert.rejects(s.rpc('playlist.delete',{id:'555',runId:s.authority.runId},bob),/本机主人/);
 const copy=await f.create(bob,'Local cloud copy');assert.equal(copy.source,'local');assert.equal(copy.published,true);assert.ok(!(await s.rpc('playlists.targets',{songId:'9'},alice)).some(item=>item.id==='555'));await s.rpc('playlist.delete',{id:copy.id,expectedUpdatedAt:copy.updatedAt,runId:s.authority.runId},alice);assert.ok(s.publications.some(item=>item.id==='555'));await s.rpc('playlist.delete',{id:'555'});assert.ok(!s.publications.some(item=>item.id==='555'));assert.deepEqual(f.calls,[]);
 }finally{await s.close();}
});