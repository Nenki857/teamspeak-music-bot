import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {parse,compileScript} from '@vue/compiler-sfc';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
for(const name of['window','document','navigator','Element','HTMLElement','SVGElement','Node','Event','localStorage'])Object.defineProperty(globalThis,name,{value:dom.window[name],configurable:true});
const {createApp,nextTick}=await import('vue');const output=resolve('work/draft-search-tests');mkdirSync(output,{recursive:true});
for(const name of['MusicSearchResults','CommunityLibrary']){const{descriptor}=parse(readFileSync(resolve('src/renderer/'+name+'.vue'),'utf8'));const compiled=compileScript(descriptor,{id:'draft-search-'+name,inlineTemplate:true});let source=compiled.content.replace('./MusicSearchResults.vue','./MusicSearchResults.mjs');for(const shared of['touch-sort','playlist-format','album-song-collector'])source=source.replace("'../shared/"+shared+".mjs'",JSON.stringify(pathToFileURL(resolve('src/shared/'+shared+'.mjs')).href));writeFileSync(resolve(output,name+'.mjs'),source);}
const {default:Community}=await import(pathToFileURL(resolve(output,'CommunityLibrary.mjs')).href);
const settle=async()=>{for(let i=0;i<6;i++){await Promise.resolve();await nextTick();}};
const song=(id,popularity)=>({id:String(id),name:'Song '+id,artist:'Singer',artists:[{id:'9',name:'Singer'}],album:'Album '+id,duration:182,coverUrl:'http://p1.music.126.net/'+id+'.jpg',popularity,vip:id===1});
const items=[song(0,20),song(1,99),song(2,20),song(3)];
async function fixture(t,options={}){
 localStorage.clear();let vm;const calls=[],controls=[],notices=[];const container=document.createElement('div');document.body.append(container);
 const props={owner:true,canSearch:true,canSave:true,canEdit:true,initialMode:'draft',running:true,runId:'test-run',capabilities:{community:true,queueInterruption:true},permissions:['view','search','savePlaylist','playlist'],...options.props,
 request:async(method,args)=>{calls.push({method,args:structuredClone(args)});if(options.request){const reply=await options.request(method,args);if(reply!==undefined)return reply;}
 if(method==='music.search')return args.offset?{songs:[song(30,100)],playlists:[]}:{songs:items,playlists:[{id:'88',name:'Related',songCount:3,coverUrl:'http://p1.music.126.net/list.jpg'}]};
 if(method==='music.artist')return{artist:{id:'9',name:'Singer page',description:'Biography'},order:args.order,offset:args.offset,more:args.offset===0,songs:[song((args.order==='time'?200:100)+args.offset)]};
 if(method==='playlist.detail'||method==='playlist.preview')return{id:'88',name:'Related',songs:[items[0],items[1],items[0]],publicPreview:method==='playlist.preview',published:false};
 if(method==='playlist.share')return{id:'88',published:true,openedBy:'Alice'};
 if(method==='playlist.update')return{id:args.id,name:args.name,source:'local',updatedAt:112,published:true,songs:args.ids.map(id=>song(Number(id)))};
 throw Error('Unexpected RPC '+method);},onChoosePlaylist:item=>vm.addSong(item),onControl:event=>controls.push(event),onNotice:notice=>notices.push(notice)};
 const app=createApp(Community,props);vm=app.mount(container);await settle();t.after(()=>{app.unmount();container.remove();});
 const click=el=>el.dispatchEvent(new window.MouseEvent('click',{bubbles:true,cancelable:true}));const button=text=>[...container.querySelectorAll('button')].find(el=>el.textContent.trim()===text);const input=(el,value)=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));};
 const search=async query=>{input(container.querySelector('[aria-label="自建歌单搜索"]'),query);container.querySelector('.draft-search form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await settle();};
 const titles=()=>[...container.querySelectorAll('.draft-search .song-row:not(.table-head) .song-title strong')].map(el=>el.firstChild.textContent.trim());
 return{container,vm,calls,controls,notices,click,button,input,search,titles};
}
test('builder uses the standard metadata table, result types, stable popularity sorting, saved query paging and playback actions',async t=>{
 const ui=await fixture(t);await ui.search('First query');assert.deepEqual([...ui.container.querySelectorAll('.table-head>span')].map(el=>el.textContent),['#','歌曲','专辑','时长','']);assert.equal(ui.container.querySelectorAll('.song-title>img').length,4);assert.match(ui.container.querySelector('.song-title>img').src,/^https:/);assert.equal(ui.container.querySelector('.vip').textContent,'VIP');assert.equal(ui.container.querySelector('.album').textContent,'Album 0');assert.match(ui.container.querySelector('.song-row:not(.table-head)').textContent,/3:02/);
 ui.click(ui.button('人气优先'));await settle();assert.deepEqual(ui.titles(),['Song 1','Song 0','Song 2','Song 3']);
 const add=ui.container.querySelector('[aria-label="加入歌单 Song 1"]');ui.click(add);await settle();assert.equal(add.disabled,false);assert.equal(add.classList.contains('saved'),true);assert.equal(JSON.parse(localStorage.getItem('tsmd_playlist_draft_v1')).songs[0].id,'1');
 ui.click(ui.container.querySelector('.song-actions button[title^="立即插播"]'));ui.click(ui.container.querySelector('.song-actions button[title="加入队列"]'));await settle();assert.deepEqual(ui.controls,[{method:'music.playNow',args:{id:'1'}},{method:'music.add',args:{id:'1'}}]);
 ui.input(ui.container.querySelector('[aria-label="自建歌单搜索"]'),'Unsubmitted');ui.click(ui.button('加载更多歌曲'));await settle();assert.deepEqual(ui.calls.at(-1),{method:'music.search',args:{query:'First query',offset:30}});assert.equal(ui.titles()[0],'Song 30');
 ui.click(ui.button('综合'));await settle();assert.deepEqual(ui.titles(),['Song 0','Song 1','Song 2','Song 3','Song 30']);
 ui.click(ui.container.querySelector('.search-result-tabs button:nth-child(2)'));await settle();assert.equal(ui.container.querySelector('.playlist-card strong').textContent,'Related');
});
test('artist hot/latest/paging returns to the playlist and bulk addition preserves the original editing target, name and deduplication',async t=>{
 const ui=await fixture(t);ui.vm.editPlaylist({id:'local:original',name:'Keep my name',source:'local',updatedAt:111,published:true,songs:[items[0]]});await settle();await ui.search('Query');ui.click(ui.container.querySelector('.search-result-tabs button:nth-child(2)'));await settle();ui.click(ui.container.querySelector('.playlist-card'));await settle();assert.equal(ui.container.querySelector('.playlist-heading h2').textContent,'Related');
 ui.click(ui.container.querySelector('.artist-link'));await settle();assert.equal(ui.container.querySelector('.artist-heading h2').textContent,'Singer page');ui.click(ui.button('最新歌曲'));await settle();ui.click(ui.button('加载更多歌手歌曲'));await settle();assert.deepEqual(ui.calls.at(-1),{method:'music.artist',args:{id:'9',order:'time',offset:30}});assert.deepEqual(ui.titles(),['Song 200','Song 230']);
 ui.click(ui.button('← 返回上一页'));await settle();assert.equal(ui.container.querySelector('.playlist-heading h2').textContent,'Related');ui.click(ui.button('全部加入当前歌单'));await settle();const saved=JSON.parse(localStorage.getItem('tsmd_playlist_draft_v1'));assert.equal(saved.name,'Keep my name');assert.equal(saved.editTarget.id,'local:original');assert.deepEqual(saved.songs.map(song=>song.id),['0','1']);assert.match(ui.notices.at(-1),/跳过 2 首重复/);
 ui.click(ui.button('保存歌单修改'));await settle();assert.deepEqual(ui.calls.at(-1),{method:'playlist.update',args:{name:'Keep my name',ids:['0','1'],runId:'test-run',id:'local:original',expectedUpdatedAt:111}});
});
test('visitor playlist preview requires publishing before playback, while search errors and missing heat stay explicit',async t=>{
 const ui=await fixture(t,{props:{owner:false},request:async(method,args)=>{if(method==='music.search')return args.query==='Fail'?Promise.reject(Error('Search unavailable')):{songs:[song(0),song(1)],playlists:[{id:'88',name:'Related',songCount:3}]};}});await ui.search('Query');ui.click(ui.button('人气优先'));await settle();assert.match(ui.container.querySelector('.search-sort small').textContent,/未提供热度/);ui.click(ui.container.querySelector('.search-result-tabs button:nth-child(2)'));await settle();ui.click(ui.container.querySelector('.playlist-card'));await settle();assert.equal(ui.calls.at(-1).method,'playlist.preview');assert.equal(ui.button('▶ 播放歌单').disabled,true);ui.click(ui.button('加入开放歌单'));await settle();assert.equal(ui.button('▶ 播放歌单').disabled,false);ui.click(ui.button('▶ 播放歌单'));await settle();assert.deepEqual(ui.controls.at(-1),{method:'playlist.play',args:{id:'88'}});
 await ui.search('Fail');assert.match(ui.container.querySelector('[role="alert"]').textContent,/Search unavailable/);assert.equal(ui.container.querySelector('.draft-search .primary').disabled,false);
});

test('an authorized collaborator can edit an existing public draft without recovering its creator identity',async t=>{
 const ui=await fixture(t,{props:{owner:false,editableIds:[],capabilities:{community:true,collaborativePlaylists:true}}});
 ui.vm.editPlaylist({id:'local:shared',name:'Shared playlist',source:'local',updatedAt:111,published:true,songs:[items[0],items[1]]});await settle();
 assert.equal(ui.container.querySelector('[aria-label="自建歌单名称"]').value,'Shared playlist');
 ui.click(ui.container.querySelector('[aria-label="移除自建歌曲 Song 0"]'));await settle();
 const save=ui.button('保存歌单修改');assert.equal(save.disabled,false);ui.click(save);await settle();
 assert.deepEqual(ui.calls.at(-1),{method:'playlist.update',args:{name:'Shared playlist',ids:['1'],runId:'test-run',id:'local:shared',expectedUpdatedAt:111}});
});

test('user search inside the custom-playlist page keeps the editing target, name and introduction draft',async t=>{
 const ui=await fixture(t,{props:{capabilities:{community:true,collaborativePlaylists:true,playlistDescriptions:true}},request:async method=>method==='music.users'?{users:[{id:'9',name:'Public user'}],more:false}:undefined});
 ui.vm.editPlaylist({id:'local:original',name:'My draft',description:'Original introduction',source:'local',updatedAt:111,published:true,songs:[items[0]]});await settle();
 const intro=ui.container.querySelector('[aria-label="自建歌单简介"]');assert.equal(intro.value,'Original introduction');ui.input(intro,'Edited introduction\nSecond line');await settle();
 ui.click(ui.button('用户搜索'));await settle();ui.input(ui.container.querySelector('[aria-label="查找网易云用户"]'),'Public user');ui.container.querySelector('.public-user-search').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await settle();assert.match(ui.container.querySelector('.public-user-list').textContent,/Public user/);
 ui.click(ui.button('编辑歌单'));await settle();assert.equal(ui.container.querySelector('[aria-label="自建歌单简介"]').value,'Edited introduction\nSecond line');assert.equal(ui.container.querySelector('[aria-label="自建歌单名称"]').value,'My draft');assert.equal(JSON.parse(localStorage.getItem('tsmd_playlist_draft_v1')).description,'Edited introduction\nSecond line');
 ui.click(ui.button('保存歌单修改'));await settle();assert.deepEqual(ui.calls.at(-1),{method:'playlist.update',args:{name:'My draft',description:'Edited introduction\nSecond line',ids:['0'],runId:'test-run',id:'local:original',expectedUpdatedAt:111}});
});

test('server builder artist clicks search the name and preserve the playlist draft',async t=>{
  const ui=await fixture(t,{props:{capabilities:{community:true,artistNameSearch:true}}});
  ui.vm.editPlaylist({id:'local:original',name:'Keep my draft',source:'local',updatedAt:111,published:true,songs:[items[0]]});await settle();await ui.search('Original');ui.click(ui.button('人气优先'));await settle();
  ui.click(ui.container.querySelector('[title="搜索歌手 Singer"]'));await settle();
  assert.deepEqual(ui.calls.at(-1),{method:'music.search',args:{query:'Singer',offset:0}});assert.equal(ui.calls.some(c=>c.method==='music.artist'),false);assert.equal(ui.container.querySelector('[aria-label="自建歌单搜索"]').value,'Singer');assert.equal(ui.container.querySelector('.artist-heading'),null);
  const draft=JSON.parse(localStorage.getItem('tsmd_playlist_draft_v1'));assert.equal(draft.name,'Keep my draft');assert.equal(draft.editTarget.id,'local:original');assert.deepEqual(draft.songs.map(s=>s.id),['0']);
});

test('server automatically groups a bounded album-song batch, sorts locally and preserves manual album view and draft actions',async t=>{
  const album=id=>({id,name:'Album '+id,coverUrl:'https://p1.music.126.net/a.jpg',songCount:2,publishTime:Number(id)*100000,artist:'Singer'});
  const ui=await fixture(t,{props:{owner:false,capabilities:{community:true,queueInterruption:true,artistNameSearch:true,artistAlbums:true},permissions:['search','savePlaylist','add','playNow']},request:async(method,args)=>{
    if(method==='music.artistAlbums')return{artist:{id:args.id},albums:['9001','9002','9003','9004','9005'].map(album),offset:0,more:false};
    if(method==='music.album'){const n=Number(args.id)-9000;return{...album(args.id),songs:[song(n*100,n===1?10:n===2?30:undefined),song(n*100+1,n===1?90:n===2?40:undefined),song(n*100)]};}
  }});await ui.search('Original');ui.click(ui.container.querySelector('[title="查看歌手歌曲 Singer"]'));await settle();await settle();
  assert.deepEqual(ui.calls.filter(c=>c.method==='music.album').map(c=>c.args.id),['9001','9002','9003']);assert.equal(ui.calls.filter(c=>c.method==='music.artistAlbums').length,1);assert.equal(ui.container.querySelectorAll('.album-song-section').length,3);
  const headings=()=>[...ui.container.querySelectorAll('.album-song-heading h3')].map(e=>e.textContent);assert.deepEqual(headings(),['Album 9003','Album 9002','Album 9001']);assert.equal(ui.titles().length,6);
  ui.click(ui.button('全部展开'));await settle();const reads=ui.calls.length;ui.click(ui.button('按人气'));await settle();assert.deepEqual(headings(),['Album 9001','Album 9002','Album 9003']);assert.equal(ui.titles()[0],'Song 101');assert.equal(ui.calls.length,reads);
  ui.click(ui.container.querySelector('[title="加入队列"]'));await settle();assert.deepEqual(ui.controls.at(-1),{method:'music.add',args:{id:'101'}});ui.click(ui.container.querySelector('[aria-label="加入歌单 Song 101"]'));await settle();assert.deepEqual(JSON.parse(localStorage.getItem('tsmd_playlist_draft_v1')).songs.map(s=>s.id),['101']);
  ui.click(ui.button('加载更多歌曲'));await settle();await settle();assert.equal(ui.container.querySelectorAll('.album-song-section').length,5);assert.equal(ui.calls.filter(c=>c.method==='music.album').length,5);
  ui.click(ui.button('专辑列表'));await settle();assert.equal(ui.container.querySelectorAll('.artist-album-grid .playlist-card').length,5);const before=ui.calls.length;ui.click(ui.container.querySelector('.artist-album-grid .playlist-card'));await settle();assert.equal(ui.calls.length,before);assert.equal(ui.container.querySelector('.playlist-heading h2').textContent,'Album 9001');
  ui.click(ui.button('← 返回专辑列表'));await settle();ui.click(ui.button('搜索歌手名字'));await settle();assert.deepEqual(ui.calls.at(-1),{method:'music.search',args:{query:'Singer',offset:0}});assert.equal(ui.calls.some(c=>c.method==='music.artist'),false);
});
test('restricted album requests show the original error without retrying or falling back automatically',async t=>{
  const ui=await fixture(t,{props:{capabilities:{artistAlbums:true,artistNameSearch:true}},request:async method=>{if(method==='music.artistAlbums')throw Error('网易云暂时限制了此请求（-462）');}});await ui.search('Original');ui.click(ui.container.querySelector('[title="查看歌手歌曲 Singer"]'));await settle();assert.match(ui.container.querySelector('[role="alert"]').textContent,/-462/);assert.equal(ui.calls.filter(c=>c.method==='music.artistAlbums').length,1);assert.equal(ui.calls.filter(c=>c.method==='music.search').length,1);assert.equal(ui.calls.some(c=>c.method==='music.artist'),false);
});

test('a completed old album request cannot overwrite a new standard search',async t=>{
  let finish;const ui=await fixture(t,{props:{capabilities:{artistAlbums:true,artistNameSearch:true}},request:async method=>method==='music.artistAlbums'?new Promise(resolve=>{finish=resolve;}):undefined});
  await ui.search('Original');ui.click(ui.container.querySelector('[title="查看歌手歌曲 Singer"]'));await settle();assert.ok(ui.container.querySelector('[role="status"]'));
  await ui.search('New query');finish({artist:{id:'9'},albums:[{id:'9',name:'Stale album'}],more:false});await settle();assert.equal(ui.container.querySelector('.artist-album-grid'),null);assert.equal(ui.container.querySelector('[aria-label="自建歌单搜索"]').value,'New query');assert.deepEqual(ui.titles(),['Song 0','Song 1','Song 2','Song 3']);
});

test('an interrupted album-song batch cannot resume after a new search',async t=>{
  let finish;const ui=await fixture(t,{props:{capabilities:{artistAlbums:true}},request:async(method,args)=>method==='music.artistAlbums'?{artist:{id:args.id},albums:[{id:'1',name:'A'},{id:'2',name:'B'}],more:false}:method==='music.album'?new Promise(resolve=>{finish=()=>resolve({id:args.id,songs:[song(42)]});}):undefined});
  await ui.search('Original');ui.click(ui.container.querySelector('[title="查看歌手歌曲 Singer"]'));await settle();assert.equal(ui.calls.filter(c=>c.method==='music.album').length,1);await ui.search('New query');finish();await settle();assert.equal(ui.calls.filter(c=>c.method==='music.album').length,1);assert.equal(ui.container.querySelector('.album-song-section'),null);
});

async function collapsibleAlbums(t){
 const ui=await fixture(t,{props:{capabilities:{community:true,artistAlbums:true,artistNameSearch:true}},request:async(method,args)=>{
  if(method==='music.artistAlbums')return{artist:{id:args.id},albums:[{id:'11',name:'First album',publishTime:1000},{id:'22',name:'Second album',publishTime:2000}],more:false};
  if(method==='music.album')return{id:args.id,name:args.id==='11'?'First album':'Second album',songs:args.id==='11'?[{...song(1),name:'Needle song'},{...song(2),name:'Other song'}]:[{...song(3),name:'Third song'}]};
 }});await ui.search('Original');ui.click(ui.container.querySelector('[title="查看歌手歌曲 Singer"]'));await settle();await settle();return ui;
}
const settleDetails=async()=>{await new Promise(resolve=>setTimeout(resolve,0));await settle();};
test('album groups start collapsed, toggle individually and together, and compact rows omit duplicate headers and numbers',async t=>{
 const ui=await collapsibleAlbums(t);const groups=()=>[...ui.container.querySelectorAll('details.album-song-section')];assert.equal(groups().length,2);assert.ok(groups().every(d=>!d.open));assert.equal(ui.container.querySelectorAll('.album-song-section .table-head').length,0);assert.equal(ui.container.querySelectorAll('.album-song-section .song-number').length,0);assert.equal(ui.container.querySelectorAll('.album-song-section .song-row>.album').length,0);
 ui.click(groups()[0].querySelector('summary'));await settleDetails();assert.equal(groups()[0].open,true);assert.equal(groups()[1].open,false);
 ui.click(ui.button('全部展开'));await settleDetails();assert.ok(groups().every(d=>d.open));ui.click(ui.button('全部收起'));await settleDetails();assert.ok(groups().every(d=>!d.open));
});
test('song search reveals only matching album tracks, expands matching groups and restores expansion without network calls',async t=>{
 const ui=await collapsibleAlbums(t);const details=[...ui.container.querySelectorAll('details')];ui.click(details.find(d=>d.textContent.includes('First album')).querySelector('summary'));await settleDetails();const reads=ui.calls.length;
 const field=ui.container.querySelector('[aria-label="搜索专辑歌曲"]');ui.input(field,'needle');await settleDetails();assert.equal(ui.container.querySelectorAll('details').length,1);assert.equal(ui.container.querySelector('details').open,true);assert.deepEqual(ui.titles(),['Needle song']);assert.match(ui.container.querySelector('.album-search-count').textContent,/找到 1 首/);
 ui.input(field,'no-match');await settleDetails();assert.equal(ui.container.querySelectorAll('details').length,0);assert.match(ui.container.querySelector('.album-search-empty').textContent,/没有匹配/);
 ui.click(ui.container.querySelector('[aria-label="清空专辑歌曲搜索"]'));await settleDetails();const restored=[...ui.container.querySelectorAll('details')];assert.equal(restored.length,2);assert.equal(restored.find(d=>d.textContent.includes('First album')).open,true);assert.equal(restored.find(d=>d.textContent.includes('Second album')).open,false);assert.equal(ui.calls.length,reads);
});
test('single album song search works without album table headings or track numbers',async t=>{
 const ui=await collapsibleAlbums(t);ui.click(ui.button('专辑列表'));await settle();ui.click(ui.container.querySelector('.artist-album-grid .playlist-card'));await settle();const reads=ui.calls.length;ui.input(ui.container.querySelector('[aria-label="搜索专辑歌曲"]'),'Needle');await settle();assert.deepEqual(ui.titles(),['Needle song']);assert.equal(ui.container.querySelector('.table-head'),null);assert.equal(ui.container.querySelector('.song-number'),null);assert.equal(ui.container.querySelector('.album-expand-all'),null);assert.equal(ui.calls.length,reads);
});

test('one-click clear only changes selected draft songs, preserves metadata and edit target, and can be undone',async t=>{
 const ui=await fixture(t,{props:{capabilities:{community:true,playlistDescriptions:true,collaborativePlaylists:true}}});
 ui.vm.editPlaylist({id:'local:clear-test',source:'local',name:'Kept name',description:'Kept description',updatedAt:111,published:true,songs:[song(1),song(2)]});await settle();const before=ui.calls.length;
 ui.click(ui.button('一键清空'));await settle();assert.equal(ui.container.querySelectorAll('.draft-song-row').length,0);assert.equal(ui.button('一键清空').disabled,true);assert.equal(ui.container.querySelector('[aria-label="自建歌单名称"]').value,'Kept name');assert.equal(ui.container.querySelector('[aria-label="自建歌单简介"]').value,'Kept description');assert.equal(ui.calls.length,before);assert.deepEqual(ui.controls,[]);
 const stored=JSON.parse(localStorage.getItem('tsmd_playlist_draft_v1'));assert.deepEqual(stored.songs,[]);assert.equal(stored.editTarget.id,'local:clear-test');ui.click(ui.button('撤销清空'));await settle();assert.deepEqual([...ui.container.querySelectorAll('.draft-song-row')].map(el=>el.dataset.sortId),['1','2']);assert.equal(ui.button('撤销清空'),undefined);
 ui.click(ui.button('一键清空'));await settle();ui.vm.addSong(song(3));await settle();assert.equal(ui.button('撤销清空'),undefined);assert.deepEqual(JSON.parse(localStorage.getItem('tsmd_playlist_draft_v1')).songs.map(s=>s.id),['3']);assert.equal(ui.calls.length,before);
});
