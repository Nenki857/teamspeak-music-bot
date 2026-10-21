import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {LyricsCache} from '../src/worker/lyrics-cache.mjs';
import {normalizeLyrics,activeLyricIndex} from '../src/shared/lyrics.mjs';
async function directory(){await mkdir(resolve('work'),{recursive:true});return mkdtemp(resolve('work/lyrics-cache-'));}
const lines=[{time:0,text:'First',translation:'第一句'},{time:4.5,text:'Second'}];
test('lyrics normalize bounds and timing select the current line across seek, pause and the intro',()=>{
 const clean=normalizeLyrics([{time:8,text:'B'},{time:2,text:'A',translation:'译文'},{time:-1,text:'bad'},{time:Infinity,text:'bad'},{time:0,text:'  '}]);assert.deepEqual(clean,[{time:2,text:'A',translation:'译文'},{time:8,text:'B'}]);assert.equal(activeLyricIndex(clean,0),-1);assert.equal(activeLyricIndex(clean,2),0);assert.equal(activeLyricIndex(clean,9),1);assert.equal(activeLyricIndex(clean,3),0);assert.equal(activeLyricIndex(clean,NaN),-1);assert.ok(normalizeLyrics(Array.from({length:1000},(_,time)=>({time,text:'x'.repeat(500)}))).reduce((n,l)=>n+l.text.length+(l.translation?.length||0),0)<=32000);assert.throws(()=>normalizeLyrics({}),/格式/);
});
test('concurrent lyrics requests coalesce and disk cache survives a fresh process-level instance',async()=>{
 const dir=await directory();let calls=0,release;const wait=new Promise(r=>release=r);const cache=new LyricsCache({directory:dir,load:async()=>{calls++;await wait;return lines;}});
 const a=cache.get('123'),b=cache.get('123');release();assert.deepEqual(await a,lines);assert.deepEqual(await b,lines);assert.equal(calls,1);await cache.get('123');assert.equal(calls,1);
 const second=new LyricsCache({directory:dir,load:()=>{throw Error('should use disk');}});assert.deepEqual(await second.get('123'),lines);const saved=await readFile(join(dir,'123.json'),'utf8');assert.ok(!/cookie|account|token/i.test(saved));await assert.rejects(cache.get('../escape'),/ID/);
});
test('empty lyrics are cached and failures neither become empty lyrics nor retry within the cooldown',async()=>{
 let now=100000,calls=0;const cache=new LyricsCache({now:()=>now,load:async id=>{calls++;if(id==='2')throw Error('restricted -462');return [];}});
 assert.deepEqual(await cache.get('1'),[]);await cache.get('1');assert.equal(calls,1);await assert.rejects(cache.get('2'),/-462/);await assert.rejects(cache.get('2'),/-462/);assert.equal(calls,2);now+=60001;await assert.rejects(cache.get('2'),/-462/);assert.equal(calls,3);
});
test('expired or corrupt lyrics reload and disk entries remain bounded',async()=>{
 const dir=await directory();let now=Date.now(),calls=0;const cache=new LyricsCache({directory:dir,now:()=>now,maxEntries:2,load:async()=>{calls++;return lines;}});
 await writeFile(join(dir,'1.json'),'broken');await cache.get('1');now+=31*86400000;await cache.get('1');assert.equal(calls,2);await cache.get('2');await cache.get('3');assert.ok((await readdir(dir)).filter(s=>s.endsWith('.json')).length<=2);
});
test('disk write failure does not fail a successful lyrics request',async()=>{
 const dir=await directory(),file=join(dir,'file');await writeFile(file,'fixture');const cache=new LyricsCache({directory:file,load:async()=>lines});assert.deepEqual(await cache.get('1'),lines);assert.deepEqual(await cache.get('1'),lines);
});
