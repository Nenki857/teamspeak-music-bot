import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fitWindowState, loadWindowState, rememberWindowState } from '../src/desktop/window-state.mjs';

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const initial = () => fitWindowState(null, [primary], primary);
class TestWindow extends EventEmitter {
  bounds = { ...initial().bounds }; maximized = false; minimized = false; destroyed = false;
  isDestroyed() { return this.destroyed; }
  isMaximized() { return this.maximized; }
  isMinimized() { return this.minimized; }
  getNormalBounds() { assert.equal(this.destroyed, false); return { ...this.bounds }; }
  getBounds() { throw new Error('Maximized bounds must not replace the normal window size'); }
}
function fixture(t) {
  const parent = resolve('work/window-state-tests'); const directory = resolve(parent, randomUUID()); mkdirSync(directory, { recursive: true });
  const file = resolve(directory, 'window-state.json'); const window = new TestWindow();
  const tracker = rememberWindowState(window, file, initial());
  t.after(() => { tracker.dispose(); assert.equal(dirname(directory), parent); rmSync(directory, { recursive: true, force: true }); });
  return { file, window, tracker };
}
const read = file => JSON.parse(readFileSync(file, 'utf8'));

test('closing to tray flushes a recent resize and position, and a new run restores them', t => {
  const { window, file, tracker } = fixture(t);
  window.bounds = { x: 120, y: 80, width: 1450, height: 900 }; window.emit('resize'); window.emit('move');
  assert.equal(existsSync(file), false, 'dragging is debounced');
  window.emit('close', { preventDefault() {} });
  assert.deepEqual(loadWindowState(file, [primary], primary), { bounds: window.bounds, minWidth: 1040, minHeight: 700, maximized: false });
  assert.equal(existsSync(file + '.tmp'), false);
  window.bounds = { x: 200, y: 100, width: 1300, height: 820 }; assert.equal(tracker.save(), true, 'before-quit can save synchronously');
  assert.deepEqual(read(file).bounds, window.bounds);
});

test('maximized and minimized exits retain normal bounds and maximize preference independently', t => {
  const { window, file, tracker } = fixture(t);
  const normal = { x: 70, y: 50, width: 1400, height: 850 }; window.bounds = normal; window.emit('resize');
  window.maximized = true; window.emit('maximize'); tracker.save();
  assert.deepEqual(read(file), { version: 1, bounds: normal, maximized: true });
  window.minimized = true; window.maximized = false; window.bounds = { x: -32000, y: -32000, width: 160, height: 28 }; window.emit('resize'); window.emit('close');
  assert.deepEqual(read(file), { version: 1, bounds: normal, maximized: true }, 'minimized coordinates must not replace the last usable state');
  window.minimized = false; window.bounds = normal; window.emit('restore'); window.emit('unmaximize'); tracker.save();
  assert.deepEqual(loadWindowState(file, [primary], primary).bounds, normal); assert.equal(read(file).maximized, false);
});

test('restoring handles secondary monitors, removed monitors and reduced work areas', () => {
  const left = { x: -1600, y: 0, width: 1600, height: 900 };
  const saved = { version: 1, bounds: { x: -1550, y: 35, width: 1400, height: 800 }, maximized: true };
  assert.deepEqual(fitWindowState(saved, [left, primary], primary).bounds, saved.bounds, 'negative coordinates are valid on a left-hand monitor');
  assert.deepEqual(fitWindowState(saved, [primary], primary).bounds, { x: 260, y: 120, width: 1400, height: 800 }, 'an unplugged monitor falls back to the primary screen');
  const smaller = { x: 0, y: 40, width: 1366, height: 728 };
  const resized = fitWindowState({ ...saved, bounds: { x: 1200, y: -100, width: 1800, height: 1000 } }, [smaller], smaller);
  assert.deepEqual(resized.bounds, smaller, 'screen and taskbar changes keep the whole restored window visible');
  assert.equal(resized.maximized, true);
});

test('missing or corrupt settings use safe defaults; a small screen lowers the minimum size', t => {
  const { file } = fixture(t);
  const expected = { bounds: { x: 300, y: 80, width: 1320, height: 880 }, minWidth: 1040, minHeight: 700, maximized: false };
  assert.deepEqual(loadWindowState(file, [primary], primary), expected);
  for (const bad of ['{broken', 'null', '{"version":2,"bounds":{"x":0,"y":0,"width":1200,"height":800}}', '{"version":1,"bounds":{"x":0,"y":0,"width":-1,"height":800},"maximized":true}']) {
    writeFileSync(file, bad); assert.deepEqual(loadWindowState(file, [primary], primary), expected);
  }
  const small = { x: 0, y: 24, width: 960, height: 576 };
  assert.deepEqual(fitWindowState(null, [small], small), { bounds: small, minWidth: 960, minHeight: 576, maximized: false });
  const tiny = { version: 1, bounds: { x: 10, y: 20, width: 100, height: 80 } };
  assert.deepEqual(fitWindowState(tiny, [primary], primary).bounds, { x: 10, y: 20, width: 1040, height: 700 });
});

test('move bursts persist only the final state and shutdown events flush pending work', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { file, window } = fixture(t);
  window.bounds = { x: 50, y: 40, width: 1500, height: 900 }; window.emit('resize'); t.mock.timers.tick(200);
  window.bounds = { x: 100, y: 60, width: 1500, height: 900 }; window.emit('move'); t.mock.timers.tick(249);
  assert.equal(existsSync(file), false); t.mock.timers.tick(1); assert.deepEqual(read(file).bounds, window.bounds);
  window.bounds = { x: 150, y: 80, width: 1500, height: 900 }; window.emit('move'); window.emit('query-session-end');
  assert.deepEqual(read(file).bounds, window.bounds);
  window.destroyed = true; window.emit('closed'); window.emit('move'); t.mock.timers.tick(1000);
  assert.deepEqual(read(file).bounds, window.bounds);
});

test('a preference write failure never blocks exit and can be retried without leaving a partial file', t => {
  const { file, window, tracker } = fixture(t); tracker.dispose();
  mkdirSync(file); let errors = 0;
  const failing = rememberWindowState(window, file, initial(), () => errors++); t.after(() => failing.dispose());
  assert.doesNotThrow(() => window.emit('close')); assert.equal(errors, 1); assert.equal(existsSync(file + '.tmp'), false);
  rmdirSync(file); assert.equal(failing.save(), true); assert.deepEqual(loadWindowState(file, [primary], primary), initial());
});
