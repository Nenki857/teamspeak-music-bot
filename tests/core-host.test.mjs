import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { IsolatedCore } from '../src/worker/core-host.mjs';
const engineModule = new URL('./fixtures/core-engine.mjs', import.meta.url).href;
const create = options => new IsolatedCore({ key: randomBytes(32), dataDirectory: resolve('work/core-host-' + randomUUID()), engineModule, ...options });

test('isolated playback preserves control, auth and queue revisions across thread messages', async t => {
  const core = create(); t.after(() => core.close()); await core.init();
  assert.equal(core.status().connected, false); assert.equal(core.health().isolatedCore, true);
  assert.equal((await core.provider.search('Fixture')).songs[0].name, 'Song 0');
  assert.equal((await core.provider.getArtistPage('99', 'hot', 0)).artist.id, '99');
  await core.setQuality('higher'); assert.ok((await core.qr()).qrImg);
  await core.qrCheck(); assert.equal(core.auth.loggedIn, true); await core.logout(); assert.equal(core.auth.loggedIn, false);
  await core.start({ probeFrames: 500 }); assert.equal(core.status().queue.length, 500);
  assert.equal((await core.exportQueue()).length, 500);
  const firstQueue = core.status().queue;
  await core.command('player.volume', { value: 27 }, 'Owner'); assert.equal(core.status().volume, 27);
  assert.equal(core.status().queue, firstQueue, 'non-queue updates keep the cached queue');
  const revision = core.status().revision;
  await core.command('queue.move', { entryId: 'entry-4', targetEntryId: 'entry-2', expectedRevision: revision }, 'Owner');
  assert.equal(core.status().queue[2].entryId, 'entry-4'); assert.ok(core.status().revision > revision);
  await assert.rejects(core.command('queue.move', { entryId: 'entry-3', targetEntryId: 'entry-2', expectedRevision: revision }, 'Owner'), /状态已变化/);
  await core.command('player.pause', {}, 'Owner'); assert.equal(core.status().paused, true);
  await core.command('player.resume', {}, 'Owner'); assert.equal(core.status().playing, true);
  await assert.rejects(core.command('probe.error', {}, 'Owner'), error => !error.message.includes('fixture-secret') && !error.message.includes('private.invalid'));
  await assert.rejects(core.call('provider.getCookie'), /不可用/);
  await core.stop(); assert.equal(core.status().connected, false); assert.deepEqual(core.status().queue, []);
});

test('shutdown rejects in-flight requests and a failed audio worker disconnects exactly once', async t => {
  const core = create(); await core.init();
  const pending = assert.rejects(core.command('probe.delay', { ms: 1000 }), /已关闭/);
  await core.close(); await pending; await core.close();
  let disconnects = 0; let failures = 0; const failed = create({ onDisconnect: () => { disconnects++; }, onFailure: () => { failures++; } }); t.after(() => failed.close()); await failed.init();
  const unfinished = assert.rejects(failed.command('probe.delay', { ms: 1000 }), /停止|异常/);
  const unfinishedCatalog = assert.rejects(failed.provider.search('slow-catalog'), /已关闭|连接已关闭/);
  await failed.worker.terminate(); await unfinished; await unfinishedCatalog;
  assert.equal(disconnects, 1); assert.equal(failures, 1); assert.equal(failed.status().connected, false);
  await assert.rejects(failed.start({}), /停止|异常/);
});

test('catalog metadata bypasses the audio worker while real PCM and Opus frames continue', async t => {
  const core = create(); t.after(() => core.close()); await core.init();
  assert.equal(core.health().directCatalog, true);
  await core.start({ probeFrames: 500, queueSize: 500 });
  assert.equal(core.health().encoding.bitrate, 79200); assert.equal(core.health().encoding.variableBitrate, false);
  const repliesBefore = await core.command('probe.musicReplies', {});
  const framesBefore = core.health().frames;
  const queue = core.status().queue;
  const posted = []; const post = core.worker.postMessage.bind(core.worker);
  core.worker.postMessage = (...args) => { posted.push(args[0]); return post(...args); };
  const [found, songs, artist, users, lists] = await Promise.all([
    core.provider.search('cpu-stress-catalog'), core.provider.getPlaylistSongs('1'),
    core.provider.getArtistPage('99', 'hot', 0), core.provider.searchUsers('Public', 'nickname', 0),
    core.provider.getPublicUserPlaylists('42', 0)
  ]);
  assert.equal(found.songs.length, 30); assert.equal(songs.length, 500);
  assert.equal(artist.artist.id, '99'); assert.equal(users.users[0].id, '42'); assert.equal(lists.playlists.length, 1);
  assert.equal(posted.length, 0, 'directory requests must not be posted to the audio worker');
  assert.equal(await core.command('probe.musicReplies', {}), repliesBefore, 'metadata replies must not return through the audio-side music provider');
  assert.equal(core.status().queue, queue, 'directory responses do not resynchronize the queue');
  // The synthetic API burns CPU for about 540 ms; the real encoder keeps producing frames.
  await new Promise(resolve => setTimeout(resolve, 1100));
  const health = core.health();
  assert.ok(health.frames > framesBefore + 10, `only ${health.frames - framesBefore} frames advanced`);
  assert.equal(health.underruns, 0);
  t.diagnostic(JSON.stringify({ framesAdvanced: health.frames - framesBefore, maxFrameGapMs: health.maxFrameGapMs, lateTicks: health.lateTicks, metadataRepliesOnAudio: 0 }));
  await assert.rejects(core.call('provider.search', ['Fixture']), /不可用/);
});

test('direct catalog cache follows login changes and is rejected on audio worker shutdown', async t => {
  const core = create(); t.after(() => core.close()); await core.init();
  const [a, b] = await Promise.all([core.provider.getUserPlaylists(), core.provider.getUserPlaylists()]);
  assert.equal(a, b); assert.equal(await core.provider.getUserPlaylists(), a);
  await core.refreshAuth(); await core.command('probe.qrPending', { enabled: true });
  assert.equal((await core.qrCheck()).status, 'waiting');
  assert.equal(await core.provider.getUserPlaylists(), a, 'non-mutating auth refresh and QR polls retain cached metadata');
  await core.command('probe.qrPending', { enabled: false });
  const stale = assert.rejects(core.provider.search('slow-catalog'), /账号状态已变化/);
  await new Promise(resolve => setTimeout(resolve, 25));
  const login = core.qrCheck(); const authenticated = core.provider.getUserPlaylists();
  await login; await stale;
  const c = await authenticated; assert.match(c[0].name, /^fixture-cookie:/); assert.notEqual(c, a);
  const logout = core.logout(); const anonymous = core.provider.getUserPlaylists();
  await logout; assert.match((await anonymous)[0].name, /^Public playlist/);
  await assert.rejects(core.provider.search('denied'), error => error.status === 403 && !/private.invalid|do-not-forward/.test(error.message));
  const pending = assert.rejects(core.provider.search('slow-catalog'), /已关闭|连接已关闭/);
  await new Promise(resolve => setTimeout(resolve, 25));
  await core.close(); await pending;
  await assert.rejects(core.provider.search('Fixture'), /已关闭/);
});

test('channel arrivals and guarded announcements cross the private playback thread bridge', async t => {
  const arrivals = []; const core = create({ onChange: event => { if (event?.channelJoin) arrivals.push(event.channelJoin); } }); t.after(() => core.close());
  await core.init(); await core.start({ queueSize: 2, probeFrames: 500 });
  await core.command('probe.join', { channelId: '2' }); assert.equal(arrivals.length, 0);
  await core.command('probe.join', { channelId: '1' }); assert.equal(arrivals.length, 1);
  assert.deepEqual(await core.announcementTarget(), arrivals[0]);
  assert.deepEqual(Object.keys(arrivals[0]).sort(), ['channelId', 'connectionId']);
  const url = 'https://fixture.trycloudflare.com/#invite=' + 'a'.repeat(43);
  assert.equal(await core.sendShareAnnouncement({ ...arrivals[0], url }), true);
  const sent = await core.command('probe.announcements', {}); assert.equal(sent.length, 1); assert.equal(sent[0].target, 2);
  assert.equal(await core.sendShareAnnouncement({ ...arrivals[0], channelId: '2', url }), false);
  await core.stop(); assert.equal(await core.sendShareAnnouncement({ ...arrivals[0], url }), false);
});

test('shared control uses isolated playback and loses its session when the playback worker fails', async t => {
  const dataDirectory = resolve('work/core-host-service-' + randomUUID()); process.env.TSMD_DATA_DIR = dataDirectory;
  const [{ Service }, { createShareServer }, { createVault }] = await Promise.all([import('../src/worker/service.mjs'), import('../src/worker/share-server.mjs'), import('../src/shared/security.mjs')]);
  const key = randomBytes(32);
  const service = new Service(createVault(key), () => {}, { createCore: (_store, _vault, onChange, onDisconnect) => create({ key, dataDirectory, onChange, onDisconnect }) });
  await service.init(); const server = await createShareServer(service); t.after(async () => { server.close(); await service.close(); });
  const preset = await service.rpc('presets.save', { name: 'Fixture', serverAddress: '127.0.0.1', serverPassword: 'fixture-password' });
  await service.rpc('sharing.auto', { enabled: false });
  await service.rpc('bot.start', { id: preset.id }); const grant = await service.rpc('sharing.create', { name: 'Friend', permissions: ['view', 'volume'] });
  const origin = `http://127.0.0.1:${server.port}`;
  const post = async (path, body, extras = {}) => { const response = await fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...extras }, body: JSON.stringify(body) }); return { response, data: await response.json() }; };
  const raw = service.authority.grants.get(grant.id).raw; const exchanged = await post('/api/share/exchange', { token: raw });
  const credentials = { Cookie: exchanged.response.headers.get('set-cookie').split(';')[0], 'X-TSMD-CSRF': exchanged.data.csrf };
  const volume = await post('/api/share/rpc', { method: 'player.volume', args: { value: 31, runId: service.authority.runId }, id: randomUUID() }, credentials);
  assert.equal(volume.data.ok, true); assert.equal(service.snapshot().player.volume, 31); assert.equal(service.snapshot().player.queue.length, 500);
  const status = await post('/api/share/rpc', { method: 'status', id: randomUUID() }, credentials);
  assert.equal(status.data.result.audioHealth, undefined); assert.equal(status.data.result.auth, undefined);
  const denied = await post('/api/share/rpc', { method: 'music.search', args: { query: 'Denied' }, id: randomUUID() }, credentials); assert.equal(denied.data.ok, false);
  await service.rpc('sharing.permissions', { id: grant.id, permissions: ['view', 'search', 'volume'] });
  const search = await post('/api/share/rpc', { method: 'music.search', args: { query: 'Fixture' }, id: randomUUID() }, credentials);
  assert.equal(search.data.ok, true); assert.equal(search.data.result.songs.length, 30);
  assert.equal(search.data.result.songs[0].coverUrl, 'http://p5.music.126.net/fixture-cover.png');
  const artist = await post('/api/share/rpc', { method: 'music.artist', args: { id: '99', order: 'hot' }, id: randomUUID() }, credentials);
  assert.equal(artist.data.ok, true); assert.equal(artist.data.result.songs.length, 30);
  const mine = await service.rpc('playlists.list', { type: 'mine' }); assert.ok(mine.length);
  assert.equal(service.core.health().directCatalog, true); assert.equal(service.snapshot().player.queue.length, 500);
  // Fail on a JS turn boundary. Terminating while a native Opus call is in
  // progress can abort Node itself, which is not the session-revocation case.
  const crashed = new Promise(accept => service.core.worker.once('exit', accept));
  await service.core.command('probe.crash', {}).catch(() => {}); await crashed;
  assert.equal(service.phase, 'disconnected'); assert.equal(service.authority.runId, null);
  const revoked = await post('/api/share/rpc', { method: 'status', id: randomUUID() }, credentials); assert.equal(revoked.data.ok, false);
});
