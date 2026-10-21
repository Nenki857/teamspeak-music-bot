import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAlbumSongBatch,sortAlbumSongGroups } from '../src/shared/album-song-collector.mjs';
const album=id=>({id:String(id),name:'Album '+id,publishTime:id*1000});
const state=(n=6)=>({albums:Array.from({length:n},(_,i)=>album(i+1)),offset:0,more:false,cursor:0,groups:[],trackCount:0});
test('auto collection is sequential, bounded to three albums and resumes instead of refetching',async()=>{
  const s=state(),calls=[];let active=0;const readAlbum=async id=>{assert.equal(active++,0);calls.push(id);await Promise.resolve();active--;return{id,songs:[{id:'same'},{id:'same'},{id:'unique-'+id}]};};
  await collectAlbumSongBatch(s,{readAlbum});assert.deepEqual(calls,['1','2','3']);assert.equal(s.trackCount,6);assert.equal(s.groups[0].songs.length,2);assert.equal(s.groups[1].songs[0].id,'same');
  await collectAlbumSongBatch(s,{readAlbum});assert.deepEqual(calls,['1','2','3','4','5','6']);assert.equal(s.cursor,6);
});
test('collector stops at the total song cap and marks a partial final album',async()=>{
  const s=state();let calls=0;await collectAlbumSongBatch(s,{maxSongs:50,readAlbum:async id=>{calls++;return{id,songs:Array.from({length:100},(_,i)=>({id:String(i)}))};}});assert.equal(calls,1);assert.equal(s.trackCount,50);assert.equal(s.groups[0].truncated,true);
});
test('a failed album preserves partial progress and requires an explicit next batch to retry',async()=>{
  const s=state();let fail=true;const calls=[];const readAlbum=async id=>{calls.push(id);if(id==='2'&&fail)throw Error('-462');return{id,songs:[{id}]};};await assert.rejects(collectAlbumSongBatch(s,{readAlbum}),/-462/);assert.equal(s.cursor,1);assert.equal(s.groups.length,1);assert.deepEqual(calls,['1','2']);fail=false;await collectAlbumSongBatch(s,{readAlbum});assert.deepEqual(calls,['1','2','2','3','4']);
});
test('leaving the artist view discards an unfinished album and stops the remaining batch',async()=>{
  const s=state();let current=true,calls=0;await collectAlbumSongBatch(s,{isCurrent:()=>current,readAlbum:async id=>{calls++;current=false;return{id,songs:[{id}]};}});assert.equal(calls,1);assert.equal(s.cursor,0);assert.equal(s.groups.length,0);
});
test('album page reads are bounded and repeated album IDs are not expanded twice',async()=>{
  const s=state(1);s.more=true;const pages=[];const calls=[];await collectAlbumSongBatch(s,{readPage:async offset=>{pages.push(offset);return{albums:[album(1),album(2)],more:true};},readAlbum:async id=>{calls.push(id);return{id,songs:[{id}]};}});assert.deepEqual(pages,[30]);assert.deepEqual(calls,['1','2']);assert.equal(s.offset,30);
});
test('time and popularity sorts are stable, preserve original data and place unknown heat last',()=>{
  const groups=[{album:album(1),songs:[{id:'a',popularity:10},{id:'b',popularity:90}]},{album:album(3),songs:[{id:'c'}]},{album:album(2),songs:[{id:'d',popularity:40}]}];assert.deepEqual(sortAlbumSongGroups(groups,'time').map(g=>g.album.id),['3','2','1']);const sorted=sortAlbumSongGroups(groups,'popular');assert.deepEqual(sorted.map(g=>g.album.id),['1','2','3']);assert.deepEqual(sorted[0].songs.map(s=>s.id),['b','a']);assert.equal(groups[0].songs[0].id,'a');
});
