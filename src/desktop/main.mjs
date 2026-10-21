import { app, BrowserWindow, ipcMain, safeStorage, Tray, Menu, nativeImage, clipboard, shell, screen } from 'electron';
import { fork } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolveDataDirectory } from './storage-path.mjs';
import { loadWindowState, rememberWindowState } from './window-state.mjs';
import { createResourceMonitor } from './resource-monitor.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// The control UI does not need GPU acceleration; software rendering also works on remote desktops.
app.disableHardwareAcceleration();
if (process.env.TSMD_HEADLESS_CHECK === '1') app.commandLine.appendSwitch('in-process-gpu');
const data = resolveDataDirectory({ packaged: app.isPackaged, projectRoot: root, appData: app.getPath('appData'), override: process.env.TSMD_DATA_DIR }); mkdirSync(data, { recursive: true });
if (process.platform === 'win32') app.setAppUserModelId('local.tsmusicdesk.app');
const logDir = resolve(data, 'logs'); mkdirSync(logDir, { recursive: true });
const diagnostic = message => { try { appendFileSync(resolve(logDir, 'desktop-startup.log'), `${new Date().toISOString()} ${String(message).slice(0, 400)}\n`); } catch {} };
diagnostic('Desktop startup');
app.on('render-process-gone', (_event, _contents, detail) => diagnostic(`Renderer stopped: ${detail.reason} ${detail.exitCode}`));
app.on('child-process-gone', (_event, detail) => diagnostic(`Child stopped: ${detail.type} ${detail.reason} ${detail.exitCode}`));
app.setPath('userData', resolve(data, 'desktop-profile'));
app.setPath('logs', resolve(data, 'logs'));
const single = app.requestSingleInstanceLock(); if (!single) { app.quit(); }
let window; let windowPreferences; let tray; let worker; let quitting = false; let state = { ready: false, phase: 'initializing', presets: [], grants: [], player: {}, auth: {} }; const pending = new Map();
const resources = createResourceMonitor();
const methods = new Set(['status', 'presets.save', 'presets.remove', 'presets.default', 'bot.start', 'bot.stop', 'bot.channels', 'auth.qr', 'auth.check', 'auth.refresh', 'auth.logout', 'settings.quality', 'music.search', 'music.lyrics', 'music.artist', 'music.add', 'music.playNow', 'playlists.list', 'playlist.detail', 'playlist.play', 'playlist.publish', 'playlist.unpublish', 'playlist.saveQueue', 'playlist.import', 'playlist.delete', 'player.next', 'player.prev', 'player.pause', 'player.resume', 'player.stop', 'player.volume', 'player.seek', 'player.mode', 'queue.remove', 'queue.clear', 'queue.move', 'queue.play', 'sharing.enable', 'sharing.disable', 'sharing.create', 'sharing.revoke', 'sharing.permissions', 'sharing.announce', 'sharing.send', 'sharing.auto', 'sharing.autoRetry', 'identity.set', 'identity.history', 'identity.remove', 'music.users', 'music.userPlaylists', 'playlist.preview', 'playlist.share', 'playlist.create', 'playlist.update', 'playlists.targets', 'playlist.addSong']);
function publish(next) { state = next; if (window && !window.isDestroyed()) window.webContents.send('music:state', next); }
function rpc(method, args = {}) {
  if (!worker?.connected) return Promise.reject(new Error('机器人服务没有运行，请重新打开工具'));
  return new Promise((resolveReply, reject) => {
    const id = randomUUID(); const timer = setTimeout(() => { pending.delete(id); reject(new Error('操作超时，请重试')); }, 65000);
    pending.set(id, { resolve: resolveReply, reject, timer }); worker.send({ type: 'rpc', id, method, args });
  });
}
function startWorker() {
  const keyPath = resolve(data, 'vault.key'); let key;
  const isolatedTest = process.env.TSMD_HEADLESS_CHECK === '1' && data.startsWith(resolve(root, 'work') + '\\') && process.env.TSMD_TEST_KEY;
  if (isolatedTest) key = process.env.TSMD_TEST_KEY;
  else {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows 凭据加密不可用。请从资源管理器双击启动工具，以当前 Windows 用户运行。');
    if (existsSync(keyPath)) key = safeStorage.decryptString(readFileSync(keyPath));
    else { key = randomBytes(32).toString('base64'); writeFileSync(keyPath, safeStorage.encryptString(key)); }
  }
  const logDir = resolve(data, 'logs'); mkdirSync(logDir, { recursive: true });
  worker = fork(resolve(root, 'src/worker/entry.mjs'), [], { execPath: resolve(root, 'resources/node/node.exe'), cwd: data, env: { ...process.env, TSMD_DATA_DIR: data }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  // Upstream output is not retained: music endpoints can log signed media URLs.
  worker.stdout.on('data', () => {}); worker.stderr.on('data', () => {});
  worker.on('message', message => {
    if (message.type === 'reply') { const waiter = pending.get(message.id); if (waiter) { clearTimeout(waiter.timer); pending.delete(message.id); if (message.ok) waiter.resolve(message.result); else waiter.reject(new Error(message.error)); } }
    else if (message.type === 'state' || message.type === 'ready') publish(message.state);
    else if (message.type === 'fatal') publish({ ...state, ready: false, phase: 'error', error: message.error });
  });
  worker.on('error', error => publish({ ...state, ready: false, phase: 'error', error: '本地服务启动失败：' + error.message }));
  worker.on('exit', () => { for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('本地服务已关闭')); } pending.clear(); if (!quitting) publish({ ...state, ready: false, phase: 'error', error: '本地服务已停止，请退出并重新打开工具' }); });
  worker.send({ type: 'init', key });
}
function showWindow() { if (process.env.TSMD_HEADLESS_CHECK === '1') return; if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } }
function createWindow() {
  const preferencesFile = resolve(data, 'window-state.json');
  const restored = loadWindowState(preferencesFile, screen.getAllDisplays().map(display => display.workArea), screen.getPrimaryDisplay().workArea);
  window = new BrowserWindow({
    ...restored.bounds, minWidth: restored.minWidth, minHeight: restored.minHeight, show: false,
    backgroundColor: '#0d1018', title: 'TS Music Desk · 音乐机器人', icon: resolve(root, 'resources/app.ico'), autoHideMenuBar: true,
    titleBarStyle: 'hidden', titleBarOverlay: { color: '#0d1018', symbolColor: '#a4aec0', height: 64 },
    webPreferences: { preload: resolve(root, 'src/desktop/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
  });
  windowPreferences = rememberWindowState(window, preferencesFile, restored, () => diagnostic('Window preferences could not be saved'));
  window.on('hide', () => resources.reset()); window.on('minimize', () => resources.reset());
  window.loadFile(resolve(root, 'dist/ui/index.html'));
  window.webContents.on('did-fail-load', (_event, code, description) => diagnostic(`UI load failed: ${code} ${description}`));
  window.once('ready-to-show', () => { if (restored.maximized && process.env.TSMD_HEADLESS_CHECK !== '1') window.maximize(); showWindow(); });
  window.on('close', event => { if (!quitting && tray) { event.preventDefault(); window.hide(); } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  const icon = nativeImage.createFromPath(resolve(root, 'resources/app.ico'));
  tray = new Tray(icon); tray.setToolTip('TS Music Desk · 关闭窗口后继续运行');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开音乐控制台', click: showWindow }, { type: 'separator' }, { label: '停止机器人并退出', click: () => app.quit() }])); tray.on('double-click', showWindow);
}
ipcMain.handle('music:rpc', async (event, method, args) => { if (event.sender !== window?.webContents || !methods.has(method)) throw new Error('操作不可用'); if (method === 'status') return state; return rpc(method, args); });
ipcMain.handle('music:resources', event => {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('操作不可用');
  if (quitting || !window.isVisible() || window.isMinimized()) { resources.reset(); return { paused: true }; }
  return resources.sample();
});
ipcMain.handle('music:copy', (event, text) => { if (event.sender !== window?.webContents || typeof text !== 'string' || text.length > 3000) return false; clipboard.writeText(text); return true; });
ipcMain.handle('music:open-data', event => { if (event.sender === window?.webContents) shell.openPath(data); });
ipcMain.handle('music:open-link', (event, url) => { if (event.sender !== window?.webContents) return; const allowed = state.grants?.some(g => g.url === url || g.localUrl === url); if (allowed) return shell.openExternal(url); });
ipcMain.handle('music:quit', event => { if (event.sender === window?.webContents) app.quit(); });
app.on('second-instance', showWindow); app.on('activate', showWindow);
app.on('before-quit', event => {
  if (quitting) return; event.preventDefault(); quitting = true;
  windowPreferences?.save();
  if (!worker?.connected) { app.quit(); return; }
  worker.once('exit', () => app.quit()); worker.send({ type: 'shutdown' });
  setTimeout(() => { if (worker && !worker.killed) worker.kill(); app.quit(); }, 5000).unref();
});
app.whenReady().then(() => { if (!single) return; createWindow(); try { startWorker(); } catch (error) { diagnostic('Worker bootstrap failed: ' + error.message); publish({ ...state, phase: 'error', error: error.message }); } }).catch(error => diagnostic('Desktop bootstrap failed: ' + error.message));
