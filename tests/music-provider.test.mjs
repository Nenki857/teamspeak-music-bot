import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { IsolatedMusicProvider } from '../src/worker/music-provider.mjs';
const apiModule = new URL('./fixtures/music-api.mjs', import.meta.url).href;

test('public user lookup, playlist previews and builder metadata never use the owner login or expose private fields', async t => {
  const provider = new IsolatedMusicProvider({ apiModule }); t.after(() => provider.close()); await provider.ready; provider.setCookie('owner-private-cookie');
  const found = await provider.searchUsers('Public', 'nickname', 0); assert.equal(found.users[0].id, '42'); assert.equal(found.users[0].phone, undefined);
  assert.equal((await provider.searchUsers('https://music.163.com/#/user/home?id=42', 'uid', 0)).users[0].name, 'Public 42');
  const lists = await provider.getPublicUserPlaylists('42', 0); assert.deepEqual(lists.playlists.map(item => item.id), ['7']);
  const detail = await provider.getPublicPlaylist('7'); assert.equal(detail.songs.length, 3); assert.equal(detail.publicPreview, true);
  await assert.rejects(provider.getPublicPlaylist('8'));
  assert.deepEqual((await provider.getPublicSongs(['3','1','3'])).map(song => song.id), ['3','1','3']);
  assert.equal(provider.getCookie(), 'owner-private-cookie');
  await assert.rejects(provider.searchUsers('13812345678', 'nickname', 0));
});

test('artist metadata, server hot/time ordering and pagination retain artist IDs and popularity', async t => {
  const provider = new IsolatedMusicProvider({ apiModule }); t.after(() => provider.close()); await provider.ready;
  const hot = await provider.getArtistPage('99', 'hot', 0); assert.equal(hot.artist.name, 'Artist 99'); assert.equal(hot.songs.length, 30); assert.equal(hot.songs[0].id, '1');
  assert.equal(hot.songs[0].artists[0].id, '99'); assert.equal(hot.songs[0].popularity, 1);
  const recent = await provider.getArtistPage('99', 'time', 30); assert.equal(recent.songs[0].id, '1030');
  const last = await provider.getArtistPage('99', 'hot', 480); assert.equal(last.songs.length, 20); assert.equal(last.more, false);
});

test('isolated music provider preserves login, QR cookie, quality, song mapping and the 500-track limit', async t => {
  const provider = new IsolatedMusicProvider({ apiModule }); t.after(() => provider.close()); await provider.ready;
  provider.setCookie('fixture-account'); provider.setQuality('higher');
  assert.equal((await provider.getAuthStatus()).nickname, 'fixture-account');
  assert.equal((await provider.getSongUrl('1')).url, 'https://example.invalid/higher.mp3');
  const tracks = await provider.getPlaylistSongs('1'); assert.equal(tracks.length, 500); assert.equal(tracks[0].artist, 'Artist');
  assert.equal((await provider.getQrCode()).key, 'fixture-key');
  assert.equal(await provider.checkQrCodeStatus('fixture-key'), 'confirmed'); assert.equal(provider.getCookie(), 'fixture-confirmed');
  assert.equal((await provider.getAuthStatus()).nickname, 'fixture-confirmed');
  await assert.rejects(provider.search('denied'), error => error.status === 403 && !error.message.includes('private.invalid') && !error.message.includes('do-not-forward'));
});

test('metadata requests are coalesced and cached, account changes invalidate data and reject stale QR replies', async t => {
  const provider = new IsolatedMusicProvider({ apiModule }); t.after(() => provider.close()); await provider.ready;
  provider.setCookie('account-a');
  const [a, b] = await Promise.all([provider.getUserPlaylists(), provider.getUserPlaylists()]);
  assert.equal(a, b); assert.equal(await provider.getUserPlaylists(), a);
  provider.setCookie('account-b'); const c = await provider.getUserPlaylists(); assert.notEqual(c, a); assert.match(c[0].name, /^account-b:/);
  const stale = provider.checkQrCodeStatus('slow'); provider.setCookie('account-c');
  await assert.rejects(stale, /账号状态已变化/);
  await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(provider.getCookie(), 'account-c');
});

test('heavy API parsing leaves the parent audio timer responsive and closing rejects outstanding work', async t => {
  const provider = new IsolatedMusicProvider({ apiModule }); t.after(() => provider.close()); await provider.ready;
  let ticks = 0; let previous = performance.now(); let maxGap = 0;
  const timer = setInterval(() => { const at = performance.now(); maxGap = Math.max(maxGap, at - previous); previous = at; ticks++; }, 20);
  try { const result = await provider.search('cpu-stress'); assert.equal(result.songs.length, 30); }
  finally { clearInterval(timer); }
  assert.ok(ticks >= 10, `audio timer was blocked: ${ticks} ticks`); assert.ok(maxGap < 300, `parent event loop stalled for ${maxGap}ms`);
  const pending = provider.checkQrCodeStatus('slow'); const rejected = assert.rejects(pending, /音乐服务已关闭/);
  await provider.close(); await rejected;
});
