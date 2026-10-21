import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { visitorName, publicUserQuery } from '../src/shared/visitor.mjs';
import { createVault } from '../src/shared/security.mjs';
process.env.TSMD_DATA_DIR = resolve('work/community-tests-' + randomUUID());
const { Service } = await import('../src/worker/service.mjs');
const track = id => ({ id: String(id), name: 'Song ' + id, artist: 'Artist', duration: 180, platform: 'netease' });
function fixture() {
  const calls = []; const provider = { getPublicSongs: async ids => ids.map(track), getPublicPlaylist: async id => ({ id, name: 'Public list', songs: [track(1),track(2)], songCount: 2, publicPreview: true }), searchUsers: async (query, mode) => ({ users: [{ id: '42', name: query }], mode }), getPublicUserPlaylists: async id => ({ user: { id, name: 'Public user' }, playlists: [] }) };
  const service = new Service(createVault(randomBytes(32)), () => {}, { createCore: () => ({ init() {}, close() {}, status: () => ({ queue: [track(1)], revision: 1 }), exportQueue: async () => [track(1)], health: () => ({}), provider, command: async (method, args, name) => { calls.push({ method, args, name }); return {}; } }) });
  const begin = async () => { await service.init(); service.phase = 'running'; service.authority.beginRun(); };
  const accessFor = grant => { const session = service.authority.exchange(grant.raw); return { owner: false, session: session.session, csrf: session.csrf }; };
  return { service, provider, calls, begin, accessFor };
}
test('visitor names and NetEase lookup modes validate display-only identities, UID links and phone restrictions', () => {
  assert.equal(visitorName('  小明\n  '), '小明'); assert.equal(visitorName('😀'.repeat(32)), '😀'.repeat(32));
  assert.throws(() => visitorName('😀'.repeat(33))); assert.throws(() => visitorName(''));
  assert.deepEqual(publicUserQuery('https://music.163.com/#/user/home?id=42', 'uid'), { query: '42', mode: 'uid' });
  assert.deepEqual(publicUserQuery('https://music.163.com/user/home?id=42', 'uid'), { query: '42', mode: 'uid' });
  assert.throws(() => publicUserQuery('13812345678', 'nickname'), /手机号/);
  assert.throws(() => publicUserQuery('https://attacker.invalid/user/home?id=42', 'uid'));
});
test('visitors sharing one link have independent names and cannot spoof queue attribution or grant permissions', async () => {
  const f = fixture(); const s = f.service;
  try {
    await f.begin(); const grant = s.authority.create('Same link', ['view','add','savePlaylist']); const a = f.accessFor(grant); const b = f.accessFor(grant);
    await s.rpc('identity.set', { name: 'Alice' }, a); await s.rpc('identity.set', { name: 'Bob' }, b);
    assert.equal((await s.rpc('status', {}, a)).visitor.name, 'Alice'); assert.equal((await s.rpc('status', {}, b)).visitor.name, 'Bob');
    await s.rpc('music.add', { id: '1', runId: s.authority.runId, requestedBy: 'Owner' }, a); await s.rpc('music.add', { id: '2', runId: s.authority.runId }, b);
    assert.deepEqual(f.calls.map(call => call.name), ['Alice','Bob']); assert.equal(grant.name, 'Same link'); assert.deepEqual(grant.permissions, ['view','add','savePlaylist']);
    const saved = await s.rpc('playlist.saveQueue', { runId: s.authority.runId, name: 'Alice list' }, a); assert.equal(saved.openedBy, 'Alice');
    const fresh = f.accessFor(grant); assert.equal((await s.rpc('status', {}, fresh)).visitor.name, '');
    await assert.rejects(s.rpc('identity.set', { name: 'X' }, { ...a, csrf: 'bad' }), /校验/);
    s.authority.revoke(grant.id); await assert.rejects(s.rpc('identity.set', { name: 'X' }, a), /失效/);
  } finally { await s.close(); }
});
test('authorized visitors build new playlists and share public lists with durable server-derived attribution', async () => {
  const f = fixture(); const s = f.service; let created;
  try {
    await f.begin(); const grant = s.authority.create('Friends', ['view','search','savePlaylist','playlist']); const a = f.accessFor(grant); const b = f.accessFor(grant);
    await s.rpc('identity.set', { name: 'Alice' }, a); await s.rpc('identity.set', { name: 'Bob' }, b);
    const args = { name: 'Built by Alice', ids: ['3','1','3'], runId: s.authority.runId };
    created = await s.rpc('playlist.create', args, a); assert.equal(created.openedBy, 'Alice'); assert.deepEqual(created.songs.map(song => song.id), ['3','1'], 'custom playlist creation keeps the first occurrence of each song');
    await assert.rejects(s.rpc('playlist.create', { ...args, id: created.id }, a), /覆盖/);
    await assert.rejects(s.rpc('playlist.create', { ...args, openedBy: 'Bob' }, a), /会话/);
    await assert.rejects(s.rpc('playlist.create', { ...args, ids: [] }, a), /1–500/);
    const preview = await s.rpc('playlist.preview', { id: '777' }, a); assert.equal(preview.publicPreview, true); assert.equal(preview.published, false);
    const opened = await s.rpc('playlist.share', { id: '777', runId: s.authority.runId }, a); assert.equal(opened.openedBy, 'Alice');
    assert.equal((await s.rpc('playlist.share', { id: '777', runId: s.authority.runId }, b)).openedBy, 'Alice', 'adding an already-open reference cannot take its attribution');
    await s.rpc('playlist.play', { id: created.id, expectedRevision: 1, runId: s.authority.runId }, b); assert.equal(f.calls.at(-1).name, 'Bob');
    const readOnly = f.accessFor(s.authority.create('Read only', ['view']));
    for (const method of ['playlist.create','playlist.share','music.users','music.userPlaylists','playlist.preview']) await assert.rejects(s.rpc(method, { ...args, id: '42' }, readOnly), /权限/);
    await assert.rejects(s.rpc('music.users', { query: '13812345678', mode: 'nickname' }, a), /手机号/);
    for (const method of ['playlist.publish','playlist.unpublish']) await assert.rejects(s.rpc(method, { id: created.id }, a), /本机/);
    f.provider.getPublicSongs = async ids => { s.authority.update(grant.id, ['view']); return ids.map(track); };
    await assert.rejects(s.rpc('playlist.create', args, a), /权限/);
  } finally { await s.close(); }
  const reopened = fixture(); try { await reopened.service.init(); assert.equal(reopened.service.store.localPlaylist(created.id).openedBy, 'Alice'); assert.ok(reopened.service.publications.some(item => item.id === '777' && item.openedBy === 'Alice')); } finally { await reopened.service.close(); }
});

test('legacy playlist schema gains attribution without losing saved tracks or open references', async () => {
  const old = fixture(); let saved;
  try {
    await old.service.init(); saved = await old.service.rpc('playlist.saveQueue', { name: 'Legacy snapshot' });
    old.service.store.publishPlaylist({ id: '999', name: 'Legacy reference' });
    old.service.store.db.exec('ALTER TABLE local_playlists DROP COLUMN opened_by');
  } finally { await old.service.close(); }
  const fresh = fixture(); try {
    await fresh.service.init(); const item = fresh.service.store.localPlaylist(saved.id);
    assert.equal(item.name, 'Legacy snapshot'); assert.equal(item.openedBy, '主人'); assert.deepEqual(item.songs.map(song => song.id), ['1']);
    assert.ok(fresh.service.publications.some(item => item.id === '999'));
  } finally { await fresh.service.close(); }
});

test('snapshot editing needs saving permission and all custom snapshots stay shared', async () => {
  const f = fixture(); const s = f.service; let edited;
  try {
    await f.begin(); const grant = s.authority.create('Friends', ['view','search','savePlaylist','playlist']); const a = f.accessFor(grant); await s.rpc('identity.set', { name: 'Alice' }, a);
    const original = await s.rpc('playlist.create', { name: 'Alice original', ids: ['3','1','2'], runId: s.authority.runId }, a);
    await assert.rejects(s.rpc('playlist.update', { id: original.id, name: 'Spoof', ids: ['1'], openedBy: 'Bob', expectedUpdatedAt: original.updatedAt, runId: s.authority.runId }, a), /署名/);
    const fetched = []; f.provider.getPublicSongs = async ids => { fetched.push(ids); return ids.map(track); };
    edited = await s.rpc('playlist.update', { id: original.id, name: 'Edited name', ids: ['2','3','4','2'], expectedUpdatedAt: original.updatedAt, runId: s.authority.runId }, a);
    assert.equal(edited.id, original.id); assert.equal(edited.name, 'Edited name'); assert.equal(edited.openedBy, 'Alice'); assert.equal(edited.createdAt, original.createdAt); assert.equal(edited.published, true); assert.ok(edited.updatedAt > original.updatedAt);
    assert.deepEqual(edited.songs.map(song => song.id), ['2','3','4']); assert.deepEqual(fetched, [['4']]); assert.equal(f.calls.length, 0); assert.equal(s.localPlaylists.filter(item => item.id === original.id).length, 1);
    await assert.rejects(s.rpc('playlist.update', { id: original.id, name: 'Stale', ids: ['1'], expectedUpdatedAt: original.updatedAt }), /已被更新/);
    await assert.rejects(s.rpc('playlist.unpublish', { id: original.id }), /统一开放/); const privateList = s.store.localPlaylist(original.id);
    const privateEdit = await s.rpc('playlist.update', { id: original.id, name: 'Still private', ids: ['3','2'], expectedUpdatedAt: privateList.updatedAt });
    assert.equal(privateEdit.published, true); assert.equal(privateEdit.openedBy, 'Alice'); assert.ok(s.publications.some(item => item.id === original.id));
    for (const ids of [[], ['bad'], Array.from({length:501},()=> '1')]) await assert.rejects(s.rpc('playlist.update', { id: original.id, name: 'Invalid', ids, expectedUpdatedAt: privateEdit.updatedAt }), /1–500/);
    await assert.rejects(s.rpc('playlist.update', { id: original.id, name: 'Spoof', ids: ['2'], expectedUpdatedAt: privateEdit.updatedAt, openedBy: 'Bob' }), /署名/);
    // A visitor can save an edited copy with its own name and attribution without touching the original.
    await s.rpc('identity.set', { name: 'Bob' }, a); const copy = await s.rpc('playlist.create', { name: 'Bob copy', ids: ['2','3'], runId: s.authority.runId }, a);
    assert.notEqual(copy.id, original.id); assert.equal(copy.openedBy, 'Bob'); assert.equal(s.store.localPlaylist(original.id).name, 'Still private');
  } finally { await s.close(); }
  const reopened = fixture(); try { await reopened.service.init(); const record = reopened.service.store.localPlaylist(edited.id); assert.equal(record.name, 'Still private'); assert.equal(record.openedBy, 'Alice'); assert.deepEqual(record.songs.map(song => song.id), ['3','2']); } finally { await reopened.service.close(); }
});

test('an edit cannot overwrite a playlist changed or removed while new song metadata was being loaded', async () => {
  const f = fixture(); const s = f.service;
  try {
    await f.begin(); const original = s.store.saveLocalPlaylist({ name: 'Before', songs: [track(1)] });
    f.provider.getPublicSongs = async ids => { s.store.updateLocalPlaylist({ id: original.id, name: 'Newer', songs: [track(2)], expectedUpdatedAt: original.updatedAt }); return ids.map(track); };
    await assert.rejects(s.rpc('playlist.update', { id: original.id, name: 'Old editor', ids: ['1','3'], expectedUpdatedAt: original.updatedAt }), /已被更新/);
    const newer = s.store.localPlaylist(original.id); assert.equal(newer.name, 'Newer'); assert.deepEqual(newer.songs.map(song=>song.id), ['2']);
    f.provider.getPublicSongs = async ids => { s.store.removeLocalPlaylist(original.id); return ids.map(track); };
    await assert.rejects(s.rpc('playlist.update', { id: original.id, name: 'Deleted editor', ids: ['2','4'], expectedUpdatedAt: newer.updatedAt }), /不存在/);
    f.provider.getPublicSongs = async () => [];
    const missing = s.store.saveLocalPlaylist({ name: 'Missing test', songs: [track(1)] });
    await assert.rejects(s.rpc('playlist.update', { id: missing.id, name: 'Incomplete', ids: ['1','9'], expectedUpdatedAt: missing.updatedAt }), /无法读取/);
    assert.equal(s.store.localPlaylist(missing.id).name, 'Missing test');
  } finally { await s.close(); }
});
