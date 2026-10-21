import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createAudioClock } from '../src/worker/audio-clock.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
const clock = createAudioClock();
if (process.argv.includes('--precise')) clock.setActive(true);
const dir = resolve('work/audio-probe'); mkdirSync(dir, { recursive: true });
const duration = 12; const rate = 48000; const samples = rate * duration; const pcm = Buffer.alloc(samples * 4);
for (let i = 0; i < samples; i++) { const value = Math.round(Math.sin(i * Math.PI * 2 * 440 / rate) * 12000); pcm.writeInt16LE(value, i * 4); pcm.writeInt16LE(value, i * 4 + 2); }
const header = Buffer.alloc(44); header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4); header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 4, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
const wav = resolve(dir, 'sine.wav'); writeFileSync(wav, Buffer.concat([header, pcm]));
const { AudioPlayer } = await import(pathToFileURL(resolve('vendor/teamspeak-music-bot-1.13.2/dist/audio/player.js')).href);
const { createOpusEncoder } = await import(pathToFileURL(resolve('vendor/teamspeak-music-bot-1.13.2/dist/audio/encoder.js')).href);
const decoder = createOpusEncoder(); const silent = { info() {}, warn() {}, error() {}, debug() {} }; let player = new AudioPlayer(silent); let core; let store; let clockAcquired = false;
if (process.argv.includes('--integrated')) {
  process.env.TSMD_DATA_DIR = resolve(dir, 'isolated-core-' + randomUUID());
  const { CoreEngine } = await import('../src/worker/core-engine.mjs');
  const { Store } = await import('../src/worker/store.mjs');
  const { createVault } = await import('../src/shared/security.mjs');
  const vault = createVault(randomBytes(32)); store = new Store(vault); core = new CoreEngine(store, vault, () => {}, () => {}); await core.init();
  const bot = await core.manager.createBot({ name: 'Isolated audio check', serverAddress: '127.0.0.1', serverPort: 9987, nickname: 'AudioCheck' });
  core.activeId = bot.id; player = bot.getPlayer();
  core.audioHealth.setPlayer(player);
  // The diagnostic never connects to TS or sends sound into a real channel.
  player.on('frame', () => { clockAcquired ||= core.audioClock.active; });
}
const times = []; const lengths = []; const decodedBytes = []; let emptyTicks = 0;
const originalSend = player.sendNextFrame.bind(player);
player.sendNextFrame = () => { if (player.pcmBuffer.length < 3840) emptyTicks++; return originalSend(); };
const start = performance.now();
const finished = new Promise((accept, reject) => { player.once('trackEnd', accept); player.once('error', reject); });
player.on('frame', frame => { times.push(performance.now()); lengths.push(frame.length); decodedBytes.push(decoder.decode(frame).length); });
player.play(wav, 0, duration);
let deadline; let audioHealth; try { await Promise.race([finished, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Audio probe timeout')), 20000); })]); audioHealth = core?.audioHealth.snapshot(player); } finally { clearTimeout(deadline); player.stop(); clock.close(); core?.close(); store?.close(); }
const gaps = times.slice(1).map((time, index) => time - times[index]); const ordered = [...gaps].sort((a, b) => a - b);
const report = { expectedFrames: duration * 50, frames: times.length, wallSeconds: (performance.now() - start) / 1000, firstFrameMs: times[0] - start, emptyTicks, minGapMs: Math.min(...gaps), p50GapMs: ordered[Math.floor(ordered.length * .5)], p95GapMs: ordered[Math.floor(ordered.length * .95)], maxGapMs: Math.max(...gaps), gapsOver35Ms: gaps.filter(gap => gap > 35).length, gapsUnder5Ms: gaps.filter(gap => gap < 5).length, minPacketBytes: Math.min(...lengths), maxPacketBytes: Math.max(...lengths), decodedFrameBytes: [...new Set(decodedBytes)] };
report.preciseTimer = process.argv.includes('--precise');
report.integratedCore = process.argv.includes('--integrated'); report.clockAcquired = clockAcquired;
if (audioHealth) report.audioHealth = audioHealth;
writeFileSync(resolve(dir, report.integratedCore ? 'integrated-result.json' : report.preciseTimer ? 'precise-result.json' : 'baseline-result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
