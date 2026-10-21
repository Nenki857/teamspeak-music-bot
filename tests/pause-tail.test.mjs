import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { AudioPlayer } from '../vendor/teamspeak-music-bot-1.13.2/dist/audio/player.js';
import { createOpusEncoder } from '../vendor/teamspeak-music-bot-1.13.2/dist/audio/encoder.js';
const silent = { info() {}, warn() {}, error() {}, debug() {} };

function fixture(t) {
  const player = new AudioPlayer(silent); const stream = new PassThrough();
  const frames = []; const inputs = []; const ends = []; const errors = []; const endedTracks = [];
  const encode = player.encoder.encode.bind(player.encoder);
  player.encoder.encode = pcm => { inputs.push(Buffer.from(pcm)); return encode(pcm); };
  player.on('frame', data => frames.push({ data, at: performance.now() }));
  player.on('voiceEnd', () => ends.push({ at: performance.now(), frames: frames.length }));
  player.on('error', error => errors.push(error)); player.on('trackEnd', () => endedTracks.push(true));
  const pcm = Buffer.alloc(3840 * 80);
  for (let i = 0; i < pcm.length / 4; i++) {
    pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 48000) * 10000), i * 4);
    pcm.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 660 / 48000) * 10000), i * 4 + 2);
  }
  player.playPcmStream(stream); stream.write(pcm);
  t.after(() => { player.stop(); stream.destroy(); });
  const until = (predicate, message) => new Promise((accept, reject) => {
    const timeout = setTimeout(() => { clearInterval(poll); reject(new Error(message)); }, 5000);
    const check = () => { if (predicate()) { clearTimeout(timeout); clearInterval(poll); accept(); } };
    const poll = setInterval(check, 5); check();
  });
  return { player, stream, frames, inputs, ends, errors, endedTracks, until };
}

test('pause flushes five paced silence frames, freezes the song position and ends voice exactly once', async t => {
  const f = fixture(t); await f.until(() => f.frames.length >= 3, 'audio did not start');
  const count = f.frames.length; const elapsed = f.player.getElapsed(); const remaining = Buffer.from(f.player.pcmBuffer);
  f.player.pause(); f.player.pause(); assert.equal(f.player.getState(), 'paused');
  await f.until(() => f.ends.length === 1, 'voice did not end after silence tail');
  assert.equal(f.frames.length, count + 5); assert.equal(f.player.getElapsed(), elapsed); assert.deepEqual(f.player.pcmBuffer, remaining);
  assert.equal(f.stream.destroyed, false); assert.deepEqual(f.errors, []); assert.deepEqual(f.endedTracks, []);
  const decoder = createOpusEncoder();
  let lastDecoded;
  for (const frame of f.frames) { lastDecoded = decoder.decode(frame.data); assert.equal(lastDecoded.length, 3840); }
  let squared = 0; for (let i = 0; i < lastDecoded.length; i += 2) squared += lastDecoded.readInt16LE(i) ** 2;
  assert.ok(Math.sqrt(squared / (lastDecoded.length / 2)) < 100, 'final decoded tail must settle near silence');
  assert.ok(f.inputs.slice(count).every(pcm => pcm.every(value => value === 0)), 'pause must encode silence rather than consuming song PCM');
  const gaps = f.frames.slice(count + 1).map((frame, i) => frame.at - f.frames[count + i].at);
  assert.ok(gaps.every(gap => gap > 5), `silence must not be burst-sent: ${gaps}`);
  await new Promise(resolve => setTimeout(resolve, 80)); assert.equal(f.frames.length, count + 5); assert.equal(f.ends.length, 1);
  f.player.stop(); assert.equal(f.ends.length, 1, 'stop after a completed pause does not end the stream again');
});

test('rapid resume cancels pending silence and cannot send a late voice end into resumed music', async t => {
  const f = fixture(t); await f.until(() => f.frames.length >= 2, 'audio did not start');
  let count = f.frames.length; f.player.pause(); f.player.resume();
  await f.until(() => f.frames.length >= count + 2, 'rapid resume did not continue');
  assert.equal(f.ends.length, 0); assert.ok(f.inputs.slice(count).every(pcm => pcm.some(value => value !== 0)));
  count = f.frames.length; f.player.pause();
  await f.until(() => f.frames.length > count, 'pause tail did not start');
  const position = f.player.getElapsed(); f.player.resume();
  await f.until(() => f.player.getElapsed() > position + .1, 'mid-tail resume did not advance');
  assert.equal(f.ends.length, 0); assert.equal(f.player.getState(), 'playing');
  f.player.pause(); await f.until(() => f.ends.length === 1, 'completed pause did not end');
  const paused = f.player.getElapsed(); f.player.resume();
  await f.until(() => f.player.getElapsed() > paused + .04, 'resume after completed tail did not advance');
  assert.equal(f.ends.length, 1); f.player.stop(); assert.equal(f.ends.length, 2); assert.deepEqual(f.errors, []);
});

test('stop and playback replacement cancel old pause tails and retain the new session', async t => {
  const f = fixture(t); await f.until(() => f.frames.length >= 2, 'audio did not start');
  f.player.pause(); f.player.stop(); const count = f.frames.length;
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(f.frames.length, count); assert.equal(f.ends.length, 1);
  const next = new PassThrough(); t.after(() => next.destroy());
  f.player.playPcmStream(next); next.write(Buffer.alloc(3840 * 40, 10));
  await f.until(() => f.frames.length >= count + 2, 'replacement audio did not start');
  assert.equal(f.player.getState(), 'playing'); assert.equal(f.ends.length, 1);
  const beforeTail = f.frames.length; f.player.pause();
  await f.until(() => f.frames.length > beforeTail, 'replacement tail did not start');
  f.player.stop(); const stopped = f.frames.length;
  await new Promise(resolve => setTimeout(resolve, 120)); assert.equal(f.frames.length, stopped); assert.equal(f.ends.length, 2); assert.deepEqual(f.endedTracks, []);
});
