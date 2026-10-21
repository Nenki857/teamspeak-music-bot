import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {parse,compileScript} from '@vue/compiler-sfc';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const dom=new JSDOM('<!doctype html><html><body></body></html>',{url:'http://localhost/'});
for(const name of ['window','document','navigator','Element','HTMLElement','SVGElement','Node','Event'])Object.defineProperty(globalThis,name,{value:dom.window[name],configurable:true});
const {createApp,nextTick,reactive,h}=await import('vue');
const {descriptor}=parse(readFileSync(resolve('src/renderer/LyricsPanel.vue'),'utf8'));const compiled=compileScript(descriptor,{id:'lyrics-regression',inlineTemplate:true});
const output=resolve('work/lyrics-panel-tests/Component.mjs');mkdirSync(resolve('work/lyrics-panel-tests'),{recursive:true});writeFileSync(output,compiled.content.replace("'../shared/lyrics.mjs'",JSON.stringify(pathToFileURL(resolve('src/shared/lyrics.mjs')).href)));
const {default:Component}=await import(pathToFileURL(output).href);
const settle=async()=>{for(let i=0;i<5;i++){await Promise.resolve();await nextTick();}};
const lyricLines=[{time:2,text:'First',translation:'第一句'},{time:5,text:'Second'}];
async function fixture(t,options={}){const calls=[],props=reactive({song:{id:'1',platform:'netease'},elapsed:0,playing:false,duration:180,...options,loadLyrics:async id=>{calls.push(id);return options.loadLyrics?options.loadLyrics(id):{songId:id,lines:lyricLines};}});const host=document.createElement('div');document.body.append(host);const app=createApp({render:()=>h(Component,props)});app.mount(host);await settle();t.after(()=>{app.unmount();host.remove();});return{host,props,calls,button:text=>[...host.querySelectorAll('button')].find(b=>b.textContent.trim()===text)};}
test('lyrics load once per current track and synchronize using existing elapsed state without polling',async t=>{
 const ui=await fixture(t);assert.deepEqual(ui.calls,['1']);assert.equal(ui.host.querySelector('.active'),null);ui.props.elapsed=2;await settle();assert.match(ui.host.querySelector('.active').textContent,/First/);ui.props.elapsed=7;await settle();assert.equal(ui.host.querySelector('.active').textContent,'Second');ui.props.elapsed=3;await settle();assert.match(ui.host.querySelector('.active').textContent,/第一句/);assert.deepEqual(ui.calls,['1']);
});
test('a slow old-track reply cannot replace the new track lyrics',async t=>{
 const pending=new Map();const ui=await fixture(t,{loadLyrics:id=>new Promise(r=>pending.set(id,r))});ui.props.song={id:'2',platform:'netease'};await settle();pending.get('2')({songId:'2',lines:[{time:0,text:'New song'}]});await settle();pending.get('1')({songId:'1',lines:[{time:0,text:'Old song'}]});await settle();assert.match(ui.host.textContent,/New song/);assert.doesNotMatch(ui.host.textContent,/Old song/);assert.deepEqual(ui.calls,['1','2']);
});
test('lyrics errors remain local and only an explicit retry makes another request',async t=>{
 let attempts=0;const ui=await fixture(t,{loadLyrics:async id=>{if(++attempts===1)throw Error('restricted -462');return{songId:id,lines:lyricLines};}});assert.match(ui.host.textContent,/-462/);ui.props.elapsed=10;await settle();ui.button('收起').click();await settle();ui.button('展开').click();await settle();assert.equal(ui.calls.length,1);ui.button('重试').click();await settle();assert.equal(ui.calls.length,2);assert.match(ui.host.textContent,/Second/);
});
test('manual lyrics browsing stops auto-follow and follow scrolls only the lyrics box',async t=>{
 const ui=await fixture(t);const box=ui.host.querySelector('.lyrics-lines'),calls=[];Object.defineProperty(box,'clientHeight',{value:100});box.getBoundingClientRect=()=>({top:100});box.scrollTo=options=>calls.push(options);for(const row of box.children)row.getBoundingClientRect=()=>({top:240,height:40});
 box.dispatchEvent(new window.Event('wheel'));await settle();ui.props.elapsed=8;await settle();assert.equal(calls.length,0);assert.ok(ui.button('跟随歌词'));ui.button('跟随歌词').click();await settle();assert.equal(calls.length,1);assert.equal(calls[0].top,110);assert.equal(ui.button('跟随歌词'),undefined);
});
test('empty lyrics and literal text render safely without HTML injection',async t=>{
 const empty=await fixture(t,{loadLyrics:async id=>({songId:id,lines:[]})});assert.match(empty.host.textContent,/暂无歌词/);const literal=await fixture(t,{loadLyrics:async id=>({songId:id,lines:[{time:0,text:'<img src=x onerror=alert(1)>'}]})});assert.equal(literal.host.querySelector('img'),null);assert.match(literal.host.textContent,/<img/);
});
test('phone lyrics start collapsed and fetch only when expanded',async t=>{
 const before=window.matchMedia;window.matchMedia=query=>({matches:query.includes('max-width')});t.after(()=>{window.matchMedia=before;});const ui=await fixture(t);assert.equal(ui.calls.length,0);ui.button('展开').click();await settle();assert.deepEqual(ui.calls,['1']);
});

test('local playback ticks advance lyrics without another request and pause freezes interpolation',async t=>{
 t.mock.timers.enable({apis:['setInterval','Date'],now:100000});const ui=await fixture(t,{elapsed:4.2,playing:true});assert.match(ui.host.querySelector('.active').textContent,/First/);
 t.mock.timers.tick(1000);await settle();assert.equal(ui.host.querySelector('.active').textContent,'Second');assert.equal(ui.calls.length,1);
 ui.props.elapsed=4.2;ui.props.playing=false;await settle();t.mock.timers.tick(5000);await settle();assert.match(ui.host.querySelector('.active').textContent,/First/);assert.equal(ui.calls.length,1);
});
