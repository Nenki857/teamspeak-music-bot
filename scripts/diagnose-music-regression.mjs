import { readFileSync, existsSync, readdirSync, mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, createDecipheriv } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { musicFailure, probeQr } from './diagnose-server-music.mjs';

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
export function compareProgram(app, expected) {
  const changed = [], missing = [];
  for (const [name, digest] of Object.entries(expected)) {
    if (!/^(src\/(server|worker|shared)|vendor\/teamspeak-music-bot-1\.13\.2\/dist)\/.+\.(mjs|js)$/.test(name) || name.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(digest)) throw Error('Invalid reference');
    const file = resolve(app, name);
    if (!existsSync(file)) missing.push(name);
    else if (hash(file) !== digest) changed.push(name);
  }
  return { compared: Object.keys(expected).length, matches: !changed.length && !missing.length, changed, missing };
}

// Use the stored login in memory only. Never instantiate Store (it runs migrations).
export function readSavedLogin(app, data, require) {
  const Database = require('better-sqlite3');
  const db = new Database(resolve(data, 'app.db'), { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get('neteaseCookie');
    if (!row) return '';
    const sealed = JSON.parse(row.value);
    if (!sealed) return '';
    if (typeof sealed !== 'string' || !sealed.startsWith('v1:')) throw Error('Invalid stored login');
    const key = readFileSync(resolve(data, 'server-vault.key'));
    const bytes = Buffer.from(sealed.slice(3), 'base64');
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
  } finally { db.close(); }
}

export async function probeSession(api, cookie = '') {
  const results = [];
  // One request per endpoint, with the current session. No anonymous registration,
  // account changes, retries, IP headers or alternative protocol probing.
  for (const [name, method, params] of [
    ['searchSongs', 'cloudsearch', { keywords: '音乐', type: 1, limit: 1 }],
    ['recommendedPlaylists', 'personalized', { limit: 1 }]
  ]) {
    let timer; const started = Date.now();
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => api[method]({ ...params, ...(cookie ? { cookie } : {}) })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error(), { code: 'ETIMEDOUT' })), 12000); })
      ]);
      results.push({ name, elapsedMs: Date.now() - started, ...(value?.status === 200 && value?.body?.code === 200 ? { ok: true } : musicFailure(value)) });
    } catch (error) { results.push({ name, elapsedMs: Date.now() - started, ...musicFailure(error) }); }
    finally { clearTimeout(timer); }
  }
  return results;
}

function serviceContext(app) {
  const command = spawnSync('systemctl', ['show', 'ts-music-desk.service', '-p', 'ActiveState', '-p', 'SubState', '-p', 'MainPID', '-p', 'ExecMainStartTimestamp', '-p', 'NRestarts', '-p', 'KillMode'], { encoding: 'utf8', timeout: 5000 });
  if (command.status !== 0) throw Error('Service information unavailable');
  const fields = Object.fromEntries(command.stdout.trim().split('\n').map(line => { const pos = line.indexOf('='); return [line.slice(0, pos), line.slice(pos + 1)]; }));
  const pid = Number(fields.MainPID);
  if (!Number.isInteger(pid) || pid <= 0) throw Error('Music service has no running process');
  // Read only the relevant service environment. Never serialize this object.
  const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map(line => { const pos = line.indexOf('='); return [line.slice(0, pos), line.slice(pos + 1)]; }));
  const data = resolve(env.TSMD_DATA_DIR || resolve(app, 'server-data'));
  const inheritedTemp = env.TMPDIR || resolve(data, 'temp');
  const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  return { data, inheritedTemp, report: {
    active: fields.ActiveState === 'active', state: String(fields.SubState).replace(/[^a-z-]/g, '').slice(0, 40),
    startedAt: String(fields.ExecMainStartTimestamp).replace(/[^a-zA-Z0-9 :+.-]/g, '').slice(0, 80),
    restarts: Number(fields.NRestarts) || 0, pid, backgroundService: fields.KillMode === 'control-group',
    entryMatches: cmdline.some(arg => arg === resolve(app, 'src/server/entry.mjs')),
    sessionFixEnabled: env.TSMD_NETEASE_SESSION_FIX === '1', dataDirectoryIsDefault: data === resolve(app, 'server-data'),
    tmpdirOverride: Boolean(env.TMPDIR)
  } };
}

if (!isMainThread && workerData?.role === 'regression-session') {
  let temporary;
  try {
    temporary = mkdtempSync(resolve(tmpdir(), 'tsmd-session-check-'));
    const token = resolve(workerData.temp, 'anonymous_token');
    const bytes = existsSync(token) && statSync(token).size <= 65536 ? readFileSync(token) : Buffer.alloc(0);
    // Copy into a disposable directory; leave the live token untouched.
    writeFileSync(resolve(temporary, 'anonymous_token'), bytes, { mode: 0o600 });
    process.env.TMPDIR = temporary; process.env.TMP = temporary; process.env.TEMP = temporary;
    const require = createRequire(resolve(workerData.app, 'vendor/teamspeak-music-bot-1.13.2/package.json'));
    let cookie = '', login;
    try { cookie = readSavedLogin(workerData.app, workerData.data, require); login = { readable: true, present: Boolean(cookie) }; }
    catch { login = { readable: false, present: null }; }
    const api = require('NeteaseCloudMusicApi');
    const savedSession = login.readable && cookie ? await probeSession(api, cookie) : null;
    const anonymousSession = await probeSession(api);
    const qr = await probeQr(api);
    parentPort.postMessage({ anonymousTokenPresent: Boolean(bytes.length), login, savedSession, anonymousSession, qr });
  } catch { parentPort.postMessage({ failed: true }); }
  finally { if (temporary) { try { rmSync(temporary, { recursive: true, force: true }); } catch {} } }
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let worker;
  try {
    const app = resolve(process.argv[2]), expected = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    const context = serviceContext(app);
    const program = compareProgram(app, expected.files);
    const runtime = resolve(app, 'runtime');
    const backups = readdirSync(runtime).filter(name => /^code-backup-[A-Za-z0-9]+$/.test(name)).map(name => ({ name, time: statSync(join(runtime, name)).mtime.toISOString(), workerMatches: (() => { try { return hash(join(runtime, name, 'src/worker/music-worker-entry.mjs')) === expected.files['src/worker/music-worker-entry.mjs']; } catch { return false; } })() })).slice(-12);
    worker = new Worker(new URL(import.meta.url), { workerData: { role: 'regression-session', app, data: context.data, temp: context.inheritedTemp }, stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume();
    const sessions = await new Promise(accept => {
      const timer = setTimeout(() => accept({ timedOut: true }), 65000);
      worker.once('message', value => { clearTimeout(timer); accept(value); });
      worker.once('error', () => { clearTimeout(timer); accept({ failed: true }); });
    });
    console.log(JSON.stringify({ kind: 'TS Music Bot music regression check', capturedAt: new Date().toISOString(), referenceCapturedAt: expected.capturedAt, service: context.report, program, backups, sessions, accountSecretsIncluded: false, installedFilesChanged: false }, null, 2));
    if (sessions.failed || sessions.timedOut) process.exitCode = 1;
  } catch { console.error('Regression check could not complete. No service, installed files or login data were changed.'); process.exitCode = 1; }
  finally { if (worker) await worker.terminate(); }
}
