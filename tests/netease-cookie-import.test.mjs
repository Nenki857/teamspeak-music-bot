import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { normalizeNeteaseCookie } from '../src/worker/netease-cookie.mjs';
import { CoreEngine } from '../src/worker/core-engine.mjs';
import { Service } from '../src/worker/service.mjs';
import { createVault, CommandGate } from '../src/shared/security.mjs';

const cookie = 'MUSIC_U=synthetic-private-session; __csrf=synthetic-token';
function fixture(status = { loggedIn: true, nickname: 'Synthetic user', avatarUrl: '' }) {
  const vault = createVault(randomBytes(32)); const values = new Map([['neteaseCookie', vault.encrypt('old-login')]]);
  let activeCookie = 'old-login', closed = 0;
  const context = { vault, store: { get: key => values.get(key), set: (key, value) => values.set(key, value) },
    provider: { setCookie: value => { activeCookie = value; } }, auth: { loggedIn: true, nickname: 'Old user' }, qrKey: 'old-qr', onChange() {} };
  const probe = { ready: Promise.resolve(), setCookie(value) { assert.equal(value, cookie); }, async getAuthStatus() { return status; }, close() { closed++; } };
  return { context, probe, values, vault, active: () => activeCookie, closed: () => closed };
}

test('login import rejects malformed or anonymous input without echoing submitted credentials', () => {
  assert.equal(normalizeNeteaseCookie('Cookie: ' + cookie), cookie);
  assert.equal(normalizeNeteaseCookie('00ABCDEF0123456789ABCDEF01234567'), 'MUSIC_U=00ABCDEF0123456789ABCDEF01234567');
  assert.equal(normalizeNeteaseCookie('synthetic+base64/session=='), 'MUSIC_U=synthetic+base64/session==');
  for (const input of ['', 'MUSIC_A=guest', 'MUSIC_U=private\r\nX-Test: secret', cookie + '; MUSIC_U=duplicate', 'x'.repeat(16385)]) {
    assert.throws(() => normalizeNeteaseCookie(input), error => !/private|secret|duplicate|guest/.test(error.message));
  }
});

test('validated login is encrypted and returns only account display data', async () => {
  const f = fixture({ loggedIn: true, nickname: 'Synthetic user', avatarUrl: '', cookie: 'must-not-return' });
  const result = await CoreEngine.prototype.importCookie.call(f.context, cookie, { createProbe: () => f.probe });
  assert.equal(f.active(), cookie); const sealed = f.values.get('neteaseCookie'); assert.match(sealed, /^v1:/); assert.ok(!sealed.includes('synthetic-private'));
  assert.equal(f.vault.decrypt(sealed), cookie); assert.equal(result.loggedIn, true); assert.equal(f.context.qrKey, null);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|must-not-return|MUSIC_U/); assert.equal(f.closed(), 1);
});

test('rejected login or failed verification preserves the previous account and encrypted record', async () => {
  for (const fail of [false, true]) {
    const f = fixture({ loggedIn: false }); const original = f.values.get('neteaseCookie');
    if (fail) f.probe.getAuthStatus = async () => { throw Error('MUSIC_U=synthetic-private https://private.invalid'); };
    await assert.rejects(CoreEngine.prototype.importCookie.call(f.context, cookie, { createProbe: () => f.probe }), error => /原登录未替换/.test(error.message) && !/MUSIC_U|private/.test(error.message));
    assert.equal(f.values.get('neteaseCookie'), original); assert.equal(f.active(), 'old-login'); assert.equal(f.context.auth.nickname, 'Old user'); assert.equal(f.closed(), 1);
  }
});

test('logout during verification cannot be overwritten by a delayed import', async () => {
  const f = fixture(); let finish;
  f.probe.getAuthStatus = () => new Promise(accept => { finish = accept; });
  const pending = CoreEngine.prototype.importCookie.call(f.context, cookie, { createProbe: () => f.probe });
  await Promise.resolve(); await CoreEngine.prototype.logout.call(f.context);
  finish({ loggedIn: true }); await assert.rejects(pending, /账号状态已变化/);
  assert.equal(f.active(), ''); assert.equal(f.values.get('neteaseCookie'), ''); assert.equal(f.context.auth.loggedIn, false);
});

test('only the server owner can invoke session import, regardless of friend permissions', async () => {
  let calls = 0;
  const context = { ready: true, runtime: { deployment: 'server' }, core: { importCookie(value) { calls++; assert.equal(value, cookie); return { loggedIn: true }; } }, gate: new CommandGate(), changed() {} };
  await assert.rejects(Service.prototype.rpc.call(context, 'auth.importCookie', { cookie }, { owner: false }), /仅限/); assert.equal(calls, 0);
  assert.equal((await Service.prototype.rpc.call(context, 'auth.importCookie', { cookie }, { owner: true })).loggedIn, true); assert.equal(calls, 1);
  context.runtime.deployment = 'desktop'; await assert.rejects(Service.prototype.rpc.call(context, 'auth.importCookie', { cookie }, { owner: true }), /仅限服务器主人/); assert.equal(calls, 1);
});
