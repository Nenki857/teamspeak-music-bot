import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parse, compileScript } from '@vue/compiler-sfc';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'SVGElement', 'Node']) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
const { createApp, nextTick } = await import('vue');
const output = resolve('work/resource-ui-tests/ResourceMonitor.mjs'); mkdirSync(resolve('work/resource-ui-tests'), { recursive: true });
const { descriptor } = parse(readFileSync(resolve('src/renderer/ResourceMonitor.vue'), 'utf8'));
writeFileSync(output, compileScript(descriptor, { id: 'resource-ui', inlineTemplate: true }).content);
const { default: ResourceMonitor } = await import(pathToFileURL(output).href);
const settle = async () => { for (let i = 0; i < 4; i++) { await Promise.resolve(); await nextTick(); } };
const sample = () => ({ cpu: { percent: 2.4, status: 'ok', processes: 5 }, memory: { bytes: 384 * 1024 * 1024, status: 'ok' }, network: { receivedPerSecond: 96 * 1024, sentPerSecond: 14.5 * 1024, status: 'ok', scope: 'system-physical' } });

test('sidebar resources refresh once per second, explain network scope and stop while hidden or unmounted', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0;
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  window.musicBot = { async resources() { calls++; return sample(); } };
  const container = document.createElement('div'); document.body.append(container); const app = createApp(ResourceMonitor); app.mount(container); await settle();
  t.after(() => container.remove());
  assert.equal(container.querySelector('[data-metric=cpu]').textContent, '2.4%');
  assert.equal(container.querySelector('[data-metric=memory]').textContent, '384 MiB');
  assert.equal(container.querySelector('[data-metric=receive]').textContent, '96.0 KiB/s');
  assert.match(container.textContent, /本机总流量/); assert.match(container.querySelector('.resource-network').title, /包含其他软件/);
  t.mock.timers.tick(1000); await settle(); assert.equal(calls, 2);
  Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new window.Event('visibilitychange'));
  t.mock.timers.tick(10000); await settle(); assert.equal(calls, 2);
  Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new window.Event('visibilitychange')); await settle(); assert.equal(calls, 3);
  app.unmount(); t.mock.timers.tick(5000); await settle(); assert.equal(calls, 3);
});

test('unavailable resource data clears old values, never overlaps requests, and recovers after a failure', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let reject; let calls = 0;
  Object.defineProperty(document, 'hidden', { value: false, configurable: true });
  window.musicBot = { resources() { calls++; return calls === 1 ? new Promise((_resolve, fail) => { reject = fail; }) : Promise.resolve(sample()); } };
  const container = document.createElement('div'); document.body.append(container); const app = createApp(ResourceMonitor); app.mount(container);
  t.after(() => { app.unmount(); container.remove(); });
  t.mock.timers.tick(5000); await settle(); assert.equal(calls, 1);
  reject(new Error('Denied')); await settle(); assert.match(container.textContent, /读取受限/); assert.equal(container.querySelector('[data-metric=cpu]').textContent, '—');
  t.mock.timers.tick(1000); await settle(); assert.equal(calls, 2); assert.equal(container.querySelector('[data-metric=cpu]').textContent, '2.4%');
});

test('server sidebar shows aggregate load and memory totals, shares a two-second refresh and pauses when hidden',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});Object.defineProperty(document,'hidden',{value:false,configurable:true});window.musicBot=undefined;let calls=0;
 const container=document.createElement('div');document.body.append(container);const app=createApp(ResourceMonitor,{server:true,loadSample:async()=>{calls++;return{...sample(),memory:{bytes:512*1024**2,totalBytes:2*1024**3,percent:25,status:'ok'},cpu:{percent:20,status:'ok',cores:2},load:{one:.12,five:.25,fifteen:.5,status:'ok'}};}});app.mount(container);await settle();t.after(()=>{app.unmount();container.remove();});
 assert.match(container.textContent,/服务器负载/);assert.match(container.textContent,/2.0 GiB 总计 · 25%/);assert.equal(container.querySelector('[data-metric=load]').textContent,'0.12 / 0.25 / 0.50');assert.match(container.querySelector('.resource-compute>div').title,/整台服务器/);t.mock.timers.tick(1000);await settle();assert.equal(calls,1);t.mock.timers.tick(1000);await settle();assert.equal(calls,2);
 Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new window.Event('visibilitychange'));t.mock.timers.tick(20000);await settle();assert.equal(calls,2);
});
