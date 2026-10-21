import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID,randomBytes } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createServer } from 'node:http';
import { createVault } from '../src/shared/security.mjs';
import { SinusBotApi } from '../src/server/sinusbot-api.mjs';
import { changeBackend,sinusbotConfiguration } from '../src/server/configure-official-transport.mjs';
process.env.TSMD_DATA_DIR=resolve('work/official-tests-'+randomUUID());
const {CoreEngine}=await import('../src/server/official-core-engine.mjs');
function bridge(){
  const events=new Map(),calls=[],messages=[];let playing=false,position=0,volume=35,connected=false,channelId='1',clock=Date.now(),stall=false;
  const emit=(name,...args)=>events.get(name)?.(...args);
  const channel={id:()=>channelId,chat:text=>{messages.push(text);return true;}};
  const modules={event:{on:(name,fn)=>events.set(name,fn)},backend:{getCurrentChannel:()=>channel,isConnected:()=>connected,getChannelByID:id=>({id:()=>id}),getBotClient:()=>({moveTo:target=>{channelId=target.id();}})},media:{clearQueue(){},stop(){playing=false;position=0;emit('trackEnd');},playURL:url=>{calls.push(url);playing=true;position=0;if(!stall)emit('track');return true;}},audio:{setRepeat(){},setShuffle(){},getVolume:()=>volume,setVolume:value=>{volume=value;},getTrackPosition:()=>position,seek:value=>{position=value;},isPlaying:()=>playing}};
  let manifest;runInNewContext(readFileSync('deploy/sinusbot/tsmd-transport.js','utf8'),{registerPlugin:(m,fn)=>{manifest=m;fn();},require:name=>modules[name],Date:{now:()=>clock},Math,isFinite,Number,String,Error});
  const invoke=(op,args={})=>JSON.parse(JSON.stringify(events.get('api:tsmd')({data:()=>({op,...args})})));
  return {invoke,events,messages,calls,manifest,advance:ms=>{clock+=ms;},stall:()=>{stall=true;},setPosition:value=>{position=value;},connect:()=>{connected=true;},disconnect:()=>{connected=false;},finish:()=>{playing=false;emit('trackEnd');},join:()=>emit('clientMove',{client:{isSelf:()=>false},toChannel:channel})};
}
test('native bridge restores pause position, handles seek and EOF, counts joins and only registers authenticated events',()=>{
  const b=bridge();assert.equal(b.manifest.autorun,true);assert.ok([...b.events.keys()].every(name=>!name.startsWith('public:')));b.connect();
  assert.equal(b.invoke('play',{url:'https://p1.music.126.net/synthetic',playbackId:'one'}).result.playing,true);
  b.setPosition(21);assert.equal(b.invoke('pause').result.elapsed,21);assert.equal(b.invoke('status').result.paused,true);assert.equal(b.invoke('status').result.endedId,'');
  assert.equal(b.invoke('resume').result.elapsed,21);assert.equal(b.invoke('seek',{value:52}).result.elapsed,52);b.finish();assert.equal(b.invoke('status').result.endedId,'one');
  b.invoke('play',{url:'https://p1.music.126.net/second',playbackId:'two'});b.invoke('stop');assert.equal(b.invoke('status').result.endedId,'');
  b.join();assert.equal(b.invoke('status').result.arrivals,1);assert.equal(b.invoke('chat',{channelId:'wrong',text:'no'}).ok,false);assert.equal(b.messages.length,0);
  assert.equal(b.invoke('play',{url:'file:///etc/passwd',playbackId:'bad'}).ok,false);assert.equal(b.invoke('volume',{value:999}).ok,false);
  assert.equal(b.invoke('join',{channelId:'42'}).result.joinTarget,'42');
});
async function httpFixture(t,automaticCleanup=true){
  const b=bridge();let logins=0,rejectNext=false;const calls=[];
  const server=createServer(async(req,res)=>{let input='';for await(const chunk of req)input+=chunk;const body=input?JSON.parse(input):{};const path=req.url.slice('/api/v1'.length);calls.push({path,body});
    const reply=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    if(path==='/botId')return reply(200,{defaultBotId:'synthetic-bot'});
    if(path==='/bot/login'){logins++;return reply(200,{success:true,token:'synthetic-token-'+logins});}
    if(rejectNext){rejectNext=false;return reply(401,{});}
    if(req.headers.authorization!=='bearer synthetic-token-'+logins)return reply(401,{});
    if(path.endsWith('/event/tsmd'))return reply(200,b.invoke(body.op,body));
    if(path.endsWith('/spawn'))b.connect();if(path.endsWith('/kill'))b.disconnect();return reply(200,{success:true});
  });await new Promise(accept=>server.listen(0,'127.0.0.1',accept));const close=()=>{server.close();server.closeAllConnections();};if(automaticCleanup)t.after(close);
  const api=new SinusBotApi({url:`http://127.0.0.1:${server.address().port}`,username:'admin',password:'synthetic-private-password',instanceId:'synthetic-instance'});
  return {api,b,calls,close,reject:()=>{rejectNext=true;},get logins(){return logins;}};
}
test('loopback bridge API shares login, retries expired auth and never includes upstream secrets in errors',async t=>{
  const f=await httpFixture(t);await Promise.all([f.api.control('status'),f.api.control('status')]);assert.equal(f.logins,1);f.reject();await f.api.control('status');assert.equal(f.logins,2);
  for(const url of ['https://127.0.0.1:8087','http://203.0.113.10:8087','http://127.0.0.1:8087/path'])assert.throws(()=>new SinusBotApi({url}));
  const failed=new SinusBotApi({url:'http://127.0.0.1:18087',password:'private'},{fetcher:async()=>new Response('token=secret',{status:500})});await assert.rejects(failed.control('status'),error=>!error.message.includes('secret')&&!error.message.includes('private'));
});
async function engineFixture(t,initialMode='loop'){
  const f=await httpFixture(t,false),values=new Map([['officialPlayMode',initialMode]]),store={get:(key,fallback)=>values.has(key)?values.get(key):fallback,set:(key,value)=>values.set(key,value)};
  const changes=[];let disconnected=0;
  const provider={ready:Promise.resolve(),setQuality(){},close(){},getSongDetail:async id=>({id,name:'Song '+id,artist:'Artist',platform:'netease',duration:180,cookie:'not-for-browser'}),getSongUrl:async id=>({url:'https://p1.music.126.net/synthetic-'+id,trialDuration:60})};
  const core=new CoreEngine(store,createVault(randomBytes(32)),event=>changes.push(event),()=>{disconnected++;},{api:f.api,provider});await core.init();t.after(async()=>{try{await core.close();}finally{f.close();}});await core.start({serverAddress:'127.0.0.1',serverPort:9987,nickname:'Official',channelId:'42'});
  return {...f,core,changes,provider,values,get disconnected(){return disconnected;}};
}
test('official engine retains queue on interruption, resumes interrupted song from the beginning and advances only matching EOF',async t=>{
  const f=await engineFixture(t),c=f.core;
  await c.command('music.add',{id:'1'},'Alice');await c.command('music.add',{id:'2'},'Bob');await c.command('music.playNow',{id:'3'},'Chris');
  assert.deepEqual(c.status().queue.map(song=>song.id),['3','1','2']);assert.equal(c.status().currentSong.requestedBy,'Chris');assert.equal(c.status().effectiveDuration,60);
  assert.equal(JSON.stringify(c.status()).includes('not-for-browser'),false);assert.equal(JSON.stringify(c.status()).includes('https://p1.music.126.net/synthetic'),false);
  f.b.finish();await c.poll();assert.equal(c.status().currentSong.id,'1');assert.equal(c.status().elapsed,0);assert.equal(c.health().officialClient,true);assert.equal(c.health().supported,false);
  f.b.setPosition(24);await c.command('player.pause',{},'Owner');assert.equal(c.status().paused,true);assert.equal(c.status().elapsed,24);
  await c.command('player.resume',{},'Owner');assert.equal(c.status().elapsed,24);assert.equal(c.status().playing,true);
  await c.command('player.seek',{value:12},'Owner');assert.equal(c.status().elapsed,12);
  await c.command('player.volume',{value:25},'Owner');assert.equal(c.status().volume,25);
  f.b.join();await c.poll();assert.equal(f.changes.filter(x=>x?.channelJoin).length,1);
  const target=c.announcementTarget();process.env.TSMD_PUBLIC_URL='https://203.0.113.10';await c.sendShareAnnouncement({...target,url:'https://203.0.113.10/#invite='+'A'.repeat(43)});assert.equal(f.b.messages.length,1);
  await c.command('queue.clear',{},'Owner');await c.poll();assert.equal(c.status().queue.length,0);assert.equal(c.status().playing,false);
});
test('official engine rejects stale queue revisions, handles playlist append and fences a song URL resolving after stop',async t=>{
  const f=await engineFixture(t),c=f.core;
  await c.command('playlist.loadLocal',{songs:[{id:'7',name:'Seven',duration:90}]},'Owner');
  await c.command('playlist.loadLocal',{songs:[{id:'8',name:'Eight',duration:90}],append:true},'Friend');assert.equal(c.status().currentSong.id,'7');assert.equal(c.status().queue.length,2);
  await assert.rejects(c.command('queue.clear',{expectedRevision:-1},'Owner'),/变化/);assert.equal(c.status().queue.length,2);
  let complete;f.provider.getSongUrl=()=>new Promise(accept=>{complete=accept;});const before=f.b.calls.length;const request=c.resolveAndPlay({id:'9',duration:90});await c.stop();complete({url:'https://p1.music.126.net/late'});await assert.rejects(request,/结束/);assert.equal(f.b.calls.length,before);assert.equal(c.status().connected,false);
});
test('backend environment switches preserve HTTPS settings and render only a private audio-bridge listener',()=>{
  const original='TSMD_PUBLIC_URL=https://203.0.113.10\nTSMD_PERSISTENT_SHARES=1\nTSMD_AUDIO_BACKEND=custom\n';const next=changeBackend(original,'official');assert.ok(next.includes('TSMD_PERSISTENT_SHARES=1'));assert.equal(next.match(/^TSMD_AUDIO_BACKEND=/gm).length,1);assert.equal(changeBackend(next,'custom'),original);
  assert.throws(()=>changeBackend(original,'official\nBAD=1'));const config=sinusbotConfiguration('TS3Path = "old"\nListenHost="0.0.0.0"\nListenPort=8087\n[Other]\nValue=1','/home/ubuntu/app/runtime/sinusbot/TeamSpeak3-Client-linux_amd64/ts3client_linux_amd64');assert.ok(config.includes('ListenHost = "127.0.0.1"'));assert.equal(config.match(/ListenPort/g).length,1);assert.ok(config.includes('[Other]'));assert.throws(()=>sinusbotConfiguration('', '/path/with\nconfig-injection'));
});
test('a stream that never starts is reported without silently skipping or pretending to play forever',async t=>{
  const f=await engineFixture(t);f.b.stall();await f.core.command('music.add',{id:'12'},'Owner');assert.equal(f.core.status().playing,true);
  f.b.advance(45001);await f.core.poll();assert.equal(f.core.status().playing,false);assert.equal(f.core.status().queue.length,1);assert.ok(f.changes.some(event=>event?.diagnostic?.message.includes('45')));
});

test('official single repeat replays only natural EOF; explicit next and previous still navigate and list loop wraps',async t=>{
 const f=await engineFixture(t),c=f.core;assert.equal(c.status().playMode,'loop');await c.command('playlist.loadLocal',{songs:[{id:'1',name:'One',duration:90},{id:'2',name:'Two',duration:90}]},'Owner');
 await c.command('player.mode',{value:'single'},'Owner');assert.equal(f.values.get('officialPlayMode'),'single');const before=f.b.calls.length;f.b.finish();await c.poll();assert.equal(c.status().currentSong.id,'1');assert.equal(f.b.calls.length,before+1);assert.equal(c.status().elapsed,0);
 await c.command('player.next',{},'Owner');assert.equal(c.status().currentSong.id,'2');f.b.finish();await c.poll();assert.equal(c.status().currentSong.id,'2');await c.command('player.prev',{},'Owner');assert.equal(c.status().currentSong.id,'1');
 await c.command('player.mode',{value:'loop'},'Owner');await c.command('player.next',{},'Owner');await c.command('player.next',{},'Owner');assert.equal(c.status().currentSong.id,'1');
 for(const value of ['seq','rloop','invalid'])await assert.rejects(c.command('player.mode',{value},'Owner'),/模式无效/);
});
for(const [oldMode,current] of [['seq','loop'],['rloop','random'],['single','single']])test('official saved mode '+oldMode+' starts as '+current,async t=>{const f=await engineFixture(t,oldMode);assert.equal(f.core.status().playMode,current);});
