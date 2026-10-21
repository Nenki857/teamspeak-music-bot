import { readFileSync, writeFileSync, existsSync, statSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSavedLogin } from './diagnose-music-regression.mjs';

export function officialVerificationUrl(value) {
  if (typeof value !== 'string' || value.length > 16384) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    if (url.hostname !== 'music.163.com' && !url.hostname.endsWith('.music.163.com')) return null;
    return url.href;
  } catch { return null; }
}

// The official encrypt-pages bundle first decodes location.search, then parses
// its query fields. Preserve this two-stage encoding, including '+' and '&' in
// the original challenge. Every field comes from this response; none is guessed.
export function completeVerificationUrl(data) {
  const base = officialVerificationUrl(data?.verifyUrl);
  if (!base || typeof data.verifyToken !== 'string' || !data.verifyToken || data.verifyToken.length > 8192) return null;
  for (const key of ['verifyId', 'verifyType']) if (data[key] === undefined || data[key] === null || data[key] === '' || !Number.isInteger(Number(data[key]))) return null;
  let params;
  try {
    params = typeof data.params === 'string' ? JSON.parse(data.params) : data.params;
    if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
    params = JSON.stringify(params);
    if (params.length > 16384) return null;
  } catch { return null; }
  const url = new URL(base);
  const query = new URLSearchParams(url.search);
  for (const key of ['verifyToken', 'verifyId', 'verifyType']) query.set(key, String(data[key]));
  query.set('params', params);
  for (const key of ['bizKey', 'qrCode']) if (typeof data[key] === 'string' && data[key].length < 8192) query.set(key, data[key]);
  url.search = encodeURIComponent(query.toString());
  return officialVerificationUrl(url.href);
}

export async function requestVerification(api, cookie = '') {
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => api.cloudsearch({ keywords: '音乐', type: 1, limit: 1, ...(cookie ? { cookie } : {}) })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error()), 12000); })
    ]);
    if (result?.status === 200 && result?.body?.code === 200) return { state: 'request-succeeded' };
    return verificationFromFailure(result);
  } catch (error) { return verificationFromFailure(error); }
  finally { clearTimeout(timer); }
}

function verificationFromFailure(error) {
  const body = error?.body || error?.response?.data;
  const url = [-460, -462].includes(body?.code) ? completeVerificationUrl(body?.data) : null;
  return { state: url ? 'verification-available' : 'verification-unavailable', errorCode: Number.isFinite(body?.code) ? body.code : null,
    verifyType: Number.isFinite(body?.data?.verifyType) ? body.data.verifyType : null, ...(url ? { url, contextComplete: true } : { reason: 'no-complete-official-context' }) };
}

export function verificationPage(record, now = Date.now()) {
  if (record?.kind !== 'TS Music Desk official verification page' || record?.state !== 'verification-available' || record.contextComplete !== true) return null;
  const age = now - Date.parse(record.createdAt);
  if (!Number.isFinite(age) || age < -120000 || age > 10 * 60 * 1000) return null;
  const value = officialVerificationUrl(record.url);
  if (!value) return null;
  try {
    const query = new URLSearchParams(decodeURIComponent(new URL(value).search.slice(1)));
    if (!query.get('verifyToken') || !query.has('verifyId') || !query.has('verifyType') || !Number.isInteger(Number(query.get('verifyId'))) || !Number.isInteger(Number(query.get('verifyType')))) return null;
    const params = JSON.parse(query.get('params'));
    if (!params || typeof params !== 'object' || Array.isArray(params)) return null;
  } catch { return null; }
  return value;
}

if (!isMainThread && workerData?.role === 'verification-page') {
  let temporary;
  try {
    temporary = mkdtempSync(resolve(tmpdir(), 'tsmd-official-verification-'));
    const data = resolve(workerData.app, 'server-data');
    const token = resolve(data, 'temp/anonymous_token');
    writeFileSync(resolve(temporary, 'anonymous_token'), existsSync(token) && statSync(token).size <= 65536 ? readFileSync(token) : '', { mode: 0o600 });
    process.env.TMPDIR = temporary; process.env.TMP = temporary; process.env.TEMP = temporary;
    const require = createRequire(resolve(workerData.app, 'vendor/teamspeak-music-bot-1.13.2/package.json'));
    const cookie = readSavedLogin(workerData.app, data, require);
    const maintained = resolve(workerData.app, 'runtime/netease-api-4.41.1/node_modules/@neteasecloudmusicapienhanced/api/main.js');
    const api = require(existsSync(maintained) ? maintained : 'NeteaseCloudMusicApi');
    parentPort.postMessage(await requestVerification(api, cookie));
  } catch { parentPort.postMessage({ state: 'verification-unavailable', collectionFailed: true }); }
  finally { if (temporary) { try { rmSync(temporary, { recursive: true, force: true }); } catch {} } }
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--request') {
    const worker = new Worker(new URL(import.meta.url), { workerData: { role: 'verification-page', app: resolve(process.argv[3]) }, stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume();
    try {
      const result = await new Promise(accept => {
        const timer = setTimeout(() => accept({ state: 'verification-unavailable', timedOut: true }), 18000);
        worker.once('message', value => { clearTimeout(timer); accept(value); });
        worker.once('error', () => { clearTimeout(timer); accept({ state: 'verification-unavailable', collectionFailed: true }); });
      });
      const record = { kind: 'TS Music Desk official verification page', createdAt: new Date().toISOString(), ...result };
      writeFileSync(resolve(process.argv[4]), JSON.stringify(record), { mode: 0o600, flag: 'wx' });
      // The private URL can carry a challenge token. Never print it or raw errors.
      console.log(JSON.stringify({ state: result.state, errorCode: result.errorCode, verifyType: result.verifyType }));
    } finally { await worker.terminate(); }
  } else if (process.argv[2] === '--open') {
    try {
      const record = JSON.parse(readFileSync(resolve(process.argv[3]), 'utf8'));
      if (record.state === 'request-succeeded') console.log('这次服务器搜索已成功，未要求验证；请回到控制台重试。');
      else {
        const url = verificationPage(record);
        if (!url) throw Error();
        const require = createRequire(resolve('vendor/teamspeak-music-bot-1.13.2/package.json'));
        const qrFile = resolve('work/netease-verification-qr.png');
        await require('qrcode').toFile(qrFile, url, { width: 900, margin: 4, errorCorrectionLevel: 'M' });
        const opened = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $env:TSMD_VERIFICATION_FILE'], {
          windowsHide: true, stdio: 'ignore', env: { ...process.env, TSMD_VERIFICATION_FILE: qrFile }
        });
        if (opened.status !== 0) throw Error();
        console.log('已打开包含完整官方验证参数的二维码。请用网易云音乐 App 的扫一扫打开并本人完成验证，然后回控制台重试。');
      }
    } catch { console.error('未取得完整官方验证信息，或二维码未能打开。请告知 Codex，不要反复运行。'); process.exitCode = 1; }
  } else { console.error('Unknown verification operation.'); process.exitCode = 1; }
}
