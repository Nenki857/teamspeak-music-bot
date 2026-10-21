import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parse, compileScript } from '@vue/compiler-sfc';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
for (const name of ['window','document','navigator','Element','HTMLElement','SVGElement','Node']) Object.defineProperty(globalThis,name,{value:dom.window[name],configurable:true});
const { createApp, nextTick } = await import('vue');
const output=resolve('work/admin-actions-ui-tests/Panel.mjs');mkdirSync(resolve('work/admin-actions-ui-tests'),{recursive:true});
const {descriptor}=parse(readFileSync('src/renderer/AdminActionsPanel.vue','utf8'));
writeFileSync(output,compileScript(descriptor,{id:'admin-actions-ui',inlineTemplate:true}).content);
const {default:Panel}=await import(pathToFileURL(output).href);
const settle=async()=>{await Promise.resolve();await nextTick();await Promise.resolve();await nextTick();};
const button=(box,name)=>[...box.querySelectorAll('button')].find(item=>item.textContent.trim().startsWith(name));
function mount(t,props){const box=document.createElement('div');document.body.append(box);const app=createApp(Panel,props);app.mount(box);t.after(()=>{app.unmount();box.remove();});return box;}

test('management actions distinguish sessions and accounts and require confirmation before stopping or restarting',async t=>{
  const calls=[];const box=mount(t,{loggedIn:true,running:true,canRestart:true,run:async kind=>{calls.push(kind);}});
  assert.equal(box.querySelectorAll('button').length,4);
  button(box,'关闭机器人').click();await settle();assert.deepEqual(calls,[]);assert.match(box.textContent,/管理网页继续运行/);
  button(box,'返回').click();await settle();button(box,'重启机器人').click();await settle();assert.deepEqual(calls,[]);
  button(box,'确认重启机器人').click();await settle();assert.deepEqual(calls,['restart']);
});
test('unavailable account or bot actions are disabled and owner logout is independent',async t=>{
  const calls=[];const box=mount(t,{loggedIn:false,running:false,canRestart:false,run:async kind=>calls.push(kind)});
  for(const name of ['退出网易云登录','关闭机器人','重启机器人'])assert.equal(button(box,name).disabled,true);
  button(box,'退出管理端登录').click();await settle();assert.deepEqual(calls,['owner']);
});
test('confirmed operations reject repeat clicks and show failures without closing the menu',async t=>{
  let reject;let calls=0;let closed=0;
  const box=mount(t,{loggedIn:true,running:true,canRestart:true,run:()=>{calls++;return new Promise((_,no)=>{reject=no;});},onDone:()=>closed++});
  button(box,'退出网易云登录').click();await settle();button(box,'确认退出网易云登录').click();await settle();
  assert.equal(box.querySelectorAll('button:disabled').length,2);box.querySelector('button:last-of-type').click();assert.equal(calls,1);
  reject(new Error('合成失败'));await settle();assert.equal(closed,0);assert.equal(box.querySelector('[role=alert]').textContent,'合成失败');assert.equal(button(box,'确认退出网易云登录').disabled,false);
});
