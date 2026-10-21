import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Read-only Windows counters: no shell, packet capture or elevated service.
// Layouts: PROCESSENTRY32W, PROCESS_MEMORY_COUNTERS_EX and MIB_IF_ROW2 (Microsoft Learn).
export function createWindowsResourceReader(rootPid = process.pid) {
  // Resource counters can be unavailable without preventing the desktop from opening.
  const koffi = require('koffi');
  const kernel = koffi.load('kernel32.dll');
  const ip = koffi.load('iphlpapi.dll');
  const processEntry = koffi.struct({
    size: 'uint32', usage: 'uint32', pid: 'uint32', heap: 'uintptr_t', module: 'uint32',
    threads: 'uint32', parentPid: 'uint32', priority: 'int32', flags: 'uint32', name: koffi.array('char16_t', 260)
  });
  const memoryInfo = koffi.struct({
    size: 'uint32', faults: 'uint32', peakWorkingSet: 'size_t', workingSet: 'size_t',
    peakPaged: 'size_t', paged: 'size_t', peakNonPaged: 'size_t', nonPaged: 'size_t',
    pagefile: 'size_t', peakPagefile: 'size_t', privateUsage: 'size_t'
  });
  const interfaceRow = koffi.struct({
    luid: 'uint64', index: 'uint32', guid: koffi.array('uint8', 16),
    alias: koffi.array('uint16', 257), description: koffi.array('uint16', 257),
    addressLength: 'uint32', address: koffi.array('uint8', 32), permanentAddress: koffi.array('uint8', 32),
    mtu: 'uint32', type: 'uint32', tunnel: 'uint32', media: 'uint32', physicalMedium: 'uint32',
    access: 'uint32', direction: 'uint32', flags: 'uint8', operStatus: 'uint32', adminStatus: 'uint32',
    mediaConnectState: 'uint32', networkGuid: koffi.array('uint8', 16), connectionType: 'uint32',
    transmitLinkSpeed: 'uint64', receiveLinkSpeed: 'uint64',
    inOctets: 'uint64', inUnicast: 'uint64', inOther: 'uint64', inDiscards: 'uint64', inErrors: 'uint64',
    inUnknown: 'uint64', inUnicastOctets: 'uint64', inMulticastOctets: 'uint64', inBroadcastOctets: 'uint64',
    outOctets: 'uint64', outUnicast: 'uint64', outOther: 'uint64', outDiscards: 'uint64', outErrors: 'uint64',
    outUnicastOctets: 'uint64', outMulticastOctets: 'uint64', outBroadcastOctets: 'uint64', outQueueLength: 'uint64'
  });
  const interfaceTable = koffi.struct({ count: 'uint32', rows: koffi.array(interfaceRow, 1) });
  const snapshot = kernel.func('void * __stdcall CreateToolhelp32Snapshot(uint32, uint32)');
  const first = kernel.func('__stdcall', 'Process32FirstW', 'int', ['void *', koffi.inout(koffi.pointer(processEntry))]);
  const next = kernel.func('__stdcall', 'Process32NextW', 'int', ['void *', koffi.inout(koffi.pointer(processEntry))]);
  const open = kernel.func('void * __stdcall OpenProcess(uint32, int, uint32)');
  const times = kernel.func('int __stdcall GetProcessTimes(void *, void *, void *, void *, void *)');
  const memory = kernel.func('int __stdcall K32GetProcessMemoryInfo(void *, void *, uint32)');
  const close = kernel.func('int __stdcall CloseHandle(void *)');
  const getTable = ip.func('uint32 __stdcall GetIfTable2(_Out_ void **)');
  const freeTable = ip.func('void __stdcall FreeMibTable(void *)');
  const entrySize = koffi.sizeof(processEntry); const memorySize = koffi.sizeof(memoryInfo);
  const rowSize = koffi.sizeof(interfaceRow); const rowOffset = koffi.offsetof(interfaceTable, 'rows');
  return {
    readProcesses() {
      const handle = snapshot(2, 0);
      if (!handle || koffi.address(handle) === (1n << BigInt(koffi.sizeof('void *') * 8)) - 1n) throw new Error('Process snapshot unavailable');
      const entries = [];
      try {
        const entry = { size: entrySize };
        if (!first(handle, entry)) throw new Error('Process enumeration unavailable');
        do { entries.push({ pid: entry.pid, parentPid: entry.parentPid }); } while (next(handle, entry));
      } finally { close(handle); }
      const children = new Map();
      for (const entry of entries) { const list = children.get(entry.parentPid) || []; list.push(entry); children.set(entry.parentPid, list); }
      const root = entries.find(entry => entry.pid === rootPid);
      if (!root) throw new Error('Application process unavailable');
      const pending = [{ ...root, parentStarted: 0n }]; const seen = new Set(); const rows = []; let missing = 0;
      for (let i = 0; i < pending.length; i++) {
        const entry = pending[i]; if (seen.has(entry.pid)) continue; seen.add(entry.pid);
        const processHandle = open(0x1000, 0, entry.pid);
        if (!processHandle) { missing++; continue; }
        try {
          const created = Buffer.alloc(8); const exited = Buffer.alloc(8); const system = Buffer.alloc(8); const user = Buffer.alloc(8);
          if (!times(processHandle, created, exited, system, user)) { missing++; continue; }
          const started = created.readBigUInt64LE();
          // An orphan's old parent PID may have been reused by this app.
          if (started < entry.parentStarted) continue;
          const info = Buffer.alloc(memorySize); info.writeUInt32LE(memorySize);
          const memoryOk = Boolean(memory(processHandle, info, memorySize));
          rows.push({ pid: entry.pid, identity: `${entry.pid}:${started}`, cpuMs: Number(system.readBigUInt64LE() + user.readBigUInt64LE()) / 10000,
            memoryBytes: memoryOk ? Number(koffi.decode(info, memoryInfo).workingSet) : null });
          for (const child of children.get(entry.pid) || []) pending.push({ ...child, parentStarted: started });
        } finally { close(processHandle); }
      }
      if (!rows.some(row => row.pid === rootPid)) throw new Error('Application counters unavailable');
      return { rows, missing };
    },
    readNetwork() {
      const output = [null]; const status = getTable(output);
      if (status !== 0 || !output[0]) throw new Error('Network counters unavailable');
      try {
        const count = koffi.decode(output[0], 'uint32');
        if (count > 4096) throw new Error('Invalid network table');
        const rows = [];
        for (let i = 0; i < count; i++) {
          const row = koffi.decode(output[0], rowOffset + i * rowSize, interfaceRow);
          // Physical interfaces avoid counting loopback and tunnel traffic twice.
          if (row.operStatus !== 1 || !(row.flags & 1) || (row.flags & 0x82) || row.type === 24 || row.type === 131) continue;
          rows.push({ id: String(row.luid), received: BigInt(row.inOctets), sent: BigInt(row.outOctets) });
        }
        return rows;
      } finally { freeTable(output[0]); }
    }
  };
}
