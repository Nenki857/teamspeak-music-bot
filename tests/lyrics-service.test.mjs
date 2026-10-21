import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {createVault} from '../src/shared/security.mjs';
process.env.TSMD_DATA_DIR=resolve('work/lyrics-service-'+randomUUID());
const {Service}=await import('../src/worker/service.mjs');
async function fixture(t){let current={id:'1',platform:'netease'},resolveLyrics;const calls=[],commands=[];const provider={getLyrics:async id=>{calls.push(id);return resolveLyrics?resolveLyrics():[{time:0,text:'Fixture'}];}};const service=new Service(createVault(randomBytes(32)),()=>{},{createCore:()=>({init(){},close(){},status:()=>({currentSong:current,queue:[]}),health:()=>({}),provider,command:()=>commands.push('unexpected')})});await service.init();service.authority.beginRun();const grant=service.authority.create('Viewer',['view']);const auth=service.authority.exchange(grant.raw);const access={owner:false,session:auth.session,csrf:auth.csrf};t.after(()=>service.close());return{service,grant,access,calls,commands,setCurrent:value=>current=value,setLoader:value=>resolveLyrics=value};}
test('current-track lyrics are read-only with view permission and cannot fetch arbitrary song IDs',async t=>{
 const f=await fixture(t);assert.equal(f.service.snapshot().capabilities.lyrics,true);assert.deepEqual(await f.service.rpc('music.lyrics',{id:'1'},f.access),{songId:'1',lines:[{time:0,text:'Fixture'}]});assert.deepEqual(f.commands,[]);
 await assert.rejects(f.service.rpc('music.lyrics',{id:'2'},f.access),/已变化/);await assert.rejects(f.service.rpc('music.lyrics',{id:'../x'},f.access),/ID/);assert.deepEqual(f.calls,['1']);f.service.authority.revoke(f.grant.id);await assert.rejects(f.service.rpc('music.lyrics',{id:'1'},f.access));
});
test('a changed track or revoked grant while lyrics load cannot return a stale result',async t=>{
 const f=await fixture(t);let release;f.setLoader(()=>new Promise(r=>release=r));const pending=f.service.rpc('music.lyrics',{id:'1'},f.access);await Promise.resolve();f.setCurrent({id:'2',platform:'netease'});release([]);await assert.rejects(pending,/已变化/);
 f.setCurrent({id:'1',platform:'netease'});const revoked=f.service.rpc('music.lyrics',{id:'1'},f.access);await Promise.resolve();f.service.authority.revoke(f.grant.id);release([]);await assert.rejects(revoked);
});
