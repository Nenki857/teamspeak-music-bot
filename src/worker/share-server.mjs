import { createServer } from 'node:http';
import { resolve, sep } from 'node:path';
import { requireCore, root } from './paths.mjs';
import { safeError } from './core-engine.mjs';
import { createStaticResponder, stateFrame, sendJson } from './web-delivery.mjs';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
export async function createShareServer(service, { host = '127.0.0.1', port = 0, admin, resources, trustProxy = false, persistentInvites = false, publicEnabled = () => true } = {}) {
  const sockets = new Set(); const limit = new Map();
  const cookie = request => (request.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('tsmd_session='))?.slice(13) || '';
  const ownerCookie = request => (request.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('tsmd_owner='))?.slice(11) || '';
  const secureRequest = request => Boolean(request.socket.encrypted || (trustProxy && request.headers['x-forwarded-proto'] === 'https'));
  const headers = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https://music.126.net https://*.music.126.net; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
  const serveStatic = createStaticResponder({ headers, mime: MIME, transformHtml: content => persistentInvites ? content.replace('<html', '<html data-persistent-invitations') : content });
  const json = (response, status, body, extra = {}) => sendJson(response, status, body, headers, extra);
  const originAllowed = request => { const origin = request.headers.origin; if (!origin) return false; try { return new URL(origin).host === request.headers.host && ['http:', 'https:'].includes(new URL(origin).protocol); } catch { return false; } };
  const body = async (request, maximum = 32768) => { let total = 0; const chunks = []; for await (const chunk of request) { total += chunk.length; if (total > maximum) throw new Error('请求过大'); chunks.push(chunk); } return JSON.parse(Buffer.concat(chunks).toString()); };
  function rate(key, max) { const now = Date.now(); const bucket = limit.get(key); if (!bucket || now - bucket.start > 60000) { limit.set(key, { start: now, count: 1 }); return; } if (++bucket.count > max) throw new Error('操作太频繁，请稍后重试'); }
  const cleanup = setInterval(() => { for (const [key, bucket] of limit) if (Date.now() - bucket.start > 60000) limit.delete(key); }, 60000); cleanup.unref();
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (admin && pathname.startsWith('/api/admin/')) {
        const owner = ownerCookie(request);
        if (pathname === '/api/admin/session' && request.method === 'GET') {
          try { json(response, 200, { ok: true, csrf: admin.authenticate(owner).csrf }); }
          catch { json(response, 401, { ok: false, error: '请登录主人控制台' }); }
          return;
        }
        if (request.method !== 'POST' || !originAllowed(request) || !request.headers['content-type']?.startsWith('application/json')) throw new Error('请求来源或格式无效');
        if (pathname === '/api/admin/login') {
          rate('owner-login', 8);
          const input = await body(request); const login = await admin.login(input.password, { remember: input.remember === true });
          json(response, 200, { ok: true, csrf: login.csrf }, { 'Set-Cookie': `tsmd_owner=${login.session}; HttpOnly; SameSite=Strict; Path=/${login.maxAgeSeconds ? `; Max-Age=${login.maxAgeSeconds}` : ''}${secureRequest(request) ? '; Secure' : ''}` }); return;
        }
        const csrf = request.headers['x-tsmd-csrf'];
        try { if (typeof csrf !== 'string') throw new Error('请求校验失败'); admin.authenticate(owner, csrf); }
        catch { json(response, 401, { ok: false, error: '主人登录已过期或请求校验失败，请重新登录' }); return; }
        if (pathname === '/api/admin/logout') {
          admin.logout(owner); broadcast();
          json(response, 200, { ok: true }, { 'Set-Cookie': 'tsmd_owner=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); return;
        }
        if (pathname !== '/api/admin/rpc') rate(`owner-rpc:${owner}`, 180);
        if (pathname === '/api/admin/password') {
          rate('owner-password', 5);
          const input = await body(request);
          await admin.changePassword(owner, csrf, input.currentPassword, input.newPassword); broadcast();
          json(response, 200, { ok: true, result: true }); return;
        }
        if (pathname === '/api/admin/resources' && resources) { json(response, 200, { ok: true, result: await resources() }); return; }
        if (pathname === '/api/admin/rpc') {
          const input = await body(request, 2 * 1024 * 1024);
          if (typeof input.method !== 'string') throw new Error('操作无效');
          // Keyboard bursts are batched; keep their bounded allowance separate
          // from ordinary owner commands and screenshot polling.
          if (input.method === 'auth.browser.input') rate(`owner-browser-input:${owner}`, 600);
          else if (input.method === 'auth.browser.frame') rate(`owner-browser-frame:${owner}`, 120);
          else rate(`owner-rpc:${owner}`, 180);
          admin.authenticate(owner, csrf);
          const result = await service.rpc(input.method, input.args, { owner: true }, input.id);
          json(response, 200, { ok: true, result }); return;
        }
        json(response, 404, { ok: false, error: '页面不存在' }); return;
      }
      if (request.method === 'POST' && pathname.startsWith('/api/share/')) {
        if (!publicEnabled()) throw new Error('共享入口已关闭，请联系机器人主人');
        if (!originAllowed(request)) throw new Error('请求来源无效');
        if (!request.headers['content-type']?.startsWith('application/json')) throw new Error('请求类型无效');
        if (pathname === '/api/share/exchange') {
          rate(`exchange:${request.headers['cf-connecting-ip'] || request.socket.remoteAddress}`, 20);
          const input = await body(request); const result = service.authority.exchange(input.token);
          const secure = secureRequest(request);
          json(response, 200, { ok: true, csrf: result.csrf, grant: result.grant }, { 'Set-Cookie': `tsmd_session=${result.session}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}` }); return;
        }
        if (pathname === '/api/share/resources' && resources) {
          const csrf=request.headers['x-tsmd-csrf'];if(typeof csrf!=='string')throw new Error('请求校验失败');
          const session=cookie(request);service.authority.authenticate(session,'view',csrf);rate('resources:'+session,40);await body(request);
          const result=await resources();service.authority.authenticate(session,'view',csrf);
          json(response,200,{ok:true,result});return;
        }
        if (pathname === '/api/share/rpc') {
          if (typeof request.headers['x-tsmd-csrf'] !== 'string') throw new Error('请求校验失败');
          const session = cookie(request); service.authority.authenticate(session, 'view', request.headers['x-tsmd-csrf']);
          rate(`rpc:${session}`, 90); const input = await body(request);
          if (typeof input.method !== 'string') throw new Error('操作无效');
          const result = await service.rpc(input.method, input.args, { owner: false, session, csrf: request.headers['x-tsmd-csrf'] }, input.id);
          json(response, 200, { ok: true, result }); return;
        }
      }
      if (!['GET', 'HEAD'].includes(request.method) || pathname.startsWith('/api')) { json(response, 404, { ok: false, error: '页面不存在' }); return; }
      const base = resolve(root, 'dist/ui'); const file = pathname === '/' || (admin && pathname === '/admin') ? resolve(base, 'index.html') : resolve(base, '.' + decodeURIComponent(pathname));
      if (!file.startsWith(base + sep)) throw new Error('路径无效');
      await serveStatic(request, response, file);
    } catch (error) { if (response.headersSent) response.destroy(); else json(response, 400, { ok: false, error: safeError(error) }); }
  });
  server.requestTimeout = 25000; server.headersTimeout = 10000;
  const { WebSocketServer } = requireCore('ws'); const ws = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  server.on('upgrade', (request, socket, head) => {
    try {
      if (!originAllowed(request)) throw new Error('Invalid websocket');
      const endpoint = new URL(request.url, 'http://localhost');
      const owner = Boolean(admin && endpoint.pathname === '/api/admin/events');
      if (!owner && (endpoint.pathname !== '/events' || !publicEnabled())) throw new Error('Invalid websocket');
      const session = owner ? ownerCookie(request) : cookie(request);
      if (owner) admin.authenticate(session); else service.authority.authenticate(session, 'view');
      ws.handleUpgrade(request, socket, head, client => { client.owner = owner; client.delta = !owner && endpoint.searchParams.get('delta') === '1'; client.on('error', () => client.terminate()); client.session = session; client.alive = true; sockets.add(client); client.on('pong', () => { client.alive = true; }); client.on('close', () => sockets.delete(client)); push(client); });
    }
    catch { socket.destroy(); }
  });
  function push(client) {
    try {
      let state;
      if (client.owner) { admin.authenticate(client.session); state = service.snapshot(); }
      else { if (!publicEnabled()) throw new Error('Sharing disabled'); const { grant, displayName } = service.authority.authenticate(client.session, 'view'); state = service.snapshot(false, grant.permissions, displayName || ''); }
      if (client.readyState !== 1) return;
      if (client.bufferedAmount > 1024 * 1024) { client.terminate(); return; }
      if (client.bufferedAmount > 256 * 1024) return;
      const frame = stateFrame(state, client.previousState, client.delta);
      if (frame.payload) {
        client.send(frame.payload, error => { if (error) client.terminate(); });
        client.previousState = frame.previous;
      }
    } catch { if (client.readyState === 1) { client.send(JSON.stringify({ type: 'revoked' })); client.close(4001, 'Authorization ended'); } }
  }
  function broadcast() { for (const client of sockets) push(client); }
  const timer = setInterval(() => { for (const client of sockets) { if (!client.alive) { client.terminate(); continue; } client.alive = false; client.ping(); } }, 10000);
  try { await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(port, host, resolveListen); }); }
  catch (error) { clearInterval(timer); clearInterval(cleanup); ws.close(); throw error; }
  service.sharePort = server.address().port;
  return { port: service.sharePort, broadcast, close: () => { clearInterval(timer); clearInterval(cleanup); for (const client of sockets) client.terminate(); ws.close(); server.close(); server.closeIdleConnections(); } };
}
