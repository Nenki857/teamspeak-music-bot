import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { CatalogClient, CATALOG_METHODS } from '../src/worker/catalog-client.mjs';
import { IsolatedMusicProvider } from '../src/worker/music-provider.mjs';
const apiModule = new URL('./fixtures/music-api.mjs', import.meta.url).href;

async function create(t) {
  const provider = new IsolatedMusicProvider({ apiModule });
  const { port1, port2 } = new MessageChannel();
  const catalog = new CatalogClient(port1);
  t.after(async () => { catalog.close(); await provider.close(); });
  await provider.attachCatalogPort(port2); await catalog.ready;
  return { provider, catalog };
}

test('direct catalog uses the same private login state and keeps public lookups anonymous', async t => {
  const { provider, catalog } = await create(t);
  provider.setCookie('owner-cookie'); await provider.flushConfiguration(); await catalog.sync();
  const [a, b] = await Promise.all([catalog.call('getUserPlaylists'), catalog.call('getUserPlaylists')]);
  assert.equal(a, b); assert.match(a[0].name, /^owner-cookie:/);
  assert.equal(await catalog.call('getUserPlaylists'), a);
  assert.equal((await catalog.call('searchUsers', ['Public', 'nickname', 0])).users[0].phone, undefined);
  assert.deepEqual((await catalog.call('getPublicUserPlaylists', ['42', 0])).playlists.map(item => item.id), ['7']);
  assert.equal((await catalog.call('getPublicPlaylist', ['7'])).songs.length, 3);
  assert.equal((await catalog.call('getPlaylistSongs', ['1'])).length, 500);
  provider.setCookie('next-cookie'); await provider.flushConfiguration(); await catalog.sync();
  const c = await catalog.call('getUserPlaylists'); assert.notEqual(c, a); assert.match(c[0].name, /^next-cookie:/);
  provider.setQuality('higher'); await provider.flushConfiguration(); await catalog.sync();
  assert.notEqual(await catalog.call('getUserPlaylists'), c);
  assert.equal((await provider.getSongUrl('1')).url, 'https://example.invalid/higher.mp3');
  assert.equal(provider.getCookie(), 'next-cookie');
});

test('catalog rejects stale results, disallowed methods and sanitized API failures', async t => {
  const { provider, catalog } = await create(t);
  assert.ok(!CATALOG_METHODS.includes('getCookie')); assert.ok(!CATALOG_METHODS.includes('getSongUrl'));
  for (const method of ['getCookie', 'getSongUrl', 'checkQrCodeStatus', 'syncConfiguration']) await assert.rejects(catalog.call(method), /不可用/);
  // Check the receiving worker whitelist too, bypassing the client-side guard.
  const reply = new Promise(resolve => {
    const listener = message => { if (message.id !== 'forbidden') return; catalog.port.off('message', listener); resolve(message); };
    catalog.port.on('message', listener);
  });
  catalog.port.postMessage({ type: 'call', id: 'forbidden', method: 'getSongUrl', args: ['1'] });
  assert.deepEqual(await reply, { id: 'forbidden', ok: false, generation: catalog.generation, error: '音乐操作不可用' });
  await assert.rejects(catalog.call('search', ['denied']), error => error.status === 403 && !/private.invalid|do-not-forward/.test(error.message));
  const stale = assert.rejects(catalog.call('search', ['slow-catalog']), /账号状态已变化/);
  await new Promise(resolve => setTimeout(resolve, 25));
  provider.setCookie('new-account'); await provider.flushConfiguration(); await catalog.sync(); await stale;
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(catalog.cache.has('search:["slow-catalog"]'), false);
  assert.equal((await catalog.call('search', ['slow-catalog'])).songs.length, 30);
});

test('directory worker failure rejects outstanding work without leaving cached responses usable', async t => {
  const { provider, catalog } = await create(t);
  await catalog.call('search', ['Fixture']);
  const pending = assert.rejects(catalog.call('search', ['slow-catalog']), /连接已关闭/);
  await new Promise(resolve => setTimeout(resolve, 25));
  await provider.worker.terminate(); await pending;
  await assert.rejects(catalog.call('search', ['Fixture']), /连接已关闭/);
  assert.equal(catalog.pending.size, 0); assert.equal(catalog.cache.size, 0);
});

test('catalog initialization, request timeouts and closure clean up pending work', async t => {
  const { port1, port2 } = new MessageChannel(); const catalog = new CatalogClient(port1, { timeoutMs: 100 });
  t.after(() => { catalog.close(); port2.close(); });
  port2.postMessage({ type: 'ready', generation: 0 }); await catalog.ready;
  await assert.rejects(catalog.call('search', ['timeout']), /超时/);
  assert.equal(catalog.pending.size, 0); assert.equal(catalog.inflight.size, 0);
  const pending = assert.rejects(catalog.sync(), /已关闭/); catalog.close(); await pending;
  const unopened = new MessageChannel(); const timedOut = new CatalogClient(unopened.port1, { timeoutMs: 30 });
  t.after(() => { timedOut.close(); unopened.port2.close(); });
  await assert.rejects(timedOut.ready, /初始化超时/);
});

test('timed lyrics use the direct catalog port with bounded parsed text and translation',async t=>{
 const {provider,catalog}=await create(t);provider.setCookie('fixture-login');await provider.flushConfiguration();await catalog.sync();
 const [a,b]=await Promise.all([catalog.call('getLyrics',['123']),catalog.call('getLyrics',['123'])]);assert.equal(a,b);assert.deepEqual(a,[{time:0,text:'First 123',translation:'第一句'},{time:4.5,text:'Second'}]);
});
