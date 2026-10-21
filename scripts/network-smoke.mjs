import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
process.env.TSMD_DATA_DIR = resolve('work/network-test-' + randomUUID());
const { Service } = await import('../src/worker/service.mjs');
const { createVault } = await import('../src/shared/security.mjs');
const { createShareServer } = await import('../src/worker/share-server.mjs');
const service = new Service(createVault(randomBytes(32)), () => {}); let server;
try {
  await service.init(); server = await createShareServer(service);
  try { const data = await service.rpc('music.search', { query: '晴天' }); console.log('NetEase search:', data.songs.length, 'songs'); } catch (error) { console.log('NetEase search:', error.message); }
  try { const qr = await service.rpc('auth.qr'); console.log('NetEase QR:', qr.qrImg?.startsWith('data:image/') ? 'available' : 'unavailable'); } catch (error) { console.log('NetEase QR:', error.message); }
  try {
    const tunnel = await service.tunnel.start(server.port); console.log('Quick Tunnel:', tunnel.status);
    const response = await fetch(tunnel.url, { signal: AbortSignal.timeout(15000) });
    console.log('Public page:', response.status, (await response.text()).includes('TS Music Bot'));
  } catch (error) { console.log('Quick Tunnel:', error.message); }
} finally { server?.close(); service.close(); }
