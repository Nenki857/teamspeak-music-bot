import { createVault } from '../shared/security.mjs';
import { Service } from './service.mjs';
import { createShareServer } from './share-server.mjs';
import { safeError } from './core-engine.mjs';
import { containChildProcesses } from './windows-job.mjs';
import { IsolatedCore } from './core-host.mjs';
import { dataDir } from './paths.mjs';
containChildProcesses();
let service; let server; let closing = false; let debounce;
const readOnly = new Set(['status', 'music.search', 'music.artist', 'playlists.list', 'playlist.detail', 'music.users', 'music.userPlaylists', 'playlist.preview']);
const send = value => { if (process.connected) process.send(value); };
const changed = () => { clearTimeout(debounce); debounce = setTimeout(() => { if (!closing && service?.ready) { send({ type: 'state', state: service.snapshot() }); server?.broadcast(); } }, 80); };
process.on('message', async message => {
  if (message.type === 'init') {
    try { const key = Buffer.from(message.key, 'base64'); service = new Service(createVault(key), changed, { createCore: (_store, _vault, onChange, onDisconnect) => new IsolatedCore({ key, dataDirectory: dataDir, onChange, onDisconnect, onFailure: () => shutdown() }) }); await service.init(); server = await createShareServer(service, { trustProxy: true }); send({ type: 'ready', state: service.snapshot(), port: server.port }); }
    catch (error) { send({ type: 'fatal', error: safeError(error) }); }
  } else if (message.type === 'rpc') {
    try { send({ type: 'reply', id: message.id, ok: true, result: await service.rpc(message.method, message.args, { owner: true }, message.id) }); if (!readOnly.has(message.method)) changed(); }
    catch (error) { send({ type: 'reply', id: message.id, ok: false, error: safeError(error) }); if (!readOnly.has(message.method)) changed(); }
  } else if (message.type === 'shutdown') shutdown();
});
async function shutdown() { if (closing) return; closing = true; clearTimeout(debounce); const deadline = setTimeout(() => process.exit(0), 4000); try { server?.close(); await service?.close(); } catch {} finally { clearTimeout(deadline); setTimeout(() => process.exit(0), 50); } }
process.on('disconnect', shutdown); process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
setInterval(() => { if (service?.ready && !closing) changed(); }, 1500).unref();
