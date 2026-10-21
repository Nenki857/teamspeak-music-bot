import { performance } from 'node:perf_hooks';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { IsolatedCore } from '../src/worker/core-host.mjs';
import { createVault } from '../src/shared/security.mjs';

process.env.TSMD_DATA_DIR = resolve('work/core-stress-local-' + randomUUID());
const { CoreEngine } = await import('../tests/fixtures/core-engine.mjs');
const { Store } = await import('../src/worker/store.mjs');
const engineModule = new URL('../tests/fixtures/core-engine.mjs', import.meta.url).href;
const backgroundPauseMs = 100; const backgroundIntervalMs = 350;
async function measure(isolated, background) {
  const key = randomBytes(32); let store; let core; let timer;
  if (isolated) core = new IsolatedCore({ key, dataDirectory: resolve('work/core-stress-' + randomUUID()), engineModule });
  else { const vault = createVault(key); store = new Store(vault); core = new CoreEngine(store, vault, () => {}, () => {}); }
  try {
    await core.init(); await core.start({ probeFrames: 180 });
    if (background) timer = setInterval(() => {
      // A deterministic stand-in for a slow DB/state-broadcast callback; not a measured user workload.
      const until = performance.now() + backgroundPauseMs; while (performance.now() < until) {}
      JSON.stringify(core.status());
    }, backgroundIntervalMs);
    const deadline = performance.now() + 15000; let result;
    while (!result && performance.now() < deadline) { await new Promise(accept => setTimeout(accept, 200)); result = await core.command('probe.result'); }
    assert.ok(result, 'synthetic audio timed out');
    return { isolated, background, ...result, health: core.health() };
  } finally { clearInterval(timer); await core?.close(); store?.close(); }
}
const idle = await measure(true, false);
const coupled = await measure(false, true);
const isolated = await measure(true, true);
assert.equal(idle.frames, 180); assert.equal(coupled.frames, 180); assert.equal(isolated.frames, 180);
assert.ok(coupled.maxGapMs > 90, 'baseline did not exercise background stalls');
assert.ok(isolated.maxGapMs < coupled.maxGapMs / 2, 'the background thread still disrupts audio');
const report = { syntheticWorkload: true, realTSDeliveryVerified: false, networkAccess: false, queueSize: 500, backgroundPauseMs, backgroundIntervalMs, idle, coupled, isolated };
mkdirSync(resolve('work/audio-probe'), { recursive: true }); writeFileSync(resolve('work/audio-probe/core-isolation-result.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
