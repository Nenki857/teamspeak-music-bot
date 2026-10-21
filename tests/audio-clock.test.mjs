import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioClock } from '../src/worker/audio-clock.mjs';
import { CoreEngine } from '../src/worker/core-engine.mjs';
import { AudioPlayer } from '../vendor/teamspeak-music-bot-1.13.2/dist/audio/player.js';

test('Windows audio timer requests are balanced across playback, pause, resume, and shutdown', () => {
  const calls = [];
  const clock = createAudioClock({ platform: 'win32', loadApi: () => ({ begin: value => { calls.push(['begin', value]); return 0; }, end: value => { calls.push(['end', value]); return 0; } }) });
  clock.setActive(true); clock.setActive(true); assert.equal(clock.active, true);
  clock.setActive(false); clock.setActive(false); clock.setActive(true); clock.close(); clock.close();
  assert.equal(clock.active, false);
  assert.deepEqual(calls, [['begin', 1], ['end', 1], ['begin', 1], ['end', 1]]);
});

test('unsupported or unavailable audio timer never breaks playback or repeats warnings', () => {
  let loads = 0; let warnings = 0; let ends = 0;
  const failed = createAudioClock({ platform: 'win32', loadApi: () => { loads++; return { begin: () => 97, end: () => { ends++; } }; }, onError: () => { warnings++; } });
  failed.setActive(true); failed.setActive(true); failed.close();
  assert.equal(failed.active, false); assert.equal(loads, 1); assert.equal(warnings, 1); assert.equal(ends, 0);
  const other = createAudioClock({ platform: 'linux', loadApi: () => { throw new Error('must not load Windows API'); } });
  other.setActive(true); other.close(); assert.equal(other.active, false);
});

test('core releases fine-grained timing on pause, stop and close', () => {
  const core = new CoreEngine({}, {}, () => {}, () => {}); const calls = [];
  core.audioClock = { setActive: active => calls.push(active), close: () => calls.push('close') };
  let state = 'playing';
  const bot = { getPlayer: () => ({ getState: () => state }), getQueueManager: () => ({ current: () => null }), getStatus: () => ({ currentSong: null }), getQueue: () => [], getConnectionInfo: () => ({}) };
  core.bot = () => bot; core.manager = { stopBot() {}, shutdown() {} }; core.activeId = 'bot';
  core.status(); state = 'paused'; core.status(); core.stop(); core.close();
  assert.deepEqual(calls, [true, false, false, 'close']);
});

test('a late frame never triggers backlog bursts; pause only drains silence and stale callbacks emit nothing', () => {
  const originalTimer = globalThis.setTimeout; const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  let now = 0; const pending = []; let frames = 0;
  const player = new AudioPlayer({ info() {}, debug() {}, warn() {}, error() {} });
  try {
    Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => now } });
    globalThis.setTimeout = (callback, delay) => { const timer = { callback, delay }; pending.push(timer); return timer; };
    player.state = 'playing'; player.ffmpeg = { stdout: { resume() {} } }; player.pcmBuffer = Buffer.alloc(3840 * 20);
    player.on('frame', () => { frames++; }); player.startFrameLoop();
    assert.equal(pending[0].delay, 20); now = 20; pending.shift().callback(); assert.equal(frames, 1);
    now = 220; pending.shift().callback(); assert.equal(frames, 2);
    assert.equal(pending.length, 1); assert.equal(pending[0].delay, 20, 'a 200ms stall schedules the next frame in the future rather than replaying overdue timers');
    const elapsed = player.getElapsed(); const remaining = player.pcmBuffer;
    player.pause();
    for (let i = 0; i < 5; i++) { now = 240 + i * 20; pending.shift().callback(); assert.equal(frames, 3 + i); }
    assert.equal(player.getElapsed(), elapsed); assert.equal(player.pcmBuffer, remaining);
    now = 340; pending.shift().callback(); assert.equal(frames, 7, 'paused playback sends no further frames after its finite tail');
    player.resume(); const stale = pending.shift(); player.stop(); now = 360; stale.callback();
    assert.equal(frames, 7); assert.equal(pending.length, 0);
  } finally {
    player.stop(); globalThis.setTimeout = originalTimer;
    Object.defineProperty(globalThis, 'performance', originalPerformance);
  }
});
