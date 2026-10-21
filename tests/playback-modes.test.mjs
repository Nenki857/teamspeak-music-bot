import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PlayQueue,PlayMode,normalizePlayMode} from '../vendor/teamspeak-music-bot-1.13.2/dist/audio/queue.js';
import {BotInstance} from '../vendor/teamspeak-music-bot-1.13.2/dist/bot/instance.js';
import {createDatabase} from '../vendor/teamspeak-music-bot-1.13.2/dist/data/database.js';
const song=id=>({id,name:id,artist:'Artist',album:'',coverUrl:'',platform:'netease',duration:30});
function queue(){const q=new PlayQueue();q.addMany(['A','B','C'].map(song));q.play();return q;}
test('single repeat keeps current entry on natural end while manual navigation and list wrap work',()=>{
 const q=queue();q.setMode(PlayMode.Single);for(let i=0;i<4;i++)assert.equal(q.next(true).id,'A');assert.equal(q.next().id,'B');assert.equal(q.next(true).id,'B');assert.equal(q.prev().id,'A');q.playAt(2);assert.equal(q.next().id,'A');assert.equal(q.next(true).id,'A');
 q.setMode(PlayMode.Loop);q.playAt(2);assert.equal(q.next(true).id,'A');q.clear();q.add(song('Only'));q.setMode(PlayMode.Single);assert.equal(q.next(true).id,'Only');assert.equal(q.next(true).id,'Only');
});
test('custom playback repeats natural EOF but skips a failed repeated track without retrying it forever',async()=>{
 const q=queue(),played=[];q.setMode(PlayMode.Single);let fail=false;const ctx={queue:q,isAdvancing:false,connected:true,voteSkipUsers:new Set(),player:{stop(){}},profileManager:{async onSongChange(){}},sweepLocalAudio(){},emit(){},resolveAndPlay:async song=>{played.push(song.id);return !(fail&&song.id==='A');}};
 await BotInstance.prototype.playNext.call(ctx,3,true);assert.deepEqual(played,['A']);await BotInstance.prototype.playNext.call(ctx);assert.equal(q.current().id,'B');q.playAt(0);fail=true;await BotInstance.prototype.playNext.call(ctx,3,true);assert.equal(q.current().id,'B');assert.deepEqual(played.slice(-2),['A','B']);
});
test('saved legacy modes normalize to the three supported modes and single survives snapshot restore',()=>{
 assert.equal(normalizePlayMode('seq'),'loop');assert.equal(normalizePlayMode('rloop'),'random');assert.equal(normalizePlayMode('single'),'single');assert.equal(normalizePlayMode('unknown'),'loop');const q=queue();q.setMode(PlayMode.Single);q.playAt(1);const restored=new PlayQueue();restored.restore(q.snapshot());assert.equal(restored.getMode(),'single');assert.equal(restored.next(true).id,'B');restored.restore({...q.snapshot(),mode:'seq'});assert.equal(restored.getMode(),'loop');
});
test('single repeat persists through the real player settings database',()=>{
 mkdirSync(resolve('work'),{recursive:true});const file=resolve('work/mode-settings-'+randomUUID()+'.db');let db=createDatabase(file);try{db.saveBotInstance({id:'mode-bot',name:'Mode',serverAddress:'localhost',serverPort:9987,nickname:'Mode',defaultChannel:'',channelId:'',channelPassword:'',serverPassword:'',serverProtocol:'',ts6ApiKey:'',autoStart:false});db.savePlayMode('mode-bot','single');assert.equal(db.getPlayerSettings('mode-bot').playMode,'single');}finally{db.close();}db=createDatabase(file);try{assert.equal(db.getPlayerSettings('mode-bot').playMode,'single');}finally{db.close();}
});
test('random keeps the existing shuffle-without-replacement behavior',()=>{
 const q=queue();q.setMode(PlayMode.Random);const seen=new Set([q.current().id]);for(let i=0;i<2;i++){const next=q.next(true);assert.ok(next);assert.ok(!seen.has(next.id));seen.add(next.id);}assert.equal(seen.size,3);assert.equal(q.next(true),null);
});
