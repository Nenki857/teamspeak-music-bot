import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, statSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeApi, probeQr, musicFailure } from './diagnose-server-music.mjs';
import { readSavedLogin } from './diagnose-music-regression.mjs';

export async function probeWebRequests(raw, transform, cookie = '', { stopOnFailure = false } = {}) {
  let songId, playlistId, qrKey;
  const api = Object.fromEntries(['cloudsearch', 'personalized', 'login_qr_key', 'login_qr_create'].map(method => [method, async args => {
    const params = { ...args, ...(cookie && !method.startsWith('login_qr_') ? { cookie } : {}) };
    const response = await raw[method](transform(method, params, true));
    if (method === 'cloudsearch' && args.type === 1) songId = response?.body?.result?.songs?.find(song => song.fee === 0 || song.fee === 8)?.id || response?.body?.result?.songs?.[0]?.id;
    if (method === 'personalized') playlistId = response?.body?.result?.[0]?.id;
    if (method === 'login_qr_key') qrKey = response?.body?.data?.unikey;
    return response;
  }]));
  const requests = await probeApi(api, { stopOnFailure });
  if (stopOnFailure && requests.some(item => !item.ok)) return { requests, qrLogin: { ok: false, category: 'not-tested-after-failure' }, extra: [], candidatePassed: false };
  const qrLogin = await probeQr(api);
  if (stopOnFailure && !qrLogin.ok) return { requests, qrLogin, extra: [], candidatePassed: false };
  const extra = [];
  // Only test dependent endpoints if search / QR creation succeeded. A rejected
  // request does not cause retries, guest registration or identity changes.
  for (const [name, method, args, ready] of [
    ['songUrl', 'song_url_v1', { id: String(songId), level: 'standard', ...(cookie ? { cookie } : {}) }, Boolean(songId)],
    ['playlistTracks', 'playlist_track_all', { id: String(playlistId), limit: 1, ...(cookie ? { cookie } : {}) }, Boolean(playlistId)],
    ['qrWaiting', 'login_qr_check', { key: qrKey }, Boolean(qrKey && qrLogin.ok)]
  ]) {
    if (!ready) { extra.push({ name, ok: false, category: 'sample-unavailable' }); continue; }
    let timer;
    try {
      const value = await Promise.race([Promise.resolve().then(() => raw[method](transform(method, args, true))), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error(), { code: 'ETIMEDOUT' })), 12000); })]);
      const ok = value?.status === 200 && (method === 'login_qr_check' ? [801, 802].includes(value?.body?.code) : value?.body?.code === 200);
      extra.push({ name, ...(ok ? { ok: true } : musicFailure(value)), ...(method === 'song_url_v1' && ok ? { playableUrlReturned: typeof value?.body?.data?.[0]?.url === 'string' && /^https?:\/\//.test(value.body.data[0].url) } : {}) });
    } catch (error) { extra.push({ name, ...musicFailure(error) }); }
    finally { clearTimeout(timer); }
  }
  return { requests, qrLogin, extra, candidatePassed: requests.every(item => item.ok) && qrLogin.ok && extra.every(item => item.ok) && extra.find(item => item.name === 'songUrl')?.playableUrlReturned === true };
}

if (!isMainThread && workerData?.role === 'web-compatibility') {
  let temporary;
  try {
    temporary = mkdtempSync(resolve(tmpdir(), 'tsmd-web-check-'));
    const token = resolve(workerData.data, 'temp/anonymous_token');
    writeFileSync(resolve(temporary, 'anonymous_token'), existsSync(token) && statSync(token).size <= 65536 ? readFileSync(token) : '', { mode: 0o600 });
    process.env.TMPDIR = temporary; process.env.TMP = temporary; process.env.TEMP = temporary;
    const require = createRequire(resolve(workerData.app, 'vendor/teamspeak-music-bot-1.13.2/package.json'));
    let cookie = '', loginReadable = true;
    try { cookie = readSavedLogin(workerData.app, workerData.data, require); } catch { loginReadable = false; }
    const raw = require(workerData.modulePath || 'NeteaseCloudMusicApi');
    const requestAdapters = await import(pathToFileURL(workerData.adapter).href);
    const sourceIP = workerData.sourceIP ? requestAdapters.validateNeteaseSourceIP(workerData.sourceIP) : '';
    const baseTransform = workerData.modulePath ? requestAdapters.neteaseMaintainedRequest || ((_method, args) => args) : requestAdapters.neteaseWebRequest;
    const transform = (method, args) => baseTransform(method, args, true, sourceIP);
    const result = await probeWebRequests(raw, transform, cookie, { stopOnFailure: Boolean(sourceIP) });
    if (existsSync(resolve(workerData.data, 'app.db')) && !loginReadable) result.candidatePassed = false;
    parentPort.postMessage({ ...result, savedLoginPresent: Boolean(cookie), savedLoginReadable: loginReadable });
  } catch { parentPort.postMessage({ candidatePassed: false, initializationFailed: true }); }
  finally { if (temporary) { try { rmSync(temporary, { recursive: true, force: true }); } catch {} } }
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = resolve(process.argv[2]), adapter = resolve(process.argv[3]);
  const data = resolve(process.env.TSMD_DATA_DIR || resolve(app, 'server-data'));
  const modulePath = process.argv[4] ? resolve(process.argv[4]) : undefined;
  const sourceIP = process.argv[5] || '';
  const worker = new Worker(new URL(import.meta.url), { workerData: { role: 'web-compatibility', app, adapter, data, modulePath, sourceIP }, stdout: true, stderr: true });
  worker.stdout.resume(); worker.stderr.resume();
  try {
    const result = await new Promise(accept => {
      const timer = setTimeout(() => accept({ candidatePassed: false, timedOut: true }), 65000);
      worker.once('message', value => { clearTimeout(timer); accept(value); });
      worker.once('error', () => { clearTimeout(timer); accept({ candidatePassed: false, workerFailed: true }); });
    });
    console.log(JSON.stringify({ kind: 'TS Music Desk music library compatibility check', capturedAt: new Date().toISOString(), mode: sourceIP ? 'maintained-source-ip' : modulePath ? 'maintained' : 'web', actualSourceIPConfigured: Boolean(sourceIP), ...result, accountSecretsIncluded: false }, null, 2));
    if (!result.candidatePassed) process.exitCode = 21;
  } finally { await worker.terminate(); }
}
