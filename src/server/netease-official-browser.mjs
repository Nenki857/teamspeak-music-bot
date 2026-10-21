import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const WIDTH = 1366, HEIGHT = 900;
const HOME = 'https://music.163.com/';
const pause = ms => new Promise(accept => setTimeout(accept, ms));
const hasMusicSession = cookies => (cookies || []).some(item => item.name === 'MUSIC_U' && ['music.163.com', '.music.163.com'].includes(item.domain) && item.path === '/' && typeof item.value === 'string' && item.value.length >= 8);
// Only display data from the official music origin is read. The passport may
// finish in a same-origin child frame before the top-level page refreshes.
const PAGE_LOGIN = `(()=>{
  let profile=null,redirecting=false;
  const visit=(w,depth)=>{try{
    if(w.location.origin!=='https://music.163.com')return;
    const u=w.GUser;
    if(!profile&&u&&/^\\d{1,20}$/.test(String(u.userId))&&Number(u.userId)>0)profile={id:String(u.userId),nickname:String(u.nickname||'').slice(0,160),avatarUrl:String(u.avatarUrl||'').slice(0,2048)};
    if(/请稍[后候].{0,12}正在跳转/.test((w.document.body?.innerText||'').slice(0,20000)))redirecting=true;
    if(depth<2)for(let i=0;i<Math.min(w.frames.length,8);i++)visit(w.frames[i],depth+1);
  }catch{}};
  visit(globalThis,0);
  return {profile,redirecting,readyState:document.readyState};
})()`;
export function officialBrowserUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' && (url.hostname === 'music.163.com' || url.hostname.endsWith('.163.com') || url.hostname.endsWith('.126.net')); } catch { return false; }
}

export function browserLoginSession(cookies, profile) {
  if (!profile || !/^\d{1,20}$/.test(String(profile.id)) || Number(profile.id) <= 0) throw Error('官网尚未确认登录，请在网页中完成登录后重试');
  const fields = new Map();
  for (const item of cookies || []) {
    if (!['music.163.com', '.music.163.com'].includes(item.domain) || item.path !== '/') continue;
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(item.name) || typeof item.value !== 'string' || /[\x00-\x20\x7f-\uffff;]/.test(item.value)) continue;
    fields.set(item.name, item.value.replaceAll(',', '%2C'));
  }
  if (!fields.get('MUSIC_U') || fields.get('MUSIC_U').length < 8) throw Error('官网尚未返回登录会话，请确认已在手机上同意登录');
  return { cookie: [...fields].map(([key, value]) => `${key}=${value}`).join('; '), auth: { loggedIn: true, nickname: String(profile.nickname || '网易云用户').slice(0, 160), avatarUrl: /^https:\/\//.test(profile.avatarUrl || '') ? String(profile.avatarUrl).slice(0, 2048) : '' } };
}

export class NeteaseOfficialBrowser {
  constructor({ executable, profileDirectory, createSocket, spawnImpl = spawn }) {
    this.executable = executable; this.profileDirectory = resolve(profileDirectory);
    this.createSocket = createSocket || (url => new WebSocket(url));
    this.spawnImpl = spawnImpl; this.pending = new Map(); this.nextId = 0; this.networkIssues = [];
  }
  observe(message) {
    if (message.sessionId !== this.sessionId) return;
    const params = message.params || {}; let issue;
    if (message.method === 'Network.responseReceived' && ['Document', 'XHR', 'Fetch'].includes(params.type) && officialBrowserUrl(params.response?.url) && params.response.status >= 400) {
      issue = { type: 'http-error', status: Math.trunc(params.response.status) };
    } else if (message.method === 'Network.loadingFailed' && ['Document', 'XHR', 'Fetch'].includes(params.type) && !params.canceled && params.errorText !== 'net::ERR_ABORTED') {
      issue = { type: 'network-error', code: /^net::ERR_[A-Z0-9_]{1,64}$/.test(params.errorText || '') ? params.errorText : 'unavailable' };
    } else if (message.method === 'Network.responseReceivedExtraInfo' && params.blockedCookies?.length) {
      const reasons = [...new Set(params.blockedCookies.flatMap(item => item.blockedReasons || []).filter(reason => /^[A-Za-z]{1,80}$/.test(reason)))].slice(0, 10);
      if (reasons.length) issue = { type: 'cookie-blocked', reasons };
    }
    if (issue) { this.networkIssues.push({ time: Date.now(), ...issue }); this.networkIssues = this.networkIssues.slice(-12); }
  }
  recentNetworkIssues() { return this.networkIssues.filter(issue => Date.now() - issue.time < 120000); }
  send(method, params = {}, sessionId, timeoutMs = 12000) {
    if (!this.socket || this.socket.readyState !== 1) return Promise.reject(Error('官网浏览器已关闭，请重新打开'));
    return new Promise((accept, reject) => {
      const id = ++this.nextId, timer = setTimeout(() => { this.pending.delete(id); reject(Error('官网浏览器响应超时，请刷新页面后重试')); }, timeoutMs);
      this.pending.set(id, { accept, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(Error('官网浏览器连接已断开')); }
    });
  }
  touch() { clearTimeout(this.idle); this.idle = setTimeout(() => this.close(), 10 * 60 * 1000); this.idle.unref?.(); }
  async start() {
    if (this.starting) return this.starting;
    if (this.sessionId && this.child?.exitCode === null) return this.frame();
    this.starting = this.launch();
    try { return await this.starting; } finally { this.starting = null; }
  }
  async launch() {
    mkdirSync(this.profileDirectory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(this.profileDirectory, 0o700);
    const activePort = resolve(this.profileDirectory, 'DevToolsActivePort'); rmSync(activePort, { force: true });
    this.child = this.spawnImpl(this.executable, ['--headless=new', '--disable-gpu', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${this.profileDirectory}`, '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', `--window-size=${WIDTH},${HEIGHT}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
    let failed = false; this.child.once('error', () => { failed = true; });
    try {
      let port, path;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (failed || this.child.exitCode !== null) throw Error('服务器浏览器启动失败，请检查浏览器组件与系统依赖');
        try { const parts = readFileSync(activePort, 'utf8').trim().split('\n'); if (/^\d{1,5}$/.test(parts[0]) && Number(parts[0]) < 65536 && /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(parts[1])) { port = parts[0]; path = parts[1]; break; } } catch {}
        await pause(100);
      }
      if (!port) throw Error('服务器浏览器未能就绪，请检查浏览器组件；不会自动关闭浏览器沙箱');
      this.socket = this.createSocket(`ws://127.0.0.1:${port}${path}`);
      await new Promise((accept, reject) => { const timer = setTimeout(() => reject(Error('官网浏览器连接超时')), 5000); this.socket.addEventListener('open', () => { clearTimeout(timer); accept(); }, { once: true }); this.socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('官网浏览器连接失败')); }, { once: true }); });
      this.socket.addEventListener('message', event => {
        if (typeof event.data !== 'string' || event.data.length > 8 * 1024 * 1024) { this.socket.close(); return; }
        let message; try { message = JSON.parse(event.data); } catch { return; }
        if (message.method) { this.observe(message); return; }
        const task = this.pending.get(message.id); if (!task) return;
        clearTimeout(task.timer); this.pending.delete(message.id);
        if (message.error) task.reject(Error('官网浏览器操作未完成，请刷新截图后重试')); else task.accept(message.result);
      });
      this.socket.addEventListener('close', () => { for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(Error('官网浏览器连接已断开')); } this.pending.clear(); });
      await this.send('Browser.setDownloadBehavior', { behavior: 'deny' });
      const targets = await this.send('Target.getTargets');
      const target = targets.targetInfos?.find(item => item.type === 'page' && item.url === 'about:blank') || await this.send('Target.createTarget', { url: 'about:blank' });
      const attached = await this.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
      this.sessionId = attached.sessionId; this.nonce = randomUUID();
      this.networkIssues = [];
      await this.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 }, this.sessionId);
      await this.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false }, this.sessionId);
      await this.send('Page.navigate', { url: HOME }, this.sessionId); await pause(1000);
      return await this.frame();
    } catch (error) { await this.close(); throw error; }
  }
  async current(timeoutMs = 12000) {
    const { frameTree } = await this.send('Page.getFrameTree', {}, this.sessionId, timeoutMs);
    if (!officialBrowserUrl(frameTree.frame.url)) throw Error('请仅在网易云官方页面完成登录，可点击“返回官网”');
    return frameTree.frame.url;
  }
  async frame() {
    if (this.framePending) return this.framePending;
    this.framePending = this.captureFrame();
    try { return await this.framePending; } finally { this.framePending = null; }
  }
  async captureFrame() {
    if (!this.sessionId) throw Error('请先打开服务器官网登录页');
    const nonce = this.nonce;
    this.touch(); const url = new URL(await this.current());
    const [result, login] = await Promise.all([
      this.send('Page.captureScreenshot', { format: 'jpeg', quality: 65, captureBeyondViewport: false }, this.sessionId),
      this.loginState(url).catch(() => ({ state: 'unknown', networkIssues: this.recentNetworkIssues() }))
    ]);
    if (nonce !== this.nonce) throw Error('浏览器页面已变化，请重新打开');
    if (typeof result.data !== 'string' || result.data.length > 2 * 1024 * 1024) throw Error('官网截图暂不可用，请刷新重试');
    return { nonce: this.nonce, image: 'data:image/jpeg;base64,' + result.data, width: WIDTH, height: HEIGHT, address: url.origin + url.pathname, login };
  }
  async input(args) {
    if (args.nonce !== this.nonce || !this.sessionId) throw Error('浏览器页面已变化，请重新打开');
    const events = args.type === 'batch' ? args.events : [args];
    if (!Array.isArray(events) || !events.length || events.length > 32) throw Error('输入操作过多');
    for (const event of events) this.validateInput(event);
    await this.current(); this.touch();
    for (const event of events) await this.dispatchInput(event);
    return true;
  }
  validateInput(args) {
    if (!args || typeof args !== 'object') throw Error('浏览器操作无效');
    if (args.type === 'pointer') {
      if (!['mousePressed', 'mouseReleased', 'mouseMoved'].includes(args.event) || !Number.isFinite(args.x) || !Number.isFinite(args.y) || args.x < 0 || args.x > WIDTH || args.y < 0 || args.y > HEIGHT) throw Error('鼠标操作无效');
    } else if (args.type === 'text') {
      if (typeof args.text !== 'string' || [...args.text].length > 256 || /[\x00-\x08\x0b-\x1f]/.test(args.text)) throw Error('输入内容无效');
    } else if (args.type === 'key') {
      const modifiers = args.modifiers ?? 0;
      if (!['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'a'].includes(args.key) || !Number.isInteger(modifiers) || modifiers < 0 || modifiers > 10 || (modifiers & ~10) || (args.key === 'a' && modifiers !== 2)) throw Error('按键无效');
    } else if (args.type === 'scroll') {
      if (!Number.isFinite(args.delta) || Math.abs(args.delta) > 800) throw Error('滚动操作无效');
    } else throw Error('浏览器操作无效');
  }
  async dispatchInput(args) {
    if (args.type === 'pointer') {
      if (!['mousePressed', 'mouseReleased', 'mouseMoved'].includes(args.event) || !Number.isFinite(args.x) || !Number.isFinite(args.y) || args.x < 0 || args.x > WIDTH || args.y < 0 || args.y > HEIGHT) throw Error('鼠标操作无效');
      await this.send('Input.dispatchMouseEvent', { type: args.event, x: args.x, y: args.y, button: 'left', buttons: args.event === 'mouseReleased' ? 0 : 1, clickCount: args.event === 'mouseMoved' ? 0 : 1 }, this.sessionId);
    } else if (args.type === 'text') {
      if (typeof args.text !== 'string' || [...args.text].length > 256 || /[\x00-\x08\x0b-\x1f]/.test(args.text)) throw Error('输入内容无效');
      await this.send('Input.insertText', { text: args.text }, this.sessionId);
    } else if (args.type === 'key') {
      const keyCode = { Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27, Home: 36, End: 35, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, a: 65 }[args.key];
      const modifiers = args.modifiers ?? 0;
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: args.key, modifiers, windowsVirtualKeyCode: keyCode, ...(args.key === 'Enter' ? { text: '\r' } : {}) }, this.sessionId);
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: args.key, modifiers, windowsVirtualKeyCode: keyCode }, this.sessionId);
    } else if (args.type === 'scroll') {
      if (!Number.isFinite(args.delta) || Math.abs(args.delta) > 800) throw Error('滚动操作无效');
      await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: WIDTH / 2, y: HEIGHT / 2, deltaX: 0, deltaY: args.delta }, this.sessionId);
    } else throw Error('浏览器操作无效');
    return true;
  }
  async pageLogin(address) {
    if (address.hostname !== 'music.163.com') return { profile: null, redirecting: false, readyState: 'loading' };
    const result = await this.send('Runtime.evaluate', { expression: PAGE_LOGIN, returnByValue: true }, this.sessionId, 1500);
    if (!result?.result?.value || result.exceptionDetails) throw Error('官网页面正在切换，请稍后再试');
    return result.result.value;
  }
  async musicCookies() { const result = await this.send('Network.getCookies', { urls: [HOME] }, this.sessionId, 3000); return result?.cookies || []; }
  async loginState(address) {
    const [page, cookies] = await Promise.all([this.pageLogin(address), this.musicCookies()]);
    const hasSessionCookie = hasMusicSession(cookies), profilePresent = !!page.profile;
    return { state: hasSessionCookie && profilePresent ? 'confirmed' : hasSessionCookie ? 'session-present' : page.redirecting ? 'redirecting' : 'waiting', hasSessionCookie, profilePresent, redirecting: !!page.redirecting, documentReady: page.readyState === 'complete', networkIssues: this.recentNetworkIssues() };
  }
  async navigateHome() {
    const result = await this.send('Page.navigate', { url: HOME }, this.sessionId, 6000);
    if (result?.errorText) throw Error('网易云官网未能加载，请稍后返回官网重试');
  }
  async home() { if (!this.sessionId) return this.start(); await this.navigateHome(); await pause(500); return this.frame(); }
  async finish() {
    let address = new URL(await this.current(1500));
    let cookies = await this.musicCookies();
    if (!hasMusicSession(cookies)) throw Error('官网尚未写入登录会话，验证码提交后的登录还未完成；请返回官网查看登录提示');
    let page = await this.pageLogin(address).catch(() => ({ profile: null }));
    if (!page.profile) {
      // A completed cookie is not sufficient proof. Reload the normal homepage
      // once, preserving the browser session, and wait for its account profile.
      await this.navigateHome();
      const deadline = Date.now() + 6000;
      do {
        await pause(400);
        try { address = new URL(await this.current(1500)); page = await this.pageLogin(address); }
        catch { page = { profile: null }; }
        if (page.profile) break;
      } while (Date.now() < deadline);
      cookies = await this.musicCookies();
    }
    if (!page.profile) throw Error('官网已写入会话，但返回主页后仍未确认账号；暂未保存，请查看官网是否要求继续验证');
    return browserLoginSession(cookies, page.profile);
  }
  async clear() { if (!existsSync(this.profileDirectory)) return; await this.start(); await this.send('Network.clearBrowserCookies', {}, this.sessionId); await this.close(); }
  async close() {
    clearTimeout(this.idle); this.sessionId = null; this.nonce = '';
    if (this.socket?.readyState === 1) { try { await this.send('Browser.close'); } catch {} }
    this.socket?.close(); this.socket = null;
    if (this.child?.exitCode === null) { await pause(300); if (this.child?.exitCode === null) this.child.kill(); }
    this.child = null;
  }
}
