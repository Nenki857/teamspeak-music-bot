import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createWindowsResourceReader } from './windows-resources.mjs';

export function createResourceMonitor({ platform = process.platform, loadReader = createWindowsResourceReader,
  logicalCpus = cpus().length, now = () => performance.now(), wallNow = () => Date.now(), minInterval = 900, maxInterval = 5000 } = {}) {
  let reader; let lastProcesses; let lastNetwork; let lastAt; let cached;
  const unavailable = () => ({ cpu: { percent: null, status: 'unavailable', processes: 0 }, memory: { bytes: null, status: 'unavailable' },
    network: { scope: 'system-physical', receivedPerSecond: null, sentPerSecond: null, status: 'unavailable', adapters: 0 } });
  return {
    sample() {
      const at = now();
      if (cached && at - lastAt >= 0 && at - lastAt < minInterval) return cached;
      const interval = lastAt === undefined ? 0 : at - lastAt;
      const continuous = interval >= minInterval && interval <= maxInterval;
      const result = { sampledAt: wallNow(), intervalMs: interval, ...unavailable() };
      try {
        if (platform !== 'win32') throw new Error('Unsupported platform');
        reader ||= loadReader();
      } catch { cached = result; lastAt = at; lastProcesses = lastNetwork = undefined; return result; }
      try {
        const { rows, missing } = reader.readProcesses();
        const previous = continuous ? lastProcesses : undefined;
        let cpuDelta = 0; let compared = 0; let memoryBytes = 0; let memoryCount = 0;
        for (const row of rows) {
          const before = previous?.get(row.identity);
          if (before !== undefined && row.cpuMs >= before) { cpuDelta += row.cpuMs - before; compared++; }
          if (Number.isFinite(row.memoryBytes) && row.memoryBytes >= 0) { memoryBytes += row.memoryBytes; memoryCount++; }
        }
        result.cpu = { percent: compared ? Math.max(0, Math.min(100, cpuDelta / interval / Math.max(1, logicalCpus) * 100)) : null,
          status: compared ? missing ? 'partial' : 'ok' : 'warming', processes: rows.length };
        result.memory = { bytes: memoryCount ? memoryBytes : null, status: memoryCount ? missing || memoryCount !== rows.length ? 'partial' : 'ok' : 'unavailable' };
        lastProcesses = new Map(rows.map(row => [row.identity, row.cpuMs]));
      } catch { lastProcesses = undefined; }
      try {
        const rows = reader.readNetwork(); const previous = continuous ? lastNetwork : undefined;
        let received = 0n; let sent = 0n; let compared = 0;
        for (const row of rows) {
          const before = previous?.get(row.id);
          if (before && row.received >= before.received && row.sent >= before.sent) {
            received += row.received - before.received; sent += row.sent - before.sent; compared++;
          }
        }
        result.network = { scope: 'system-physical', receivedPerSecond: compared ? Number(received) / interval * 1000 : null,
          sentPerSecond: compared ? Number(sent) / interval * 1000 : null, status: !rows.length ? 'disconnected' : compared ? 'ok' : 'warming', adapters: rows.length };
        lastNetwork = new Map(rows.map(row => [row.id, row]));
      } catch { lastNetwork = undefined; }
      cached = result; lastAt = at; return result;
    },
    reset() { lastProcesses = lastNetwork = lastAt = cached = undefined; }
  };
}
