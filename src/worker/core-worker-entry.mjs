import { parentPort, workerData } from 'node:worker_threads';
import { createVault } from '../shared/security.mjs';
import { Store } from './store.mjs';
import { safeError } from './core-engine.mjs';

const ALLOWED = new Set(['start', 'stop', 'removeBot', 'channels', 'setQuality', 'qr', 'qrCheck', 'refreshAuth', 'importCookie', 'acceptOfficialLogin', 'logout', 'command', 'exportQueue', 'sendShareAnnouncement', 'announcementTarget']);
const CONFIGURATION_METHODS = new Set(['setQuality', 'qrCheck', 'refreshAuth', 'importCookie', 'acceptOfficialLogin', 'logout']);
let core; let store; let ready = false; let closing = false; let debounce; let timer; let lastRevision;
function state() {
  const player = core.status({ includeQueue: false });
  const queueKey = `${player.revision}:${player.queueSize || 0}`;
  // Long queues are cloned only after a queue/track revision, not on every clock update.
  if (lastRevision !== queueKey) { player.queue = core.status().queue; lastRevision = queueKey; }
  return { player, auth: core.auth || { loggedIn: false }, audioHealth: { ...core.health(), isolatedCore: true, directCatalog: true } };
}
function changed(event) {
  if (closing) return;
  if (event?.channelJoin) { parentPort.postMessage({ type: 'channelJoin', event: event.channelJoin }); return; }
  if (event?.diagnostic) parentPort.postMessage({ type: 'diagnostic', diagnostic: event.diagnostic });
  clearTimeout(debounce); debounce = setTimeout(() => { if (ready && !closing) parentPort.postMessage({ type: 'state', state: state(), notify: true }); }, 30);
}
async function close() {
  if (closing) return;
  closing = true; clearTimeout(debounce); clearInterval(timer);
  try { await core?.close(); } finally { store?.close(); parentPort.postMessage({ type: 'closed' }); parentPort.close(); }
}
const initialized = (async () => {
  try {
    if (process.env.TSMD_DATA_DIR !== workerData.dataDirectory) throw new Error('Invalid core data directory');
    const vault = createVault(Buffer.from(workerData.key)); store = new Store(vault);
    const { CoreEngine } = await import(workerData.engineModule || './core-engine.mjs');
    core = new CoreEngine(store, vault, changed, () => { if (!closing) parentPort.postMessage({ type: 'disconnected' }); });
    await core.init(); await core.provider.attachCatalogPort(workerData.catalogPort); ready = true;
    parentPort.postMessage({ type: 'ready', state: state() });
    timer = setInterval(() => { if (!closing) parentPort.postMessage({ type: 'state', state: state(), notify: false }); }, 1000);
  } catch {
    try { await core?.close(); } catch {}
    try { store?.close(); } catch {}
    workerData.catalogPort?.close();
    parentPort.postMessage({ type: 'fatal' }); parentPort.close(); throw new Error('Playback worker initialization failed');
  }
})();
initialized.catch(() => {});
parentPort.on('message', async message => {
  if (message.type === 'close') { await initialized.catch(() => {}); await close(); return; }
  if (message.type !== 'call' || closing) return;
  try {
    await initialized;
    if (closing || !ALLOWED.has(message.method)) throw new Error('播放操作不可用');
    const result = await core[message.method](...message.args);
    if (CONFIGURATION_METHODS.has(message.method)) await core.provider.flushConfiguration();
    parentPort.postMessage({ type: 'reply', id: message.id, ok: true, result, state: state() });
  } catch (error) { parentPort.postMessage({ type: 'reply', id: message.id, ok: false, error: safeError(error), state: ready && !closing ? state() : undefined }); }
});
