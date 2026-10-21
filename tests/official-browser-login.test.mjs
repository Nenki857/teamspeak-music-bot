import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { browserLoginSession, officialBrowserUrl, NeteaseOfficialBrowser } from '../src/server/netease-official-browser.mjs';
import { CoreEngine } from '../src/worker/core-engine.mjs';
import { Service } from '../src/worker/service.mjs';
import { createVault, CommandGate } from '../src/shared/security.mjs';

const cookies = [{ name: 'MUSIC_U', value: 'PRIVATE_BROWSER_SESSION', domain: '.music.163.com', path: '/' }, { name: '__csrf', value: 'PRIVATE_CSRF', domain: 'music.163.com', path: '/' }, { name: '_ntes_nnid', value: 'id,123', domain: '.music.163.com', path: '/' }, { name: 'external', value: 'do-not-import', domain: '.example.com', path: '/' }];
const profile = { id: '123', nickname: 'Synthetic listener', avatarUrl: 'https://p1.music.126.net/avatar.jpg' };

test('browser login needs both an official-page profile and a root-scoped music session', () => {
  const result = browserLoginSession(cookies, profile);
  assert.match(result.cookie, /MUSIC_U=PRIVATE_BROWSER_SESSION/); assert.match(result.cookie, /_ntes_nnid=id%2C123/);
  assert.doesNotMatch(result.cookie, /external|do-not-import/);
  assert.doesNotMatch(JSON.stringify(result.auth), /PRIVATE_|MUSIC_U/);
  for (const invalid of [null, { id: '0' }, { id: 'invalid' }]) assert.throws(() => browserLoginSession(cookies, invalid));
  assert.throws(() => browserLoginSession(cookies.filter(item => item.name !== 'MUSIC_U'), profile));
  assert.throws(() => browserLoginSession(cookies.map(item => ({ ...item, domain: 'evil.music.163.com' })), profile));
});

test('browser navigation stays on official HTTPS sites and controls reject stale/out-of-range input', async () => {
  assert.equal(officialBrowserUrl('https://music.163.com/'), true);
  for (const url of ['http://music.163.com/', 'https://music.163.com.evil.test/', 'file:///tmp/file', 'javascript:alert(1)']) assert.equal(officialBrowserUrl(url), false);
  const browser = new NeteaseOfficialBrowser({ executable: 'synthetic', profileDirectory: 'work/synthetic-profile' });
  browser.nonce = 'fresh'; browser.sessionId = 'tab'; browser.current = async () => 'https://music.163.com/'; browser.touch = () => {};
  let calls = 0; browser.send = async () => { calls++; };
  await assert.rejects(browser.input({ nonce: 'stale', type: 'text', text: 'private' }));
  await assert.rejects(browser.input({ nonce: 'fresh', type: 'pointer', event: 'mousePressed', x: -1, y: 20 }));
  await assert.rejects(browser.input({ nonce: 'fresh', type: 'key', key: 'F12' }));
  assert.equal(calls, 0);
  await browser.input({ nonce: 'fresh', type: 'pointer', event: 'mousePressed', x: 300, y: 200 }); assert.equal(calls, 1);
});

test('confirmed browser login uses encryption without retrying a blocked API login check', () => {
  const vault = createVault(randomBytes(32)), values = new Map(); let active;
  const context = { vault, store: { set: (key, value) => values.set(key, value) }, provider: { setCookie: value => { active = value; } }, onChange() {}, qrKey: 'old' };
  const verified = browserLoginSession(cookies, profile);
  const result = CoreEngine.prototype.acceptOfficialLogin.call(context, verified.cookie, verified.auth);
  assert.equal(active, verified.cookie); assert.equal(vault.decrypt(values.get('neteaseCookie')), verified.cookie);
  assert.equal(context.qrKey, null); assert.equal(result.officialBrowser, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|MUSIC_U/);
});

test('friend RPC cannot start, view, control, finish, or close the owner browser', async () => {
  let called = false;
  const context = { ready: true, authority: { authenticate() { called = true; throw Error('Should not reach'); } } };
  for (const method of ['start', 'frame', 'input', 'finish', 'home', 'close']) await assert.rejects(Service.prototype.rpc.call(context, 'auth.browser.' + method, {}, { owner: false, session: 'guest', csrf: 'guest' }), /仅限本机/);
  assert.equal(called, false);
});

test('owner finish accepts only server browser data and never returns the raw session', async () => {
  const verified = browserLoginSession(cookies, profile); let closed = 0, saved;
  const context = { ready: true, runtime: { deployment: 'server' }, gate: new CommandGate(), changed() {}, browserLogin: { finish: async () => verified, close: async () => { closed++; } }, core: { acceptOfficialLogin: async (cookie, auth) => { saved = cookie; return auth; } } };
  const result = await Service.prototype.rpc.call(context, 'auth.browser.finish', { cookie: 'FORGED', auth: { loggedIn: true } });
  assert.equal(saved, verified.cookie); assert.equal(result.nickname, profile.nickname); assert.equal(closed, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|FORGED|MUSIC_U/);
  context.runtime.deployment = 'local';
  await assert.rejects(Service.prototype.rpc.call(context, 'auth.browser.start'), /仅限服务器主人/);
});

test('a late API auth refresh cannot overwrite a completed official browser login', async () => {
  let complete;
  const context = { authEpoch: 1, auth: { loggedIn: false }, provider: { getAuthStatus: () => new Promise(accept => { complete = accept; }) }, onChange() {} };
  const pending = CoreEngine.prototype.refreshAuth.call(context);
  context.authEpoch = 2; context.auth = { loggedIn: true, nickname: 'New login' }; complete({ loggedIn: false });
  await pending; assert.equal(context.auth.nickname, 'New login');
});

test('batched input validates everything first and preserves text, selection and editing order', async () => {
  const browser = new NeteaseOfficialBrowser({ executable: 'synthetic', profileDirectory: 'work/synthetic-profile' });
  browser.nonce = 'fresh'; browser.sessionId = 'tab'; browser.touch = () => {};
  const calls = []; let checks = 0;
  browser.current = async () => { checks++; return 'https://music.163.com/'; };
  browser.send = async (method, params) => { calls.push({ method, params }); };
  await assert.rejects(browser.input({ nonce: 'fresh', type: 'batch', events: [{ type: 'text', text: 'test' }, { type: 'key', key: 'F12' }] }));
  await assert.rejects(browser.input({ nonce: 'fresh', type: 'batch', events: Array(33).fill({ type: 'text', text: 'x' }) }));
  await assert.rejects(browser.input({ nonce: 'fresh', type: 'key', key: 'a', modifiers: 0 }));
  assert.equal(checks, 0); assert.equal(calls.length, 0);
  await browser.input({ nonce: 'fresh', type: 'batch', events: [{ type: 'text', text: '中文' }, { type: 'key', key: 'a', modifiers: 2 }, { type: 'text', text: 'phone' }, { type: 'key', key: 'Backspace' }, { type: 'key', key: 'Tab', modifiers: 8 }] });
  assert.equal(checks, 1);
  assert.deepEqual(calls.map(call => call.method), ['Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent']);
  assert.equal(calls[1].params.modifiers, 2); assert.equal(calls[6].params.modifiers, 8);
});

test('concurrent frame reads share one screenshot and never block owner input or broadcast state', async () => {
  const browser = new NeteaseOfficialBrowser({ executable: 'synthetic', profileDirectory: 'work/synthetic-profile' });
  browser.nonce = 'fresh'; browser.sessionId = 'tab'; browser.touch = () => {};
  browser.current = async () => 'https://music.163.com/';
  let complete, captures = 0, changes = 0;
  browser.send = async method => { if (method === 'Page.captureScreenshot') { captures++; return new Promise(resolve => { complete = resolve; }); } };
  const context = { ready: true, runtime: { deployment: 'server' }, gate: new CommandGate(), changed() { changes++; }, browserLogin: browser };
  const frame = Service.prototype.rpc.call(context, 'auth.browser.frame');
  const second = Service.prototype.rpc.call(context, 'auth.browser.frame');
  let timeout;
  try {
    const input = Service.prototype.rpc.call(context, 'auth.browser.input', { nonce: 'fresh', type: 'text', text: 'synthetic' });
    await Promise.race([input, new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('Screenshot blocked input')), 500); })]);
  } finally { clearTimeout(timeout); complete({ data: 'synthetic' }); }
  await Promise.all([frame, second]); assert.equal(captures, 1); assert.equal(changes, 0);
});

test('login status exposes only booleans and distinguishes missing session from an unfinished page refresh', async () => {
  const browser = new NeteaseOfficialBrowser({ executable: 'synthetic', profileDirectory: 'work/synthetic-profile' });
  browser.sessionId = 'tab';
  let stored = [], activeProfile = null;
  browser.send = async method => method === 'Network.getCookies' ? { cookies: stored } : { result: { value: { profile: activeProfile, redirecting: true, readyState: 'complete' } } };
  assert.equal((await browser.loginState(new URL('https://music.163.com/'))).state, 'redirecting');
  stored = cookies;
  assert.equal((await browser.loginState(new URL('https://music.163.com/'))).state, 'session-present');
  activeProfile = profile;
  const state = await browser.loginState(new URL('https://music.163.com/'));
  assert.equal(state.state, 'confirmed');
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_|MUSIC_U|nickname|Synthetic/);
});

test('save recovers a stuck redirect once using the existing browser cookie and normal homepage proof', async () => {
  const browser = new NeteaseOfficialBrowser({ executable: 'synthetic', profileDirectory: 'work/synthetic-profile' });
  browser.sessionId = 'tab'; browser.current = async () => 'https://music.163.com/';
  const calls = []; let returnedHome = false;
  browser.send = async (method, params) => {
    calls.push(method);
    if (method === 'Network.getCookies') return { cookies };
    if (method === 'Runtime.evaluate') return { result: { value: { profile: returnedHome ? profile : null } } };
    if (method === 'Page.navigate') { assert.equal(params.url, 'https://music.163.com/'); returnedHome = true; return {}; }
    throw Error('Unexpected external request');
  };
  const result = await browser.finish();
  assert.equal(result.auth.nickname, profile.nickname);
  assert.equal(calls.filter(method => method === 'Page.navigate').length, 1);
  assert.match(result.cookie, /MUSIC_U=PRIVATE_BROWSER_SESSION/);
});

test('a missing login cookie never navigates or claims a successful login', async () => {
  const browser = new NeteaseOfficialBrowser({ executable: 'synthetic', profileDirectory: 'work/synthetic-profile' });
  browser.sessionId = 'tab'; browser.current = async () => 'https://music.163.com/';
  browser.send = async method => { assert.equal(method, 'Network.getCookies'); return { cookies: [] }; };
  await assert.rejects(browser.finish(), /官网尚未写入登录会话/);
});

test('a cookie alone is never accepted when the homepage still cannot identify an account', async () => {
  const browser = new NeteaseOfficialBrowser({ executable: 'synthetic', profileDirectory: 'work/synthetic-profile' });
  browser.sessionId = 'tab'; browser.current = async () => 'https://music.163.com/';
  browser.send = async method => method === 'Network.getCookies' ? { cookies } : method === 'Runtime.evaluate' ? { result: { value: { profile: null } } } : {};
  await assert.rejects(browser.finish(), /返回主页后仍未确认账号/);
});

test('official page proof includes same-origin child frames but excludes external or inaccessible frames', async () => {
  const browser = new NeteaseOfficialBrowser({ executable: 'synthetic', profileDirectory: 'work/synthetic-profile' });
  browser.sessionId = 'tab';
  const external = { location: { origin: 'https://example.test' }, GUser: { userId: '999', nickname: 'Untrusted' } };
  const crossOrigin = {}; Object.defineProperty(crossOrigin, 'location', { get() { throw Error('Cross-origin access'); } });
  const child = { location: { origin: 'https://music.163.com' }, GUser: { userId: profile.id, nickname: profile.nickname }, document: { body: { innerText: '请稍后，正在跳转' } }, frames: [] };
  browser.send = async (method, params) => {
    assert.equal(method, 'Runtime.evaluate');
    return { result: { value: runInNewContext(params.expression, { location: { origin: 'https://music.163.com' }, document: { readyState: 'complete', body: { innerText: '' } }, frames: [external, crossOrigin, child] }) } };
  };
  const result = await browser.pageLogin(new URL('https://music.163.com/'));
  assert.equal(result.profile.id, profile.id); assert.equal(result.redirecting, true);
});

test('login network diagnostics retain error categories and omit URLs, headers, cookies and input', () => {
  const browser = new NeteaseOfficialBrowser({ executable: 'synthetic', profileDirectory: 'work/synthetic-profile' }); browser.sessionId = 'tab';
  browser.observe({ sessionId: 'tab', method: 'Network.responseReceived', params: { type: 'XHR', response: { url: 'https://music.163.com/login?phone=PRIVATE_PHONE', status: 403, headers: { 'Set-Cookie': 'PRIVATE_COOKIE' } } } });
  browser.observe({ sessionId: 'tab', method: 'Network.responseReceivedExtraInfo', params: { blockedCookies: [{ cookieLine: 'MUSIC_U=PRIVATE_COOKIE', cookie: cookies[0], blockedReasons: ['SameSiteNoneInsecure'] }] } });
  browser.observe({ sessionId: 'tab', method: 'Network.loadingFailed', params: { type: 'Document', errorText: 'net::ERR_CONNECTION_TIMED_OUT' } });
  browser.observe({ sessionId: 'tab', method: 'Network.requestWillBeSent', params: { request: { postData: 'PRIVATE_PHONE_AND_CODE' } } });
  browser.observe({ sessionId: 'other', method: 'Network.loadingFailed', params: { type: 'Document', errorText: 'net::ERR_CONNECTION_RESET' } });
  const issues = browser.recentNetworkIssues(); assert.equal(issues.length, 3);
  assert.equal(issues[0].status, 403); assert.equal(issues[1].reasons[0], 'SameSiteNoneInsecure');
  assert.doesNotMatch(JSON.stringify(issues), /PRIVATE_|music\.163|MUSIC_U|headers|postData/);
});
