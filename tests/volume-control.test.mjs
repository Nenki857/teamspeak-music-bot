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
const {descriptor}=parse(readFileSync(resolve('src/renderer/VolumeControl.vue'),'utf8'));
const compiled=compileScript(descriptor,{id:'volume-regression',inlineTemplate:true});
const output=resolve('work/volume-tests/Component.mjs');mkdirSync(resolve('work/volume-tests'),{recursive:true});writeFileSync(output,compiled.content);
const {default:Component}=await import(pathToFileURL(output).href);
const settle=async()=>{for(let i=0;i<4;i++){await Promise.resolve();await nextTick();}};
async function fixture(t,options={}){
 const calls=[],props=reactive({volume:50,disabled:false,...options,setVolume:async value=>{calls.push(value);if(options.setVolume)await options.setVolume(value);props.volume=value;}});
 const host=document.createElement('div');document.body.append(host);const app=createApp({render:()=>h(Component,props)});app.mount(host);await settle();t.after(()=>{app.unmount();host.remove();});
 const button=()=>host.querySelector('.volume-value'),field=()=>host.querySelector('[aria-label="输入音量百分比"]');
 const open=async()=>{button().click();await settle();return field();};
 const input=value=>{field().value=value;field().dispatchEvent(new window.Event('input',{bubbles:true}));};
 const key=value=>field().dispatchEvent(new window.KeyboardEvent('keydown',{key:value,bubbles:true,cancelable:true}));
 return {host,calls,props,button,field,open,input,key};
}
test('numeric volume submits once on Enter despite blur and shows the pending target until acknowledgement',async t=>{
 let release;const wait=new Promise(r=>release=r);const ui=await fixture(t,{setVolume:()=>wait});const field=await ui.open();assert.equal(document.activeElement,field);assert.equal(field.selectionStart,0);assert.equal(field.selectionEnd,2);
 ui.input('73');ui.key('Enter');field.dispatchEvent(new window.Event('blur'));await settle();assert.deepEqual(ui.calls,[73]);assert.equal(ui.button().textContent,'73%');assert.equal(ui.button().disabled,true);release();await settle();assert.equal(ui.button().disabled,false);assert.equal(ui.button().textContent,'73%');assert.equal(document.activeElement,ui.button());
});
test('incoming status does not overwrite an unfinished volume edit; blur confirms and clamps the value',async t=>{
 const ui=await fixture(t);await ui.open();ui.input('135');ui.props.volume=12;await settle();assert.equal(ui.field().value,'135');assert.deepEqual(ui.calls,[]);ui.field().dispatchEvent(new window.Event('blur'));await settle();assert.deepEqual(ui.calls,[100]);assert.equal(ui.button().textContent,'100%');
 await ui.open();ui.input('-5');ui.key('Enter');await settle();assert.deepEqual(ui.calls,[100,0]);assert.equal(ui.host.querySelector('svg').getAttribute('aria-label'),'静音');
});
test('Escape, invalid or empty input and unchanged values do not send requests',async t=>{
 const ui=await fixture(t);await ui.open();ui.input('82');ui.key('Escape');await settle();assert.equal(ui.button().textContent,'50%');
 for(const text of ['','abc','50']){await ui.open();ui.input(text);ui.key('Enter');await settle();assert.equal(ui.field(),null);}
 assert.deepEqual(ui.calls,[]);
});
test('a failed request restores confirmed volume and leaves an accessible error',async t=>{
 const ui=await fixture(t,{setVolume:async()=>{throw Error('offline');}});await ui.open();ui.input('80');ui.key('Enter');await settle();assert.equal(ui.button().textContent,'50%');assert.equal(ui.button().disabled,false);assert.match(ui.host.querySelector('[role="alert"]').textContent,/调整失败/);
});
test('disabled controls cannot edit or submit and revoking permission cancels an unfinished edit',async t=>{
 const ui=await fixture(t,{disabled:true});ui.button().click();await settle();assert.equal(ui.field(),null);assert.equal(ui.host.querySelector('[type="range"]').disabled,true);
 ui.props.disabled=false;await settle();await ui.open();ui.input('70');ui.props.disabled=true;await settle();assert.equal(ui.field(),null);assert.deepEqual(ui.calls,[]);
});
test('the slider still submits one change rather than every input event',async t=>{
 const ui=await fixture(t);const slider=ui.host.querySelector('[type="range"]');slider.value='65';slider.dispatchEvent(new window.Event('input',{bubbles:true}));await settle();assert.deepEqual(ui.calls,[]);slider.dispatchEvent(new window.Event('change',{bubbles:true}));await settle();assert.deepEqual(ui.calls,[65]);
});
