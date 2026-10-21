import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { createResourceMonitor } from '../src/desktop/resource-monitor.mjs';
import { createWindowsResourceReader } from '../src/desktop/windows-resources.mjs';

const row = (identity, cpuMs, memoryBytes = 1024) => ({ identity, cpuMs, memoryBytes });
const nic = (id, received, sent) => ({ id, received: BigInt(received), sent: BigInt(sent) });
function fixture() {
  let at = 0; let processes = { rows: [row('main', 100), row('child', 200)], missing: 0 };
  let network = [nic('a', 10000, 20000)]; let calls = 0; let processError = false; let networkError = false;
  const reader = { readProcesses() { calls++; if (processError) throw new Error('Denied'); return processes; }, readNetwork() { if (networkError) throw new Error('Denied'); return network; } };
  const monitor = createResourceMonitor({ platform: 'win32', logicalCpus: 8, loadReader: () => reader, now: () => at, wallNow: () => 100000 + at });
  return { monitor, get calls() { return calls; }, advance(ms = 1000) { at += ms; }, setProcesses(rows, missing = 0) { processes = { rows, missing }; }, setNetwork(rows) { network = rows; }, errors(cpu, net) { processError = cpu; networkError = net; } };
}

test('resource rates use elapsed time and all app components, normalized to total CPU capacity', () => {
  const f = fixture(); const initial = f.monitor.sample();
  assert.equal(initial.cpu.percent, null); assert.equal(initial.cpu.status, 'warming'); assert.equal(initial.memory.bytes, 2048);
  f.advance(); f.setProcesses([row('main', 500, 3000), row('child', 600, 5000), row('new-child', 10000, 7000)]);
  f.setNetwork([nic('a', 112400, 71200)]);
  const next = f.monitor.sample();
  assert.equal(next.cpu.percent, 10); assert.equal(next.cpu.processes, 3); assert.equal(next.memory.bytes, 15000);
  assert.equal(next.network.receivedPerSecond, 102400); assert.equal(next.network.sentPerSecond, 51200);
  assert.equal(next.network.scope, 'system-physical');
  f.advance(2000); f.setProcesses([row('main', 1300), row('child', 1400), row('new-child', 10000)]);
  assert.equal(f.monitor.sample().cpu.percent, 10, 'a delayed refresh uses its actual two-second interval');
});

test('sampling is cached, resumes with a baseline after hiding, and cannot spike on reused PIDs or reset counters', () => {
  const f = fixture(); const first = f.monitor.sample(); f.advance(200);
  assert.equal(f.monitor.sample(), first); assert.equal(f.calls, 1);
  f.advance(800); f.setProcesses([row('reused-main-pid', 100000), row('child', 280)]);
  f.setNetwork([nic('a', 1, 2), nic('new-adapter', 999999999, 999999999)]);
  const reused = f.monitor.sample(); assert.equal(reused.cpu.percent, 1); assert.equal(reused.network.receivedPerSecond, null);
  f.advance(6000); assert.equal(f.monitor.sample().cpu.percent, null); assert.equal(f.monitor.sample().network.receivedPerSecond, null);
  f.monitor.reset(); assert.equal(f.monitor.sample().cpu.percent, null);
});

test('denied or missing counters are unavailable instead of false zeroes, and can recover independently', () => {
  const f = fixture(); f.monitor.sample(); f.advance(); f.errors(true, false);
  let value = f.monitor.sample(); assert.equal(value.cpu.status, 'unavailable'); assert.equal(value.memory.bytes, null); assert.equal(value.network.status, 'ok');
  f.advance(); f.errors(false, true); f.setProcesses([row('main', 500, 123), row('child', 600, null)], 1);
  value = f.monitor.sample(); assert.equal(value.cpu.status, 'warming'); assert.equal(value.memory.status, 'partial'); assert.equal(value.network.receivedPerSecond, null);
  f.advance(); f.setNetwork([]); f.errors(false, false); value = f.monitor.sample();
  assert.equal(value.cpu.status, 'partial'); assert.equal(value.network.status, 'disconnected');
  const unsupported = createResourceMonitor({ platform: 'other', loadReader() { throw new Error('Must not load'); } }).sample();
  assert.equal(unsupported.cpu.status, 'unavailable'); assert.equal(unsupported.network.status, 'unavailable');
});

test('Windows native counters include live child and grandchild processes and detect actual CPU work', { skip: process.platform !== 'win32' }, async t => {
  const helper = `const { fork } = require('node:child_process'); const child = fork('-e', ['setInterval(() => {}, 1000)'], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }); child.once('spawn', () => process.send({ pid: process.pid, grandchild: child.pid })); process.on('message', () => { child.once('exit', () => process.exit(0)); child.kill(); });`;
  const child = fork('-e', [helper], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => { if (child.exitCode === null && child.connected) { const exited = once(child, 'exit'); child.send('stop'); await exited; } });
  const ready = await Promise.race([once(child, 'message').then(([message]) => message), delay(8000, undefined, { ref: false }).then(() => { throw new Error('Counter helper timeout'); })]);
  const reader = createWindowsResourceReader();
  const result = reader.readProcesses();
  for (const pid of [process.pid, ready.pid, ready.grandchild]) assert.ok(result.rows.some(row => row.pid === pid && row.memoryBytes > 0));
  const monitor = createResourceMonitor({ loadReader: () => reader }); monitor.sample();
  const until = performance.now() + 100; while (performance.now() < until) Math.sqrt(Math.random());
  await delay(950); const sample = monitor.sample();
  assert.ok(sample.cpu.percent > 0 && sample.cpu.percent <= 100); assert.ok(sample.memory.bytes > 0);
  assert.ok(['ok', 'partial'].includes(sample.cpu.status));
  const interfaces = reader.readNetwork();
  for (const item of interfaces) assert.ok(typeof item.received === 'bigint' && item.received >= 0n && item.sent >= 0n);
});
