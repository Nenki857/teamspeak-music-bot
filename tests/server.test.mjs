import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setAdminPassword, AdminAuthority } from '../src/server/admin-auth.mjs';
import { serverVaultKey } from '../src/server/vault-key.mjs';
import { createLinuxResourceMonitor } from '../src/server/resources.mjs';
import { publicOrigin, allowedShareUrl } from '../src/shared/public-url.mjs';
import { FixedPublicEndpoint } from '../src/worker/tunnel.mjs';
import { createShareServer } from '../src/worker/share-server.mjs';
import { ShareAuthority } from '../src/shared/security.mjs';
import { requireCore } from '../src/worker/paths.mjs';

mkdirSync(resolve('work/server-tests'), { recursive: true });
const temp = () => mkdtempSync(resolve('work/server-tests/run-'));
test('server key persists and refuses to replace copied desktop credentials', () => {
  const directory = temp(); const first = serverVaultKey(directory);
  assert.equal(first.length, 32); assert.deepEqual(serverVaultKey(directory), first);
  const copied = temp(); writeFileSync(resolve(copied, 'app.db'), 'desktop');
  assert.throws(() => serverVaultKey(copied), /缺少服务器密钥/);
  writeFileSync(resolve(directory, 'server-vault.key'), 'invalid');
  assert.throws(() => serverVaultKey(directory), /密钥无效/);
});
test('owner password is hashed, sessions require CSRF and expire or revoke', async () => {
  const file = resolve(temp(), 'admin.json'); let now = 0;
  await assert.rejects(setAdminPassword(file, 'short'), /12/);
  await setAdminPassword(file, 'synthetic-owner-password');
  assert.equal(readFileSync(file, 'utf8').includes('synthetic-owner-password'), false);
  const auth = new AdminAuthority(file, { now: () => now, lifetimeMs: 100 });
  await assert.rejects(auth.login('wrong'), /密码不正确/);
  const first = await auth.login('synthetic-owner-password');
  assert.equal(auth.authenticate(first.session, first.csrf).csrf, first.csrf);
  assert.throws(() => auth.authenticate(first.session, 'wrong'), /校验/);
  now = 101; assert.throws(() => auth.authenticate(first.session), /过期/);
  const second = await auth.login('synthetic-owner-password'); auth.logout(second.session);
  assert.throws(() => auth.authenticate(second.session), /过期/);
});
test('fixed public addresses are validated and only configured origins can be announced', async () => {
  const url = 'https://music.example.test'; const invite = '#invite=' + 'A'.repeat(43);
  assert.equal(publicOrigin(url + '/'), url);
  assert.throws(() => publicOrigin('http://203.0.113.10'), /HTTPS/);
  assert.throws(() => publicOrigin(url + '/admin'), /HTTPS/);
  assert.throws(() => publicOrigin('https://user:password@music.example.test'), /HTTPS/);
  assert.equal(allowedShareUrl(url + '/' + invite, url), true);
  assert.equal(allowedShareUrl(url + '/' + invite), false);
  assert.equal(allowedShareUrl('https://legitimate.trycloudflare.com/' + invite), true);
  assert.equal(allowedShareUrl('https://legitimate.trycloudflare.com.attacker.test/' + invite), false);
  assert.equal(allowedShareUrl(url + '/?redirect=evil' + invite, url), false);
  let changes = 0; const endpoint = new FixedPublicEndpoint(() => changes++, url);
  assert.equal((await endpoint.start()).url, url); endpoint.stop();
  assert.equal(endpoint.state.status, 'off'); assert.equal(changes, 2);
});

test('remembered owner login survives restart, expires after 30 days and logout revocation persists', async () => {
  const file=resolve(temp(),'admin.json');let now=1000;
  await setAdminPassword(file,'synthetic-owner-password');
  let auth=new AdminAuthority(file,{now:()=>now});
  const normal=await auth.login('synthetic-owner-password');
  const saved=await auth.login('synthetic-owner-password',{remember:true});
  assert.equal(normal.maxAgeSeconds,undefined);assert.equal(saved.maxAgeSeconds,2592000);
  const stored=readFileSync(file,'utf8');assert.ok(!stored.includes(saved.session));assert.ok(!stored.includes('synthetic-owner-password'));
  auth.close();auth=new AdminAuthority(file,{now:()=>now});
  assert.throws(()=>auth.authenticate(normal.session),/过期/);assert.ok(auth.authenticate(saved.session,saved.csrf));
  auth.logout(saved.session);auth=new AdminAuthority(file,{now:()=>now});assert.throws(()=>auth.authenticate(saved.session),/过期/);
  const expiring=await auth.login('synthetic-owner-password',{remember:true});now+=2592000001;
  auth=new AdminAuthority(file,{now:()=>now});assert.throws(()=>auth.authenticate(expiring.session),/过期/);
});

test('password change revokes remembered sessions across restart while retaining the current login',async()=>{
  const file=resolve(temp(),'admin.json');await setAdminPassword(file,'synthetic-owner-password');let auth=new AdminAuthority(file);
  const current=await auth.login('synthetic-owner-password',{remember:true});const other=await auth.login('synthetic-owner-password',{remember:true});
  await auth.changePassword(current.session,current.csrf,'synthetic-owner-password','synthetic-new-password');
  auth=new AdminAuthority(file);assert.ok(auth.authenticate(current.session,current.csrf));assert.throws(()=>auth.authenticate(other.session),/过期/);
});

test('password change checks the old password, persists atomically and revokes other owner sessions', async () => {
  const file = resolve(temp(), 'admin.json'); await setAdminPassword(file, 'synthetic-owner-password');
  const auth = new AdminAuthority(file); const current = await auth.login('synthetic-owner-password'); const other = await auth.login('synthetic-owner-password');
  const before = readFileSync(file, 'utf8');
  await assert.rejects(auth.changePassword(current.session, current.csrf, 'wrong-old-password', 'synthetic-new-password'), /当前密码不正确/);
  await assert.rejects(auth.changePassword(current.session, current.csrf, 'synthetic-owner-password', 'short'), /12/);
  assert.equal(readFileSync(file, 'utf8'), before); assert.ok(auth.authenticate(other.session));
  auth.file = resolve(temp(), 'missing-directory/admin.json');
  await assert.rejects(auth.changePassword(current.session, current.csrf, 'synthetic-owner-password', 'synthetic-new-password'));
  auth.file = file; assert.equal(readFileSync(file, 'utf8'), before); assert.ok(auth.authenticate(other.session));
  await auth.changePassword(current.session, current.csrf, 'synthetic-owner-password', 'synthetic-new-password');
  assert.ok(auth.authenticate(current.session, current.csrf)); assert.throws(() => auth.authenticate(other.session), /过期/);
  await assert.rejects(auth.login('synthetic-owner-password'), /密码不正确/);
  const restarted = new AdminAuthority(file); assert.ok((await restarted.login('synthetic-new-password')).session);
  assert.equal(readFileSync(file, 'utf8').includes('synthetic-new-password'), false);
});

async function fixture(t, { ownerEnabled = true } = {}) {
  const file = resolve(temp(), 'admin.json'); await setAdminPassword(file, 'synthetic-owner-password');
  const admin = new AdminAuthority(file); const authority = new ShareAuthority(); authority.beginRun();
  const grant = authority.create('Guest', ['view']); let enabled = true; const calls = [];
  const service = { authority, snapshot(owner = true) { return { ready: true, ...(owner ? { auth: { nickname: 'Private owner' }, presets: [{ id: 'private' }] } : {}) }; }, async rpc(method, args, access) { calls.push({ method, access }); if (access.owner) return service.snapshot(); const { grant } = authority.authenticate(access.session, method === 'status' ? 'view' : 'owner-only', access.csrf); return service.snapshot(false, grant.permissions); } };
  const server = await createShareServer(service, { admin: ownerEnabled ? admin : undefined, trustProxy: true, resources: () => ({ cpu: { percent: 1 } }), publicEnabled: () => enabled });
  t.after(() => { server.close(); admin.close(); }); const origin = `http://127.0.0.1:${server.port}`;
  const post = async (path, input = {}, credentials = {}) => { const response = await fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...credentials }, body: JSON.stringify(input) }); return { response, data: await response.json() }; };
  const login = async () => { const value = await post('/api/admin/login', { password: 'synthetic-owner-password' }, { 'X-Forwarded-Proto': 'https' }); return { cookie: value.response.headers.get('set-cookie').split(';')[0], csrf: value.data.csrf, header: value.response.headers.get('set-cookie') }; };
  return { origin, post, login, grant, server, service, admin, calls, enable: value => { enabled = value; } };
}
test('web owner login cannot be reached with guest credentials; CSRF and logout are enforced', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin + '/api/admin/session')).status, 401);
  assert.equal((await f.post('/api/admin/rpc', { method: 'status' })).response.status, 401);
  assert.equal((await f.post('/api/admin/login', { password: 'synthetic-owner-password' }, { Origin: 'https://attacker.test' })).data.ok, false);
  const guest = await f.post('/api/share/exchange', { token: f.grant.raw }); const guestCookie = guest.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await f.post('/api/admin/rpc', { method: 'auth.qr' }, { Cookie: guestCookie, 'X-TSMD-CSRF': guest.data.csrf })).response.status, 401);
  assert.equal((await f.post('/api/admin/rpc', { method: 'auth.importCookie', args: { cookie: 'synthetic-private-cookie' } }, { Cookie: guestCookie, 'X-TSMD-CSRF': guest.data.csrf })).response.status, 401);
  const owner = await f.login(); assert.match(owner.header, /HttpOnly; SameSite=Strict/); assert.match(owner.header, /Secure/);
  const credentials = { Cookie: owner.cookie, 'X-TSMD-CSRF': owner.csrf };
  const status = await f.post('/api/admin/rpc', { method: 'status', id: randomUUID() }, credentials);
  assert.equal(status.data.result.auth.nickname, 'Private owner'); assert.equal(f.calls.at(-1).access.owner, true);
  assert.equal((await f.post('/api/admin/rpc', { method: 'status' }, { Cookie: owner.cookie })).response.status, 401);
  assert.equal((await f.post('/api/share/rpc', { method: 'status' }, credentials)).data.ok, false, 'owner cookie is not a guest capability');
  assert.equal((await f.post('/api/admin/resources', {}, credentials)).data.result.cpu.percent, 1);
  const session = await fetch(f.origin + '/api/admin/session', { headers: { Cookie: owner.cookie } }); assert.equal((await session.json()).csrf, owner.csrf);
  await f.post('/api/admin/logout', {}, credentials);
  assert.equal((await f.post('/api/admin/rpc', { method: 'status' }, credentials)).response.status, 401);
  assert.equal((await f.post('/api/share/rpc', { method: 'status' }, { Cookie: guestCookie, 'X-TSMD-CSRF': guest.data.csrf })).data.ok, true, 'owner logout must not stop guest sessions');
});
test('owner websocket does not leak private state to guest sockets; logout closes owner socket', async t => {
  const f = await fixture(t); const { WebSocket } = requireCore('ws'); const owner = await f.login();
  const socket = new WebSocket(f.origin.replace('http', 'ws') + '/api/admin/events', { headers: { Origin: f.origin, Cookie: owner.cookie } }); t.after(() => socket.terminate());
  const [payload] = await once(socket, 'message'); assert.equal(JSON.parse(payload).state.presets[0].id, 'private');
  const closed = once(socket, 'close'); await f.post('/api/admin/logout', {}, { Cookie: owner.cookie, 'X-TSMD-CSRF': owner.csrf }); await closed;
  const guest = await f.post('/api/share/exchange', { token: f.grant.raw }); const cookie = guest.response.headers.get('set-cookie').split(';')[0];
  const guestSocket = new WebSocket(f.origin.replace('http', 'ws') + '/events', { headers: { Origin: f.origin, Cookie: cookie } }); t.after(() => guestSocket.terminate());
  const [publicPayload] = await once(guestSocket, 'message'); assert.equal(JSON.parse(publicPayload).state.auth, undefined);
  const revoked = once(guestSocket, 'message'); f.enable(false); f.server.broadcast(); assert.equal(JSON.parse((await revoked)[0]).type, 'revoked');
  assert.equal((await f.post('/api/share/exchange', { token: f.grant.raw })).data.ok, false);
});

test('remember checkbox sets a persistent HttpOnly owner cookie only when explicitly enabled',async t=>{
  const f=await fixture(t);
  const regular=await f.login();assert.ok(!regular.header.includes('Max-Age'));
  const remembered=await f.post('/api/admin/login',{password:'synthetic-owner-password',remember:true});
  const cookie=remembered.response.headers.get('set-cookie');assert.match(cookie,/Max-Age=2592000/);assert.match(cookie,/HttpOnly; SameSite=Strict/);
  const truthy=await f.post('/api/admin/login',{password:'synthetic-owner-password',remember:'true'});assert.ok(!truthy.response.headers.get('set-cookie').includes('Max-Age'));
});
test('desktop listener does not expose a new owner API', async t => {
  const f = await fixture(t, { ownerEnabled: false });
  assert.equal((await f.post('/api/admin/login', { password: 'synthetic-owner-password' })).response.status, 404);
});

test('password HTTP requires owner CSRF and old password, keeps current owner and guest sessions alive', async t => {
  const f = await fixture(t); const owner = await f.login(); const other = await f.login();
  const guest = await f.post('/api/share/exchange', { token: f.grant.raw }); const guestCookie = guest.response.headers.get('set-cookie').split(';')[0];
  const input = { currentPassword: 'synthetic-owner-password', newPassword: 'synthetic-new-password' };
  assert.equal((await f.post('/api/admin/password', input, { Cookie: guestCookie, 'X-TSMD-CSRF': guest.data.csrf })).response.status, 401);
  assert.equal((await f.post('/api/admin/password', input, { Cookie: owner.cookie })).response.status, 401);
  const headers = { Cookie: owner.cookie, 'X-TSMD-CSRF': owner.csrf };
  assert.equal((await f.post('/api/admin/password', { ...input, currentPassword: 'wrong' }, headers)).data.ok, false);
  const { WebSocket } = requireCore('ws'); const otherSocket = new WebSocket(f.origin.replace('http', 'ws') + '/api/admin/events', { headers: { Cookie: other.cookie, Origin: f.origin } }); t.after(() => otherSocket.terminate()); await once(otherSocket, 'message');
  const closed = once(otherSocket, 'close');
  assert.equal((await f.post('/api/admin/password', input, headers)).data.ok, true); await closed;
  assert.equal((await f.post('/api/admin/rpc', { method: 'status', id: randomUUID() }, headers)).data.ok, true);
  assert.equal((await f.post('/api/admin/rpc', { method: 'status', id: randomUUID() }, { Cookie: other.cookie, 'X-TSMD-CSRF': other.csrf })).response.status, 401);
  assert.equal((await f.post('/api/share/rpc', { method: 'status' }, { Cookie: guestCookie, 'X-TSMD-CSRF': guest.data.csrf })).data.ok, true);
  assert.equal((await f.post('/api/admin/login', { password: input.newPassword })).data.ok, true);
});
test('Linux sampler includes descendant FFmpeg, excludes unrelated TS process and avoids loopback double counting', async () => {
  let at = 0; let cpu = 100; let received = 1000;
  const stat = (pid, parent, cpuTicks, rss) => { const fields = Array(22).fill('0'); fields[0] = 'S'; fields[1] = String(parent); fields[11] = String(cpuTicks); fields[19] = String(pid + 1000); fields[21] = String(rss); return `${pid} (name with spaces) ${fields.join(' ')}`; };
  const monitor = createLinuxResourceMonitor({ pid: 10, now: () => at, cpuCount: 2, list: async () => ['10', '11', '20', 'self'], read: async file => {
    if (file.endsWith('/10/stat')) return stat(10, 1, cpu, 10);
    if (file.endsWith('/11/stat')) return stat(11, 10, cpu, 20);
    if (file.endsWith('/20/stat')) return stat(20, 1, 9999999, 50000);
    return `header\nheader\neth0: ${received} 0 0 0 0 0 0 0 500 0 0 0 0 0 0 0\nlo: 9999999 0 0 0 0 0 0 0 9999999 0 0 0 0 0 0 0`;
  } });
  const first = await monitor.sample(); assert.equal(first.cpu.status, 'warming'); assert.equal(first.memory.bytes, 30 * 4096);
  at = 1000; cpu = 110; received = 2024;
  const second = await monitor.sample(); assert.equal(second.cpu.percent, 10); assert.equal(second.cpu.processes, 2); assert.equal(second.network.receivedPerSecond, 1024);
  at = 1001; assert.equal(await monitor.sample(), second, 'rapid clients reuse one sample');
  at = 10000; assert.equal((await monitor.sample()).cpu.status, 'warming');
});
test('Linux official audio resource roots include the isolated native client family without counting the TS server',async()=>{
  let at=0;let roots=[30];const rows=[[10,1,1],[20,1,999],[30,1,2],[31,30,3],[32,30,4]];
  const monitor=createLinuxResourceMonitor({pid:10,extraRoots:async()=>roots,now:()=>at,list:async()=>rows.map(row=>String(row[0])),read:async file=>{if(file.endsWith('/net/dev'))return 'header\nheader\n';const id=Number(file.split('/').at(-2)),row=rows.find(row=>row[0]===id),fields=Array(22).fill('0');fields[0]='S';fields[1]=String(row[1]);fields[19]=String(id+100);fields[21]=String(row[2]);return `${id} (process) ${fields.join(' ')}`;}});
  assert.equal((await monitor.sample()).memory.bytes,10*4096);at=1500;roots=[];assert.equal((await monitor.sample()).memory.bytes,4096);
});
