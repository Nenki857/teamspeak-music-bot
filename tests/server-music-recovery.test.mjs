import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMusicRequestGate } from '../src/worker/music-request-gate.mjs';
import { createMusicAudit } from '../src/worker/music-audit.mjs';
import { configureServerMusicBot, refreshServerAuth, initialServerAuth } from '../src/worker/server-music-session.mjs';
import { BotInstance } from '../vendor/teamspeak-music-bot-1.13.2/dist/bot/instance.js';
import { NeteaseProvider } from '../vendor/teamspeak-music-bot-1.13.2/dist/music/netease.js';
import { IsolatedMusicProvider } from '../src/worker/music-provider.mjs';
import { safeError } from '../src/worker/core-engine.mjs';

const rejection = () => ({ status:400, body:{code:-462, msg:'MUSIC_U=PRIVATE https://private.invalid'} });
test('server limiter stops queued requests after a restriction and never automatically retries', async () => {
  let now=1000, attempts=0; const events=[];
  const gate=createMusicRequestGate({now:()=>now,wait:async ms=>{now+=ms;},log:e=>events.push(e)});
  const a=gate.run('artist_detail',async()=>{attempts++;throw rejection();});
  const b=gate.run('artist_songs',async()=>{attempts++;});
  const results=await Promise.allSettled([a,b]);
  assert.ok(results.every(r=>r.status==='rejected'));assert.equal(attempts,1);
  await assert.rejects(gate.run('song_url_v1',async()=>{attempts++;}),e=>e.neteaseCode===-462);
  assert.equal(attempts,1);now+=60001;
  await gate.run('song_url_v1',async()=>{attempts++;return{body:{code:200}};});
  assert.equal(attempts,2);assert.ok(events.some(e=>e.type==='cooldown-start'));
});
test('queued playback has priority, requests are spaced, and expired work is never submitted',async()=>{
  let now=1000, release;const starts=[];
  const gate=createMusicRequestGate({now:()=>now,wait:async ms=>{now+=ms;}});
  const first=gate.run('cloudsearch',()=>new Promise(resolve=>{release=resolve;}));
  const expired=gate.run('artist_detail',async()=>{throw Error('expired request sent');},{deadline:now+100});
  const playback=gate.run('song_url_v1',async()=>{starts.push(now);return{body:{code:200}};});
  const metadata=gate.run('artist_songs',async()=>{starts.push(now);return{body:{code:200}};});
  const expiredResult=expired.catch(e=>e.message);release({body:{code:200}});
  await Promise.all([first,playback,metadata]);assert.match(await expiredResult,/排队超时/);assert.deepEqual(starts,[1500,2000]);
});
test('request logs whitelist fields, rotate, and never include credentials or search contents',()=>{
  const dir=mkdtempSync(join(tmpdir(),'tsmd-audit-')),file=join(dir,'requests.jsonl');
  const log=createMusicAudit(file,{maxBytes:160,now:()=>1000});
  for(let i=0;i<10;i++)log({type:'request-failed',method:'artist_detail',code:-462,cookie:'PRIVATE',query:'PRIVATE_QUERY',url:'https://private.invalid',message:'PRIVATE'});
  assert.deepEqual(readdirSync(dir).sort(),['requests.jsonl','requests.jsonl.1']);
  for(const name of readdirSync(dir)){const text=readFileSync(join(dir,name),'utf8');assert.doesNotMatch(text,/PRIVATE|private.invalid|query|cookie/);assert.equal(JSON.parse(text.trim().split('\n')[0]).code,-462);}
});
test('server playback surfaces restriction while the desktop-compatible default still returns false',async()=>{
  const fake={connected:true,voteSkipUsers:new Set(),getProviderFor:()=>({getSongUrl:async()=>{throw Object.assign(new Error('restricted'),{status:400,neteaseCode:-462});}}),logger:{warn(){},error(){}}};
  const song={id:'1',platform:'netease'};
  assert.equal(await BotInstance.prototype.resolveAndPlay.call(fake,song),false);
  const bot={resolveAndPlay:(song,options)=>BotInstance.prototype.resolveAndPlay.call(fake,song,options)};
  configureServerMusicBot(bot);configureServerMusicBot(bot);
  await assert.rejects(bot.resolveAndPlay(song),e=>/-462/.test(safeError(e))&&!/版权/.test(safeError(e)));
});
function authCore(error){
  const values=new Map([['neteaseAuthProfile',{loggedIn:true,nickname:'Fixture'}]]);const events=[];
  const core={authEpoch:1,auth:{loggedIn:true,nickname:'Fixture'},provider:{getCookie:()=> 'PRIVATE_SESSION',getAuthStatus:async()=>{throw error;}},store:{get:k=>values.get(k),set:(k,v)=>values.set(k,v)},onChange:e=>{if(e)events.push(e);}};
  return{core,values,events};
}
test('failed auth checks preserve a saved session and previous profile; explicit invalidation is separate',async()=>{
  for(const error of [rejection(),Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})]){
    const{core,values,events}=authCore(error);await assert.rejects(refreshServerAuth(core));assert.equal(core.auth.loggedIn,true);assert.equal(core.auth.hasSession,true);assert.equal(core.auth.checkFailed,true);assert.equal(values.get('neteaseAuthProfile').nickname,'Fixture');assert.doesNotMatch(JSON.stringify(events),/PRIVATE|private.invalid/);
    assert.equal(initialServerAuth(core,'saved').nickname,'Fixture');
  }
  const{core}=authCore({status:301});await assert.rejects(refreshServerAuth(core));assert.equal(core.auth.loggedIn,false);assert.equal(core.auth.sessionInvalid,true);assert.equal(core.auth.hasSession,true);
});
test('an old auth check cannot overwrite a newly accepted account',async()=>{
  let reject;const{core}=authCore(null);core.provider.getAuthStatus=()=>new Promise((_,r)=>{reject=r;});const p=refreshServerAuth(core);core.authEpoch++;core.auth={loggedIn:true,nickname:'New'};reject(rejection());await assert.rejects(p);assert.deepEqual(core.auth,{loggedIn:true,nickname:'New'});
});
test('strict auth checks propagate provider failures without changing legacy callers',async()=>{
  const provider=new NeteaseProvider('http://127.0.0.1');provider.setCookie('fixture');provider.api={get:async()=>{throw rejection();}};
  assert.equal((await provider.getAuthStatus()).loggedIn,false);await assert.rejects(provider.getAuthStatus({propagateErrors:true}),e=>e.body.code===-462);
});
test('server song restriction stops follow-up requests and preserves the restriction across worker IPC',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'tsmd-artist-')),trace=join(dir,'trace');writeFileSync(trace,'');
  const saved={edition:process.env.TSMD_SERVER_EDITION,trace:process.env.TSMD_TEST_ARTIST_TRACE};process.env.TSMD_SERVER_EDITION='1';process.env.TSMD_TEST_ARTIST_TRACE=trace;
  let provider;try{provider=new IsolatedMusicProvider({apiModule:new URL('./fixtures/server-music-api.mjs',import.meta.url).href});}finally{if(saved.edition===undefined)delete process.env.TSMD_SERVER_EDITION;else process.env.TSMD_SERVER_EDITION=saved.edition;if(saved.trace===undefined)delete process.env.TSMD_TEST_ARTIST_TRACE;else process.env.TSMD_TEST_ARTIST_TRACE=saved.trace;}
  t.after(()=>provider.close());await provider.ready;provider.setCookie('fixture-session');
  await assert.rejects(provider.getSongDetail('462'),e=>e.neteaseCode===-462&&/-462/.test(e.message));
  await assert.rejects(provider.getSongUrl('1'),e=>e.neteaseCode===-462);
  assert.deepEqual(readFileSync(trace,'utf8').trim().split('\n'),['song_detail']);
});

test('local cooldown is distinguished from a new upstream denial through worker IPC and UI sanitization',async t=>{
  const saved=process.env.TSMD_SERVER_EDITION;process.env.TSMD_SERVER_EDITION='1';let provider;
  try{provider=new IsolatedMusicProvider({apiModule:new URL('./fixtures/server-music-api.mjs',import.meta.url).href});}finally{if(saved===undefined)delete process.env.TSMD_SERVER_EDITION;else process.env.TSMD_SERVER_EDITION=saved;}
  t.after(()=>provider.close());await provider.ready;provider.setCookie('fixture');
  await assert.rejects(provider.getSongDetail('462'),e=>/-462/.test(safeError(e))&&!/本地冷却/.test(safeError(e)));
  await assert.rejects(provider.getSongUrl('1'),e=>e.localCooldown===true&&e.retryAfterMs>0&&/本地冷却/.test(safeError(e))&&/未向网易云发送/.test(safeError(e)));
});

test('server artist API is disabled without sending artist metadata or song requests',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'tsmd-artist-disabled-')),trace=join(dir,'trace');writeFileSync(trace,'');
  const saved={edition:process.env.TSMD_SERVER_EDITION,trace:process.env.TSMD_TEST_ARTIST_TRACE};process.env.TSMD_SERVER_EDITION='1';process.env.TSMD_TEST_ARTIST_TRACE=trace;
  let provider;try{provider=new IsolatedMusicProvider({apiModule:new URL('./fixtures/server-music-api.mjs',import.meta.url).href});}finally{if(saved.edition===undefined)delete process.env.TSMD_SERVER_EDITION;else process.env.TSMD_SERVER_EDITION=saved.edition;if(saved.trace===undefined)delete process.env.TSMD_TEST_ARTIST_TRACE;else process.env.TSMD_TEST_ARTIST_TRACE=saved.trace;}
  t.after(()=>provider.close());await provider.ready;provider.setCookie('fixture');
  for(const args of [['21','hot',0],['33','hot',0],['21','time',30]])await assert.rejects(provider.getArtistPage(...args),/已停用.*搜索歌手名字/);
  assert.equal(readFileSync(trace,'utf8'),'');
});
