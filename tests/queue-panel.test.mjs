import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parse, compileScript } from '@vue/compiler-sfc';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const name of ['window', 'document', 'navigator', 'Element', 'HTMLElement', 'SVGElement', 'Node', 'Event']) Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true });
const { createApp, nextTick } = await import('vue');
const { descriptor } = parse(readFileSync(resolve('src/renderer/ResizableQueuePanel.vue'), 'utf8'));
const compiled = compileScript(descriptor, { id: 'queue-panel-regression', inlineTemplate: true });
const output = resolve('work/queue-panel-tests/Component.mjs'); mkdirSync(resolve('work/queue-panel-tests'), { recursive: true }); writeFileSync(output, compiled.content.replace("'../shared/queue-focus.mjs'",JSON.stringify(pathToFileURL(resolve('src/shared/queue-focus.mjs')).href)));
const { default: Component } = await import(pathToFileURL(output).href);
const storageKey = 'tsmd.queue-width.v1';
const settle = async () => { await nextTick(); await nextTick(); };
async function fixture(t, { desktop = true, stored = null, innerWidth = 1320, available = 1080 } = {}) {
  window.localStorage.clear(); if (stored !== null) window.localStorage.setItem(storageKey, stored);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
  let workspaceWidth = available;
  const host = document.createElement('div'); host.className = 'workspace'; host.style.cssText = 'padding: 30px; column-gap: 28px';
  Object.defineProperty(host, 'clientWidth', { get: () => workspaceWidth }); document.body.append(host);
  const app = createApp(Component, { desktop }); app.mount(host); await settle();
  const panel = host.querySelector('.queue-panel');
  panel.getBoundingClientRect = () => ({ width: parseFloat(panel.style.width) || (desktop ? 280 : 210) });
  window.dispatchEvent(new window.Event('resize')); await settle();
  const pointer = (target, type, values = {}) => { const event = new window.Event(type, { bubbles: true, cancelable: true }); Object.assign(event, { pointerId: 1, button: 0, isPrimary: true, clientX: 900, ...values }); target.dispatchEvent(event); };
  const key = value => host.querySelector('.queue-resize-handle').dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
  const resize = async (viewport, width) => { Object.defineProperty(window, 'innerWidth', { configurable: true, value: viewport }); workspaceWidth = width; window.dispatchEvent(new window.Event('resize')); await settle(); };
  let mounted = true; const unmount = () => { if (mounted) { app.unmount(); host.remove(); mounted = false; } };
  t.after(() => { unmount(); window.localStorage.clear(); });
  return { host, panel, pointer, key, resize, unmount, width: () => panel.getBoundingClientRect().width, handle: () => host.querySelector('.queue-resize-handle') };
}

test('dragging left enlarges the queue, persists the width and retains it across a smaller window', async t => {
  const ui = await fixture(t);
  ui.pointer(ui.handle(), 'pointerdown'); ui.pointer(window, 'pointermove', { clientX: 740 }); await settle();
  assert.equal(ui.width(), 440); assert.ok(document.documentElement.classList.contains('queue-resizing'));
  ui.pointer(window, 'pointerup'); await settle(); assert.equal(window.localStorage.getItem(storageKey), '440');
  assert.equal(document.documentElement.classList.contains('queue-resizing'), false);
  await ui.resize(1040, 835); assert.ok(ui.width() < 440); assert.equal(window.localStorage.getItem(storageKey), '440');
  await ui.resize(1320, 1080); assert.equal(ui.width(), 440);
  ui.pointer(ui.handle(), 'pointerdown'); ui.pointer(window, 'pointermove', { clientX: 1500 }); ui.pointer(window, 'pointerup'); await settle();
  assert.equal(ui.width(), Number(ui.handle().getAttribute('aria-valuemin')));
});

test('keyboard limits and reset work, unrelated pointers are ignored, and unmount clears dragging', async t => {
  const ui = await fixture(t, { stored: '440' }); assert.equal(ui.width(), 440);
  ui.key('ArrowLeft'); await settle(); assert.equal(ui.width(), 460);
  ui.key('ArrowRight'); await settle(); assert.equal(ui.width(), 440);
  ui.key('End'); await settle(); assert.equal(ui.width(), Number(ui.handle().getAttribute('aria-valuemax')));
  ui.key('Home'); await settle(); assert.equal(ui.width(), Number(ui.handle().getAttribute('aria-valuemin')));
  ui.handle().dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true })); await settle();
  assert.equal(ui.width(), 280); assert.equal(window.localStorage.getItem(storageKey), null);
  assert.equal(ui.handle().getAttribute('aria-valuenow'), '280');
  ui.pointer(ui.handle(), 'pointerdown', { button: 2 }); assert.equal(document.documentElement.classList.contains('queue-resizing'), false);
  ui.pointer(ui.handle(), 'pointerdown'); ui.pointer(window, 'pointermove', { clientX: 800, pointerId: 2 }); await settle(); assert.equal(ui.width(), 280);
  ui.unmount(); assert.equal(document.documentElement.classList.contains('queue-resizing'), false);
  ui.pointer(window, 'pointermove', { clientX: 100 }); assert.equal(window.localStorage.getItem(storageKey), null);
});

test('phone layouts retain the full width and desktop preferences survive temporary phone layout', async t => {
  const ui = await fixture(t, { desktop: false, stored: '440', innerWidth: 390, available: 390 });
  assert.equal(ui.handle(), null); assert.equal(ui.panel.style.width, '');
  await ui.resize(900, 900); assert.ok(ui.handle()); assert.equal(ui.width(), 440);
  await ui.resize(390, 390); assert.equal(ui.handle(), null); assert.equal(ui.panel.style.width, ''); assert.equal(window.localStorage.getItem(storageKey), '440');
});
