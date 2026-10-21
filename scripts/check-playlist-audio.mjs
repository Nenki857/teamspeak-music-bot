import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAudioClock } from '../src/worker/audio-clock.mjs';
import { createAudioHealth } from '../src/worker/audio-health.mjs';
import { IsolatedMusicProvider } from '../src/worker/music-provider.mjs';
import api from '../tests/fixtures/music-api.mjs';
const { AudioPlayer } = await import(pathToFileURL(resolve('vendor/teamspeak-music-bot-1.13.2/dist/audio/player.js')).href);
const { NeteaseProvider } = await import(pathToFileURL(resolve('vendor/teamspeak-music-bot-1.13.2/dist/music/netease.js')).href);
const apiModule = new URL('../tests/fixtures/music-api.mjs', import.meta.url).href;
const clock = createAudioClock(); clock.setActive(true);
const frames = 160; const pcm = Buffer.alloc(frames * 3840);
for (let i = 0; i < pcm.length / 4; i++) { const value = Math.round(Math.sin(i * Math.PI * 880 / 48000) * 10000); pcm.writeInt16LE(value, i * 4); pcm.writeInt16LE(value, i * 4 + 2); }
const silent = { info() {}, warn() {}, error() {}, debug() {} };

async function measure(isolated) {
  const player = new AudioPlayer(silent); const health = createAudioHealth(); const stream = new PassThrough();
  let provider;
  if (isolated) { provider = new IsolatedMusicProvider({ apiModule }); await provider.ready; }
  else { provider = new NeteaseProvider('http://127.0.0.1'); provider.api = { get: async (route, { params }) => ({ data: (await api[route.slice(1).replaceAll('/', '_')](params)).body }) }; }
  const times = []; const timers = []; const jobs = []; let deadline;
  const done = new Promise((accept, reject) => {
    deadline = setTimeout(() => reject(new Error('Audio stress test timeout')), 15000);
    player.on('frame', () => { times.push(performance.now()); if (times.length === frames) accept(); }); player.on('error', reject);
  });
  const start = performance.now(); player.playPcmStream(stream); health.setPlayer(player); stream.write(pcm);
  for (const [index, delay] of [250, 1100, 1950].entries()) timers.push(setTimeout(() => { jobs.push(provider.search('cpu-stress-' + index)); }, delay));
  try {
    await done; await Promise.all(jobs);
    const gaps = times.slice(1).map((value, index) => value - times[index]).sort((a, b) => a - b);
    return { isolated, frames: times.length, wallSeconds: (performance.now() - start) / 1000,
      p50GapMs: gaps[Math.floor(gaps.length * .5)], p95GapMs: gaps[Math.floor(gaps.length * .95)], maxGapMs: gaps.at(-1),
      gapsOver45Ms: gaps.filter(value => value >= 45).length, health: health.snapshot(player) };
  } finally { clearTimeout(deadline); timers.forEach(clearTimeout); player.stop(); stream.destroy(); health.close(); await provider.close?.(); }
}

try {
  const coupled = await measure(false); const isolated = await measure(true);
  assert.equal(coupled.frames, frames); assert.equal(isolated.frames, frames);
  assert.ok(coupled.maxGapMs > 400, 'control did not exercise a blocking workload');
  assert.ok(isolated.maxGapMs < coupled.maxGapMs / 2, 'isolated API work still stalls the audio loop');
  const report = { syntheticWorkload: true, networkAccess: false, realTSDeliveryVerified: false, coupled, isolated };
  mkdirSync(resolve('work/audio-probe'), { recursive: true }); writeFileSync(resolve('work/audio-probe/playlist-stress-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { clock.close(); }
