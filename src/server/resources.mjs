import { readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { availableParallelism } from 'node:os';

const execute = promisify(execFile);
export function createLinuxResourceMonitor({ proc = '/proc', pid = process.pid, extraRoots = async()=>[], now = Date.now, read = readFile, list = readdir, clockTicks = 100, pageSize = 4096, cpuCount = availableParallelism() } = {}) {
  let previous; let cached; let pending;
  async function sample() {
    const at = now(); if (cached && at - cached.sampledAt < 1000) return cached;
    const rows = await list(proc); const processes = [];
    await Promise.all(rows.filter(name => /^\d+$/.test(name)).map(async name => {
      try {
        const fields = (await read(`${proc}/${name}/stat`, 'utf8')).trim();
        const values = fields.slice(fields.lastIndexOf(')') + 2).split(/\s+/);
        processes.push({ pid: Number(name), parent: Number(values[1]), identity: `${name}:${values[19]}`, cpuMs: (Number(values[11]) + Number(values[12])) / clockTicks * 1000, memory: Number(values[21]) * pageSize });
      } catch { /* A process can exit while /proc is being sampled. */ }
    }));
    const owned = new Set([pid,...(await extraRoots()).filter(value=>Number.isInteger(value)&&value>0)]); let changed = true;
    while (changed) { changed = false; for (const row of processes) if (owned.has(row.parent) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } }
    const family = processes.filter(row => owned.has(row.pid)); const interval = previous ? at - previous.at : 0;
    const continuous = interval >= 1000 && interval <= 5000; let cpu = 0; let compared = 0;
    for (const row of family) { const before = continuous && previous.processes.get(row.identity); if (typeof before === 'number' && row.cpuMs >= before) { cpu += row.cpuMs - before; compared++; } }
    let network = { scope: 'server-total', status: 'unavailable', receivedPerSecond: null, sentPerSecond: null, adapters: 0 }; const adapters = new Map();
    try {
      for (const line of (await read(`${proc}/net/dev`, 'utf8')).split('\n').slice(2)) {
        const match = line.trim().match(/^([^:]+):\s*(.*)$/); if (!match || match[1] === 'lo' || /^(docker|veth|br-|tun|tap)/.test(match[1])) continue;
        const values = match[2].trim().split(/\s+/); adapters.set(match[1], { received: BigInt(values[0]), sent: BigInt(values[8]) });
      }
      let received = 0n; let sent = 0n; let comparedNetwork = 0;
      for (const [name, row] of adapters) { const before = continuous && previous.adapters.get(name); if (before && row.received >= before.received && row.sent >= before.sent) { received += row.received - before.received; sent += row.sent - before.sent; comparedNetwork++; } }
      network = { scope: 'server-total', status: comparedNetwork ? 'ok' : adapters.size ? 'warming' : 'disconnected', receivedPerSecond: comparedNetwork ? Number(received) / interval * 1000 : null, sentPerSecond: comparedNetwork ? Number(sent) / interval * 1000 : null, adapters: adapters.size };
    } catch {}
    cached = { sampledAt: at, intervalMs: interval, cpu: { percent: compared ? Math.min(100, Math.max(0, cpu / interval / cpuCount * 100)) : null, status: compared ? 'ok' : 'warming', processes: family.length }, memory: { bytes: family.length ? family.reduce((sum, row) => sum + row.memory, 0) : null, status: family.length ? 'ok' : 'unavailable' }, network };
    previous = { at, processes: new Map(family.map(row => [row.identity, row.cpuMs])), adapters }; return cached;
  }
  return { sample() { if (!pending) pending = sample().finally(() => { pending = null; }); return pending; } };
}
export async function linuxResourceMonitor(options={}) {
  const ticks = Number((await execute('getconf', ['CLK_TCK'])).stdout.trim());
  const pageSize = Number((await execute('getconf', ['PAGESIZE'])).stdout.trim());
  return createLinuxResourceMonitor({ clockTicks: ticks, pageSize, ...options });
}
