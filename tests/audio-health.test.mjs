import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAudioHealth } from '../src/worker/audio-health.mjs';

function fixture() {
  let at = 0;
  const health = createAudioHealth({ now: () => at, wallNow: () => 100000 + at });
  const player = Object.assign(new EventEmitter(), { state: 'playing', sessionId: 1, pcmBuffer: Buffer.alloc(0), ffmpeg: {}, currentSongDuration: 200,
    getState() { return this.state; }, getElapsed() { return 10; },
    sendNextFrame(value = 7) {
      if (this.throwError) throw this.throwError;
      if (this.pcmBuffer.length >= 3840) { this.pcmBuffer = this.pcmBuffer.subarray(3840); this.emit('frame', Buffer.alloc(1)); }
      return value;
    } });
  const original = player.sendNextFrame; health.setPlayer(player);
  return { health, player, original, at(value) { at = value; }, fill(frames = 50) { player.pcmBuffer = Buffer.alloc(3840 * frames); }, snapshot: () => health.snapshot(player) };
}

test('audio diagnostics detect scheduler delays with buffered data and preserve the original frame method behavior', () => {
  const f = fixture();
  f.player.sendNextFrame(); assert.equal(f.snapshot().underruns, 0, 'startup is not an underrun');
  f.fill(); f.at(20); assert.equal(f.player.sendNextFrame(99), 99);
  f.at(40); f.player.sendNextFrame(); f.at(110); f.player.sendNextFrame();
  const state = f.snapshot(); assert.equal(state.frames, 3); assert.equal(state.lateTicks, 1); assert.equal(state.underruns, 0);
  assert.equal(state.maxFrameGapMs, 70); assert.equal(state.recent[0].type, 'scheduler-gap'); assert.ok(state.recent[0].bufferMs > 0);
  assert.equal(state.tsConnectionStatistics, 'unsupported'); assert.equal(state.deliveryVerified, false);
  const error = new Error('encoder failure'); f.player.throwError = error; assert.throws(() => f.player.sendNextFrame(), value => value === error);
  f.health.close(); assert.equal(f.player.sendNextFrame, f.original); assert.equal(f.player.listenerCount('frame'), 0);
});

test('audio supply gaps are distinguished from regular scheduler ticks and contiguous empty ticks count as one episode', () => {
  const f = fixture(); f.fill(1); f.at(20); f.player.sendNextFrame();
  for (const at of [40, 60, 80]) { f.at(at); f.player.sendNextFrame(); }
  let state = f.snapshot(); assert.equal(state.underruns, 1); assert.equal(state.lateTicks, 0); assert.equal(state.starving, true); assert.equal(state.maxFrameGapMs, 60);
  f.fill(1); f.at(100); f.player.sendNextFrame();
  state = f.snapshot(); assert.equal(state.starving, false); assert.equal(state.maxFrameGapMs, 80);
  f.at(120); f.player.sendNextFrame(); assert.equal(f.snapshot().underruns, 2);
  f.health.close();
});

test('pause, seek, player switches and ordinary EOF do not create false starvation or long-gap reports', () => {
  const f = fixture(); f.fill(10); f.at(20); f.player.sendNextFrame();
  f.player.state = 'paused'; f.snapshot(); f.at(10000); f.player.state = 'playing'; f.player.sendNextFrame();
  assert.equal(f.snapshot().lateTicks, 0); assert.equal(f.snapshot().maxFrameGapMs, 0);
  f.player.sessionId++; f.at(20000); f.player.sendNextFrame(); assert.equal(f.snapshot().lateTicks, 0);
  f.player.pcmBuffer = Buffer.alloc(0); f.player.ffmpeg = null; f.at(20020); f.player.sendNextFrame(); assert.equal(f.snapshot().underruns, 0);
  f.player.ffmpeg = {}; f.player.currentSongDuration = 10; f.at(20040); f.player.sendNextFrame(); assert.equal(f.snapshot().underruns, 0);
  f.health.setPlayer(); assert.equal(f.player.sendNextFrame, f.original); assert.equal(f.player.listenerCount('frame'), 0);
  f.health.close();
});

test('audio history is bounded, expires after a minute and never includes stream or song data', () => {
  const f = fixture(); f.player.currentUrl = 'https://private.invalid/?token=secret';
  f.fill(1000); f.player.sendNextFrame();
  for (let i = 1; i < 200; i++) { f.at(i * 70); f.player.sendNextFrame(); }
  const value = f.snapshot(); assert.equal(value.recent.length, 8); assert.ok(JSON.stringify(value).length < 3000);
  assert.ok(!JSON.stringify(value).includes('secret')); assert.ok(!JSON.stringify(value).includes('https:'));
  f.at(80000); f.player.state = 'idle';
  assert.equal(f.snapshot().frames, 0); assert.deepEqual(f.snapshot().recent, []); f.health.close();
});

test('audio work counters separate encoding and voice submission and restore both methods', () => {
  let at = 0; const health = createAudioHealth({ now: () => at });
  const encoder = { encode(value) { at += 12; return value; } }; const voice = { sendVoiceData(value) { at += 9; return value; } };
  const originalEncode = encoder.encode; const originalVoice = voice.sendVoiceData;
  const player = Object.assign(new EventEmitter(), { encoder, state: 'playing', sessionId: 1, pcmBuffer: Buffer.alloc(38400),
    getState() { return this.state; }, getElapsed() { return 0; }, sendNextFrame() { const value = this.encoder.encode(7); voice.sendVoiceData(value); this.emit('frame', value); return value; } });
  health.setPlayer(player, voice); assert.equal(player.sendNextFrame(), 7);
  assert.deepEqual(health.snapshot(player).audioWork, { maxFrameWorkMs: 21, maxEncodeMs: 12, maxVoiceSubmitMs: 9, slowFrameCalls: 1 });
  health.close(); assert.equal(encoder.encode, originalEncode); assert.equal(voice.sendVoiceData, originalVoice);
});

test('diagnostics include actual encoder settings and tolerate unavailable encoder metadata', () => {
  const f = fixture(); const settings = { codec: 'opus-music', sampleRate: 48000, channels: 2, frameDurationMs: 20, bitrate: 79200, variableBitrate: false };
  f.player.encoder = { getSettings: () => settings };
  assert.deepEqual(f.snapshot().encoding, settings);
  f.player.encoder.getSettings = () => { throw new Error('unavailable'); };
  assert.equal(f.snapshot().encoding, null); f.health.close();
});
