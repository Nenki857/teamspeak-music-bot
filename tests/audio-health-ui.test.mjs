import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parse, compileScript } from '@vue/compiler-sfc';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
for (const name of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'SVGElement', 'Node']) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
const { createApp, nextTick, reactive, h } = await import('vue');
const output = resolve('work/audio-health-ui-tests/AudioHealthPanel.mjs'); mkdirSync(resolve('work/audio-health-ui-tests'), { recursive: true });
const { descriptor } = parse(readFileSync(resolve('src/renderer/AudioHealthPanel.vue'), 'utf8'));
writeFileSync(output, compileScript(descriptor, { id: 'audio-health-ui', inlineTemplate: true }).content);
const { default: Panel } = await import(pathToFileURL(output).href);
const settle = async () => { await Promise.resolve(); await nextTick(); await Promise.resolve(); };

test('diagnostic UI distinguishes UDP errors, missing RTT and allowlists copied transport fields', async t => {
  const reports = []; window.musicBot = { async copy(value) { reports.push(JSON.parse(value)); return true; } };
  const health = reactive({ supported: true, frames: 100, isolatedCore: true, directCatalog: true,
    encoding: { codec: 'opus-music', sampleRate: 48000, channels: 2, frameDurationMs: 20, bitrate: 79200, variableBitrate: false, cookie: 'secret' },
    transport: { supported: true, voicePackets: 100, sendErrors: 0, sendCallbacks: 100, maxSendCallbackMs: 3, pendingVoiceSends: 0, rttMs: null, maxRttMs: null,
      serverAddress: 'private.invalid', cookie: 'secret', lastErrorCode: 'do-not-forward', deliveryVerified: true } });
  const box = document.createElement('div'); document.body.append(box); const app = createApp({ setup: () => () => h(Panel, { health }) }); app.mount(box);
  t.after(() => { app.unmount(); box.remove(); });
  assert.match(box.textContent, /保活往返 —/); assert.match(box.textContent, /不能当作语音丢包率/);
  assert.match(box.textContent, /79.2 kbps/); assert.match(box.textContent, /固定码率/);
  health.transport.sendErrors = 1; health.transport.lastErrorCode = 'ENOBUFS'; await settle(); assert.match(box.querySelector('.audio-health-result').textContent, /UDP 发送错误/);
  box.querySelector('button').click(); await settle();
  assert.equal(reports[0].transport.lastErrorCode, 'ENOBUFS'); assert.equal(reports[0].transport.rttMs, null); assert.equal(reports[0].transport.deliveryVerified, false);
  assert.equal(reports[0].directCatalog, true); assert.ok(!/secret|private.invalid|serverAddress|cookie/.test(JSON.stringify(reports[0])));
  assert.equal(reports[0].encoding.bitrate, 79200); assert.equal(reports[0].encoding.variableBitrate, false);
  delete health.transport; await settle(); box.querySelector('button').click(); await settle(); assert.equal(reports[1].transport.supported, false); assert.equal(reports[1].transport.rttMs, null);
});
test('official client diagnostics remain copyable without fabricating old encoder or buffer statistics',async t=>{
  const reports=[];window.musicBot={copy:async value=>{reports.push(JSON.parse(value));return true;}};
  const box=document.createElement('div');document.body.append(box);const app=createApp({setup:()=>()=>h(Panel,{health:{supported:false,officialClient:true,state:'playing',backend:'official-client-sinusbot',note:'secret URL must not be copied'}})});app.mount(box);t.after(()=>{app.unmount();box.remove();});
  assert.equal(box.querySelector('button').disabled,false);assert.equal(box.querySelector('.audio-health-grid'),null);assert.ok(!box.textContent.includes('20 ms'));box.querySelector('button').click();await settle();assert.equal(reports[0].officialClient,true);assert.equal(reports[0].backend,'official-client-sinusbot');assert.equal(reports[0].frames,null);assert.ok(!JSON.stringify(reports[0]).includes('secret'));
});
