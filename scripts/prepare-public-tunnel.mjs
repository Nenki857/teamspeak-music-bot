import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const detail = error => [error?.message, error?.cause?.code, error?.cause?.message].filter(Boolean).join('; ');
async function downloadFile({ url, destination, root }) {
  if (process.platform === 'win32') {
    const shell = resolve(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    console.log('[Download] Using Windows network settings (including the configured system proxy).');
    await new Promise((done, fail) => {
      const child = spawn(shell, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(root, 'scripts/download-file.ps1'), '-Uri', url, '-Destination', destination, '-Label', 'Public-sharing-component'], { windowsHide: true, stdio: 'inherit' });
      child.once('error', fail);
      child.once('exit', code => code === 0 ? done() : fail(Error('Windows download failed; exit code ' + code + '. See the network error above.')));
    });
    return;
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw Error('HTTP ' + response.status);
  const total = Number(response.headers.get('content-length')) || 0;
  let bytes = 0, previousBytes = 0, last = Date.now();
  const progress = new Transform({ transform(chunk, _encoding, callback) {
    bytes += chunk.length;
    const now = Date.now();
    if (now - last >= 1000) {
      const size = (bytes / 1048576).toFixed(2) + ' MiB';
      const percent = total > 0 ? ' / ' + (total / 1048576).toFixed(2) + ' MiB (' + Math.min(100, Math.floor(bytes * 100 / total)) + '%)' : '';
      console.log('[Download] Public-sharing-component: ' + size + percent + ' | ' + ((bytes - previousBytes) / 1024 / ((now - last) / 1000)).toFixed(1) + ' KiB/s');
      last = now; previousBytes = bytes;
    }
    callback(null, chunk);
  }});
  await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(destination, { flags: 'wx' }));
  console.log('[Download] Public-sharing-component: ' + (bytes / 1048576).toFixed(2) + ' MiB | complete');
}
export async function preparePublicTunnel({ root, required = false, download = downloadFile, log = console } = {}) {
  const metadata = JSON.parse(readFileSync(resolve(root, 'resources/cloudflared-version.json')));
  if (!/^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\/[\w.-]+\/cloudflared-windows-amd64\.exe$/.test(metadata.url) || !/^sha256:[a-f0-9]{64}$/.test(metadata.digest)) throw Error('Invalid public-sharing component metadata');
  const target = resolve(root, 'resources/cloudflared.exe'), expected = metadata.digest.slice(7);
  if (existsSync(target)) {
    if (sha256(target) !== expected) throw Error('Existing public-sharing component failed SHA-256 verification; file was not replaced.');
    log.log('[Setup] Public-sharing component is already verified.'); return true;
  }
  log.log('[Setup] Downloading public-sharing component');
  let failure;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const temporary = target + '.' + randomUUID() + '.part';
    try {
      log.log('[Download] Public-sharing component: attempt ' + attempt + '/2');
      await download({ url: metadata.url, destination: temporary, root });
      if (sha256(temporary) !== expected) throw Error('Public-sharing component SHA-256 verification failed');
      renameSync(temporary, target);
      log.log('[Setup] Public-sharing component downloaded and verified.');
      return true;
    } catch (error) {
      failure = error; log.warn('[Download] ' + detail(error));
      if (attempt === 1) log.warn('[Download] Retrying the official download once...');
    } finally { rmSync(temporary, { force: true }); }
  }
  const message = 'Public-sharing component could not be downloaded. Local playback can run, but the public friend link is unavailable. Check access to github.com, then rerun the same launcher.';
  if (required) throw Error('Cannot create a complete release: ' + message, { cause: failure });
  log.warn('[Warning] ' + message);
  log.warn('[Download] Official file for manual download: ' + metadata.url);
  log.warn('[Download] Save as: ' + target + ' (SHA-256 is verified on the next launch).');
  return false;
}
