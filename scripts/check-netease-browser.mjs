import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { musicFailure } from './diagnose-server-music.mjs';

// This is a login bootstrap check, not a claim that search/playback has recovered.
// A normal web login needs one human confirmation before account requests can be
// checked. Create one disposable key, poll it once, and never log its contents.
export async function checkBrowserLogin(api) {
  let key;
  try {
    const response = await api.login_qr_key({}); key = response?.body?.data?.unikey;
    if (response?.status !== 200 || response?.body?.code !== 200 || typeof key !== 'string' || !key) return { candidatePassed: false, stage: 'request-key', ...musicFailure(response) };
  } catch (error) { return { candidatePassed: false, stage: 'request-key', ...musicFailure(error) }; }
  try {
    const image = await api.login_qr_create({ key, qrimg: true });
    if (typeof image?.body?.data?.qrimg !== 'string' || !image.body.data.qrimg.startsWith('data:image/')) return { candidatePassed: false, stage: 'create-image' };
    const waiting = await api.login_qr_check({ key });
    if (waiting?.status !== 200 || ![801, 802].includes(waiting?.body?.code)) return { candidatePassed: false, stage: 'scan-waiting', ...musicFailure(waiting) };
    return { candidatePassed: true, stage: 'awaiting-user-login', qrKeyReceived: true, qrImageGenerated: true, scanWaitingVerified: true, searchVerified: false, playbackVerified: false };
  } catch (error) { return { candidatePassed: false, stage: 'scan-waiting', ...musicFailure(error) }; }
}

if (!isMainThread && workerData?.role === 'normal-web-login-check') {
  try {
    const { createNeteaseBrowserApi } = await import(pathToFileURL(workerData.adapter).href);
    const requireCore = createRequire(resolve(workerData.app, 'vendor/teamspeak-music-bot-1.13.2/package.json'));
    const api = createNeteaseBrowserApi({ requireLibrary: createRequire(requireCore.resolve('NeteaseCloudMusicApi')) });
    parentPort.postMessage(await checkBrowserLogin(api));
  } catch { parentPort.postMessage({ candidatePassed: false, initializationFailed: true }); }
} else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const worker = new Worker(new URL(import.meta.url), { workerData: { role: 'normal-web-login-check', app: resolve(process.argv[2]), adapter: resolve(process.argv[3]) }, stdout: true, stderr: true });
  worker.stdout.resume(); worker.stderr.resume();
  try {
    const result = await new Promise(accept => {
      const timer = setTimeout(() => accept({ candidatePassed: false, timedOut: true }), 60000);
      worker.once('message', value => { clearTimeout(timer); accept(value); });
      worker.once('error', () => { clearTimeout(timer); accept({ candidatePassed: false, workerFailed: true }); });
    });
    console.log(JSON.stringify({ kind: 'TS Music Desk normal web login check', capturedAt: new Date().toISOString(), mode: 'browser', ...result, accountDataRead: false, accountSecretsIncluded: false }, null, 2));
    if (!result.candidatePassed) process.exitCode = 21;
  } finally { await worker.terminate(); }
}
