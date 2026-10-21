import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { setAdminPassword, AdminAuthority } from './admin-auth.mjs';
import { serverVaultKey } from './vault-key.mjs';
import { createVault } from '../shared/security.mjs';
import { PersistentShareAuthority } from './persistent-shares.mjs';
import { NeteaseOfficialBrowser } from './netease-official-browser.mjs';

// The server uses the same official website session for metadata and playback URLs.
process.env.TSMD_SERVER_EDITION = '1';
process.env.TSMD_NETEASE_WEB_CLIENT ??= '1';

const directory = resolve(process.env.TSMD_DATA_DIR || fileURLToPath(new URL('../../server-data/', import.meta.url)));
process.env.TSMD_DATA_DIR = directory;
if (process.platform !== 'win32') process.umask(0o077);
mkdirSync(directory, { recursive: true, mode: 0o700 });
if (process.platform !== 'win32') chmodSync(directory, 0o700);
const accountFile = resolve(directory, 'server-admin.json');
if (process.argv.includes('--init')) {
  if (!process.stdout.isTTY) throw new Error('请在自己的交互式终端运行 --init，以免登录密码写入自动化日志');
  if (existsSync(accountFile)) throw new Error('主人密码已设置；如需重置，请先停止服务并使用 --reset-password');
  const password = randomBytes(18).toString('base64url');
  serverVaultKey(directory); await setAdminPassword(accountFile, password);
  console.log(`主人登录密码（请妥善保存）：${password}\n控制台地址：http://127.0.0.1:${process.env.TSMD_PORT || 18080}/admin`);
} else if (process.argv.includes('--reset-password')) {
  if (!process.stdout.isTTY) throw new Error('请在自己的交互式终端重置密码');
  if (!existsSync(accountFile)) throw new Error('请先使用 --init 初始化');
  const password = randomBytes(18).toString('base64url'); await setAdminPassword(accountFile, password);
  console.log(`新的主人登录密码（重启服务后生效）：${password}`);
} else {
  if (!existsSync(accountFile)) throw new Error('请先运行 node src/server/entry.mjs --init 设置主人登录密码');
  const key = serverVaultKey(directory); const admin = new AdminAuthority(accountFile);
  const [{ Service }, { IsolatedCore }, { createShareServer }, { Tunnel, FixedPublicEndpoint }] = await Promise.all([
    import('../worker/service.mjs'), import('../worker/core-host.mjs'), import('../worker/share-server.mjs'), import('../worker/tunnel.mjs')
  ]);
  let server; let friends; let service; let closing = false; let debounce;
  const shutdown = async (exitCode = 0) => {
    if (closing) return; closing = true; clearTimeout(debounce); clearInterval(heartbeat);
    const deadline = setTimeout(() => process.exit(1), 5000);
    try { friends?.close(); server?.close(); admin.close(); await service?.close(); }
    catch { exitCode = 1; }
    finally { clearTimeout(deadline); process.exitCode = exitCode; }
  };
  const changed = () => { clearTimeout(debounce); debounce = setTimeout(() => { if (!closing && service?.ready) { server?.broadcast(); friends?.broadcast(); } }, 80); };
  const heartbeat = setInterval(changed, 1500); heartbeat.unref();
  process.on('SIGTERM', () => shutdown()); process.on('SIGINT', () => shutdown());
  try {
    const audioBackend=process.env.TSMD_AUDIO_BACKEND||'custom';
    if(!['custom','official'].includes(audioBackend))throw new Error('TSMD_AUDIO_BACKEND 无效');
    service = new Service(createVault(key), changed, {
      createCore: (_store, _vault, onChange, onDisconnect) => new IsolatedCore({ key, dataDirectory: directory, onChange, onDisconnect, onFailure: () => shutdown(1), ...(audioBackend==='official'?{engineModule:new URL('./official-core-engine.mjs',import.meta.url).href}:{}) }),
      createTunnel: onChange => process.env.TSMD_PUBLIC_URL ? new FixedPublicEndpoint(onChange, process.env.TSMD_PUBLIC_URL) : new Tunnel(onChange),
      ...(process.env.TSMD_PUBLIC_URL && process.env.TSMD_PERSISTENT_SHARES === '1' ? { createAuthority: (store, vault) => new PersistentShareAuthority(store, vault) } : {})
    });
    service.runtime = { deployment: 'server', audioBackend, musicTransport: process.env.TSMD_NETEASE_WEB_CLIENT === '1' ? 'web-session' : 'legacy-api', dataDirectory: directory, persistentShares: service.authority instanceof PersistentShareAuthority, friendOnlyEndpoint: Boolean(process.env.TSMD_FRIEND_PORT) };
    const browserExecutable = fileURLToPath(new URL('../../runtime/official-browser/chrome-linux64/chrome', import.meta.url));
    service.runtime.officialBrowserLogin = process.platform === 'linux' && existsSync(browserExecutable);
    if (service.runtime.officialBrowserLogin) service.browserLogin = new NeteaseOfficialBrowser({ executable: browserExecutable, profileDirectory: resolve(directory, 'netease-official-browser') });
    await service.init();
    const port = Number(process.env.TSMD_PORT || 18080); const host = process.env.TSMD_HOST || '127.0.0.1';
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('TSMD_PORT 无效');
    const resources = process.platform === 'linux' ? (await import('./host-resources.mjs')).createLinuxHostMonitor() : null;
    service.runtime.serverResources = Boolean(resources);
    server = await createShareServer(service, { host, port, admin, persistentInvites: service.runtime.persistentShares, resources: resources ? () => resources.sample() : undefined, trustProxy: host === '127.0.0.1', publicEnabled: () => service.phase === 'running' && service.tunnel.state.status === 'online' });
    if (process.env.TSMD_FRIEND_PORT) {
      const friendPort = Number(process.env.TSMD_FRIEND_PORT);
      if (!process.env.TSMD_PUBLIC_URL || !Number.isInteger(friendPort) || friendPort < 1 || friendPort > 65535 || friendPort === port) throw new Error('TSMD_FRIEND_PORT 无效');
      friends = await createShareServer(service, { host: '127.0.0.1', port: friendPort, resources: resources ? () => resources.sample() : undefined, trustProxy: true, persistentInvites: service.runtime.persistentShares, publicEnabled: () => service.phase === 'running' && service.tunnel.state.status === 'online' });
    }
    console.log(`TS Music Bot 后台已启动：${host}:${server.port}；主人控制台 /admin`);
    if (process.env.TSMD_AUTOSTART !== '0' && service.store.get('defaultPreset')) {
      try { await service.rpc('bot.start', { id: service.store.get('defaultPreset') }); }
      catch { console.error('自动连接 TS 未完成，后台继续运行，请在主人控制台检查预设后重试。'); }
    }
  } catch { console.error('服务器启动或自动连接失败，请检查部署环境；不会输出账号凭据。'); await shutdown(1); }
}
