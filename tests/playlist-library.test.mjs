import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { playlistFile, readPlaylistFile, playlistDateName } from '../src/shared/playlist-format.mjs';
process.env.TSMD_DATA_DIR = resolve('work/playlist-library-' + randomUUID());
const [{ Service }, { createVault }] = await Promise.all([import('../src/worker/service.mjs'), import('../src/shared/security.mjs')]);
const track = id => ({ id: String(id), name: 'Song ' + id, artist: 'Artist', artists: [{ id: '99', name: 'Artist' }], popularity: 90, duration: 180, album: 'Album', coverUrl: 'http://p5.music.126.net/a.jpg?param=80y80&token=private-image', entryId: 'runtime-' + id, url: 'https://private.invalid/?token=media-secret', cookie: 'private-cookie' });
const key = randomBytes(32);
function fixture() {
  let queue = [track(1), track(2), track(1)]; const calls = [];
  const core = { init: async () => {}, status: () => ({ queue, revision: 1 }), health: () => ({}), exportQueue: async () => queue, auth: { loggedIn: false }, close() {},
    provider: { getPlaylistDetail: async id => ({ id, name: 'Cloud playlist', coverUrl: 'https://p7.music.126.net/list.jpg', songCount: 5, privateField: 'not-public' }) },
    command: async (method, args) => { calls.push({ method, args }); return {}; } };
  const service = new Service(createVault(key), () => {}, { createCore: () => core });
  return { service, core, calls, setQueue: value => { queue = value; } };
}
test('queue snapshots and open playlists survive a fresh service and new sharing runs without credentials or runtime fields', async () => {
  const first = fixture(); await first.service.init();
  const saved = await first.service.rpc('playlist.saveQueue', {});
  assert.match(saved.name, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/); assert.equal(saved.songCount, 3); assert.equal(saved.published, true);
  assert.deepEqual(saved.songs.map(song => song.id), ['1', '2', '1']);
  const serialized = JSON.stringify(saved); assert.ok(!/media-secret|private-cookie|runtime-|private-image/.test(serialized));
  assert.equal(saved.songs[0].coverUrl, 'https://p5.music.126.net/a.jpg?param=80y80');
  await first.service.rpc('playlist.publish', { id: '123' });
  first.service.authority.beginRun(); const oldGrant = first.service.authority.create('Old', ['view']); const oldSession = first.service.authority.exchange(oldGrant.raw);
  first.service.endRun(); assert.equal(first.service.publications.length, 2); await first.service.close();
  const second = fixture(); try {
    await second.service.init(); assert.equal(second.service.publications.length, 2);
    assert.equal(second.service.authority.grants.size, 0); assert.throws(() => second.service.authority.authenticate(oldSession.session, 'view'));
    second.service.authority.beginRun(); const grant = second.service.authority.create('New', ['view', 'playlist']); const session = second.service.authority.exchange(grant.raw);
    const access = { owner: false, session: session.session, csrf: session.csrf };
    assert.equal((await second.service.rpc('playlists.list', {}, access)).length, 2);
    const detail = await second.service.rpc('playlist.detail', { id: saved.id }, access); assert.equal(detail.songs.length, 3);
    second.service.phase = 'running'; await second.service.rpc('playlist.play', { id: saved.id, runId: second.service.authority.runId, expectedRevision: 1 }, access);
    assert.equal(second.calls[0].method, 'playlist.loadLocal'); assert.equal(second.calls[0].args.songs.length, 3);
    await assert.rejects(second.service.rpc('playlist.saveQueue', { runId: second.service.authority.runId }, access), /权限/);
    for (const method of ['playlist.import', 'playlist.publish', 'playlist.unpublish']) await assert.rejects(second.service.rpc(method, { id: saved.id }, access), /本机/);
    await assert.rejects(second.service.rpc('playlist.delete', { id: saved.id, runId: second.service.authority.runId }, access), /权限/);
    await assert.rejects(second.service.rpc('playlist.unpublish', { id: saved.id }), /统一开放/); assert.equal(second.service.publications.length, 2);
    assert.equal((await second.service.rpc('playlist.detail', { id: saved.id }, access)).published, true);
    await second.service.rpc('playlist.publish', { id: saved.id }); assert.equal(second.service.publications.length, 2);
    const oldCreated = detail.createdAt; second.setQueue([track(3)]);
    const updated = await second.service.rpc('playlist.saveQueue', { id: saved.id, name: 'Updated' });
    assert.equal(updated.id, saved.id); assert.equal(updated.name, 'Updated'); assert.equal(updated.createdAt, oldCreated); assert.equal(updated.songCount, 1);
    await second.service.rpc('playlist.delete', { id: saved.id }); assert.equal(second.service.localPlaylists.length, 0); assert.equal(second.core.status().queue[0].id, '3');
    await second.service.rpc('playlist.unpublish', { id: '123' });
  } finally { await second.service.close(); }
});

test('web queue saving requires explicit permission and a live run, creates metadata-only snapshots and never silently overwrites another playlist', async () => {
  const f = fixture(); const service = f.service;
  try {
    await service.init(); service.phase = 'running'; const runId = service.authority.beginRun();
    const existing = await service.rpc('playlist.saveQueue', { name: 'Owner original' });
    const grant = service.authority.create('Friend', ['view', 'playlist']); const session = service.authority.exchange(grant.raw);
    const access = { owner: false, session: session.session, csrf: session.csrf };
    await assert.rejects(service.rpc('playlist.saveQueue', { runId }, access), /权限/);
    assert.ok(!grant.permissions.includes('savePlaylist'), 'existing links never gain new permissions automatically');
    service.authority.update(grant.id, ['view', 'savePlaylist']);
    await assert.rejects(service.rpc('playlist.saveQueue', {}, access), /重新启动/);
    await assert.rejects(service.rpc('playlist.saveQueue', { runId: randomUUID() }, access), /重新启动/);
    for (const id of [existing.id, null, '']) await assert.rejects(service.rpc('playlist.saveQueue', { id, runId }, access), /覆盖/);
    const count = service.localPlaylists.length; const requestId = randomUUID();
    const args = { name: 'Friend snapshot', runId, songs: [track(999)], published: false };
    const saved = await service.rpc('playlist.saveQueue', args, access, requestId);
    assert.equal((await service.rpc('playlist.saveQueue', args, access, requestId)).id, saved.id, 'a retry creates only one snapshot');
    assert.equal(service.localPlaylists.length, count + 1); assert.notEqual(saved.id, existing.id); assert.equal(saved.name, args.name); assert.equal(saved.published, true);
    assert.deepEqual(saved.songs.map(song => song.id), ['1', '2', '1'], 'songs come from the live core, never the web request');
    assert.ok(!/media-secret|private-cookie|runtime-|private-image/.test(JSON.stringify(saved)));
    assert.equal(service.store.localPlaylist(existing.id).name, 'Owner original');
    const shared = await service.rpc('status', {}, access); assert.ok(shared.publications.some(item => item.id === saved.id)); assert.equal(shared.localPlaylists, undefined);
    for (const method of ['playlist.import', 'playlist.publish', 'playlist.unpublish']) await assert.rejects(service.rpc(method, { id: saved.id, runId }, access), /本机/);
    await assert.rejects(service.rpc('playlist.delete', { id: saved.id, runId }, access), /已被更新/);
    const normalExport = f.core.exportQueue;
    f.core.exportQueue = async () => { service.authority.update(grant.id, ['view']); return normalExport(); };
    await assert.rejects(service.rpc('playlist.saveQueue', { runId }, access), /权限/);
    assert.equal(service.localPlaylists.length, count + 1, 'permission is rechecked after export before SQLite write');
    service.authority.update(grant.id, ['view', 'savePlaylist']); f.core.exportQueue = normalExport;
    service.endRun(); await assert.rejects(service.rpc('playlist.saveQueue', { runId }, access), /失效/);
  } finally { await service.close(); }
  const reopened = fixture(); try { await reopened.service.init(); assert.ok(reopened.service.publications.some(item => item.name === 'Friend snapshot')); } finally { await reopened.service.close(); }
});
test('portable playlist files whitelist metadata, default names and validate imports without sharing write access', async () => {
  assert.equal(playlistDateName(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02 03:04:05');
  const file = playlistFile('My queue', [track(4)], [{ id: '456', name: 'Open backup', coverUrl: 'https://p5.music.126.net/cover.jpg', privateField: 'must-not-copy' }]); assert.ok(!JSON.stringify(file).includes('media-secret')); assert.ok(!JSON.stringify(file).includes('must-not-copy'));
  assert.equal(readPlaylistFile(file).name, 'My queue'); assert.throws(() => readPlaylistFile({ songs: [track(1)] }), /JSON/);
  const f = fixture(); try {
    await f.service.init(); const imported = await f.service.rpc('playlist.import', { file }); assert.equal(imported.published, true); assert.equal(imported.songs[0].id, '4');
    assert.ok(f.service.publications.some(item => item.id === '456'));
    await assert.rejects(f.service.rpc('playlist.import', { file: { ...file, songs: [track('../bad')] } }), /ID/);
    await assert.rejects(f.service.rpc('playlist.import', { file: { ...file, songs: [] } }), /不能为空/);
    await assert.rejects(f.service.rpc('playlist.import', { file: { ...file, songs: Array.from({ length: 501 }, () => track(1)) } }), /500/);
  } finally { await f.service.close(); }
});
