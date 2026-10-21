import koffi from 'koffi';
let handle;
export function containChildProcesses() {
  if (process.platform !== 'win32') return true;
  const kernel = koffi.load('kernel32.dll');
  const create = kernel.func('void * __stdcall CreateJobObjectW(void *, const char16_t *)');
  const set = kernel.func('bool __stdcall SetInformationJobObject(void *, int, const void *, uint32)');
  const assign = kernel.func('bool __stdcall AssignProcessToJobObject(void *, void *)');
  const current = kernel.func('void * __stdcall GetCurrentProcess()');
  const close = kernel.func('bool __stdcall CloseHandle(void *)');
  const job = create(null, null); if (!job) return false;
  const info = Buffer.alloc(process.arch === 'x64' ? 144 : 112); info.writeUInt32LE(0x2000, 16);
  if (!set(job, 9, info, info.length) || !assign(job, current())) { close(job); return false; }
  // Keep the handle for this process lifetime; Windows closes it on a crash/exit,
  // terminating the worker's FFmpeg, downloader and tunnel descendants.
  handle = job; return true;
}
