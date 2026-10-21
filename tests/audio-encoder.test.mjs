import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const root = resolve('vendor/teamspeak-music-bot-1.13.2');
const { createOpusEncoder, PCM_FRAME_BYTES, TS_OPUS_MUSIC_BITRATE } = await import(pathToFileURL(resolve(root, 'dist/audio/encoder.js')).href);
const { OpusEncoder } = createRequire(resolve(root, 'package.json'))('@discordjs/opus');

test('TS music encoding explicitly selects the documented quality-10 payload rate instead of libopus AUTO', () => {
  const baseline = new OpusEncoder(48000, 2); const encoder = createOpusEncoder();
  assert.equal(baseline.getBitrate(), 120000, 'the pinned binding currently defaults to 120 kbps');
  assert.equal(TS_OPUS_MUSIC_BITRATE, 79200);
  assert.deepEqual(encoder.getSettings(), { codec: 'opus-music', sampleRate: 48000, channels: 2, frameDurationMs: 20, bitrate: 79200, variableBitrate: false });
});

test('silence, transients and stereo noise stay within a fixed 198-byte / 20ms payload budget', t => {
  const baseline = new OpusEncoder(48000, 2); const encoder = createOpusEncoder(); const decoder = createOpusEncoder();
  const before = []; const after = []; let seed = 123456789;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 0x100000000 * 2 - 1; };
  const frames = 240;
  for (let frame = 0; frame < frames; frame++) {
    const pcm = Buffer.alloc(PCM_FRAME_BYTES);
    for (let sample = 0; sample < 960; sample++) {
      const at = frame * 960 + sample; const type = frame % 4;
      const left = type === 0 ? 0 : type === 1 ? Math.sin(at * 2 * Math.PI * 440 / 48000) * 12000 : type === 2 ? (sample < 8 ? 30000 : 0) : random() * 24000;
      const right = type === 0 ? 0 : type === 1 ? Math.sin(at * 2 * Math.PI * 659 / 48000) * 12000 : type === 2 ? (sample > 950 ? -30000 : 0) : random() * 24000;
      pcm.writeInt16LE(Math.round(left), sample * 4); pcm.writeInt16LE(Math.round(right), sample * 4 + 2);
    }
    before.push(baseline.encode(pcm).length);
    const encoded = encoder.encode(pcm); after.push(encoded.length);
    assert.equal(encoded.length, 198, `frame ${frame}: packet-size burst`);
    assert.equal(decoder.decode(encoded).length, PCM_FRAME_BYTES, 'every packet must still contain 20ms of stereo audio');
  }
  assert.ok(Math.max(...before) > 198, 'exercise the old AUTO/VBR packet-size mismatch');
  assert.equal(after.reduce((sum, n) => sum + n, 0) * 8 / (frames * .02), 79200);
  t.diagnostic(JSON.stringify({ syntheticAudio: true, realTSDeliveryVerified: false,
    previous: { configuredBitrate: baseline.getBitrate(), minPayloadBytes: Math.min(...before), maxPayloadBytes: Math.max(...before) },
    current: { configuredBitrate: encoder.getSettings().bitrate, minPayloadBytes: Math.min(...after), maxPayloadBytes: Math.max(...after), voicePacketBytes: 214 } }));
});

test('ending an Opus stream resets coding history without losing the TS bitrate settings', () => {
  const encoder = createOpusEncoder(); const fresh = createOpusEncoder();
  const pcm = Buffer.alloc(PCM_FRAME_BYTES);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(Math.round(Math.sin(i * .13) * 20000), i);
  const first = fresh.encode(pcm);
  for (let i = 0; i < 10; i++) encoder.encode(pcm);
  encoder.reset(); assert.equal(encoder.getSettings().bitrate, 79200); assert.equal(encoder.getSettings().variableBitrate, false);
  assert.deepEqual(encoder.encode(pcm), first);
});
