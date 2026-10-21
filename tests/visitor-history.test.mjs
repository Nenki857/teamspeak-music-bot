import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createVault } from '../src/shared/security.mjs';
process.env.TSMD_DATA_DIR = resolve('work/visitor-history-tests-' + randomUUID());
const { Service } = await import('../src/worker/service.mjs');
function fixture() {
  const calls = [];
  const service = new Service(createVault(randomBytes(32)), () => {}, { createCore: () => ({
    init() {}, close() {}, health: () => ({}), status: () => ({ queue: [], revision: 1 }),
    command: async (method, args, name) => { calls.push({ method, name }); return {}; }
  }) });
  const accessFor = grant => { const session = service.authority.exchange(grant.raw); return { owner: false, session: session.session, csrf: session.csrf }; };
  return { service, calls, accessFor };
}

test('nickname history normalizes, deduplicates, orders recent choices and bounds stored entries', async () => {
  const { service: s } = fixture();
  try {
    await s.init(); s.store.db.exec('DELETE FROM visitor_names');
    assert.equal(s.store.rememberVisitorName('  小明\n  '), '小明');
    s.store.rememberVisitorName("O'Brien 😀"); s.store.rememberVisitorName('小明');
    assert.deepEqual(s.store.visitorNames(), ['小明', "O'Brien 😀"]);
    assert.throws(() => s.store.rememberVisitorName('')); assert.throws(() => s.store.rememberVisitorName('😀'.repeat(33)));
    for (let i = 0; i < 201; i++) s.store.rememberVisitorName('Visitor ' + i);
    assert.equal(s.store.visitorNames().length, 200); assert.equal(s.store.visitorNames()[0], 'Visitor 200');
    assert.equal(s.store.visitorNames().includes('Visitor 0'), false);
    s.store.rememberVisitorName('Visitor 1'); assert.equal(s.store.visitorNames()[0], 'Visitor 1');
    assert.equal(s.store.db.prepare('SELECT count(*) AS n FROM visitor_names').get().n, 200);
  } finally { await s.close(); }
});

test('new links and restarted services retain display-name choices while sessions and permissions remain independent', async () => {
  const f = fixture(); const s = f.service; let oldAccess;
  try {
    await s.init(); s.store.db.exec('DELETE FROM visitor_names'); s.phase = 'running'; s.authority.beginRun();
    const first = s.authority.create('First link', ['view','add']); oldAccess = f.accessFor(first);
    await s.rpc('identity.set', { name: 'Alice' }, oldAccess);
    const bob = f.accessFor(first); await s.rpc('identity.set', { name: 'Bob' }, bob);
    assert.deepEqual((await s.rpc('identity.history', {}, oldAccess)).names, ['Bob','Alice']);
    assert.equal(Object.hasOwn(await s.rpc('status', {}, oldAccess), 'visitorHistory'), false, 'history is read only on demand, not in periodic snapshots');
    await assert.rejects(s.rpc('identity.history', {}, { owner: false, session: 'invalid', csrf: '' }));
    await assert.rejects(s.rpc('identity.history', {}, { ...bob, csrf: 'bad' }), /校验/);
    await assert.rejects(s.rpc('identity.set', { name: 'Rejected' }, { ...bob, csrf: 'bad' }), /校验/);
    assert.equal(s.store.visitorNames().includes('Rejected'), false);
    s.authority.revoke(first.id); await assert.rejects(s.rpc('identity.history', {}, oldAccess), /失效/);
    s.endRun(); s.authority.beginRun();
    const second = s.authority.create('New link', ['view']); const newAccess = f.accessFor(second);
    assert.equal((await s.rpc('status', {}, newAccess)).visitor.name, '');
    assert.deepEqual((await s.rpc('identity.history', {}, newAccess)).names, ['Bob','Alice']);
    await s.rpc('identity.set', { name: 'Alice' }, newAccess);
    assert.deepEqual((await s.rpc('status', {}, newAccess)).permissions, ['view']);
    await assert.rejects(s.rpc('music.add', { id: '1', runId: s.authority.runId }, newAccess), /权限/);
  } finally { await s.close(); }
  const fresh = fixture();
  try {
    await fresh.service.init(); fresh.service.phase = 'running'; fresh.service.authority.beginRun();
    const grant = fresh.service.authority.create('After restart', ['view','add']); const a = fresh.accessFor(grant); const b = fresh.accessFor(grant);
    assert.deepEqual((await fresh.service.rpc('identity.history', {}, a)).names, ['Alice','Bob']);
    await assert.rejects(fresh.service.rpc('identity.history', {}, oldAccess), /失效/);
    await fresh.service.rpc('identity.set', { name: 'Alice' }, a); await fresh.service.rpc('identity.set', { name: 'Bob' }, b);
    await fresh.service.rpc('music.add', { id: '1', runId: fresh.service.authority.runId }, a);
    await fresh.service.rpc('music.add', { id: '2', runId: fresh.service.authority.runId }, b);
    assert.deepEqual(fresh.calls.map(call => call.name), ['Alice','Bob']);
    assert.equal((await fresh.service.rpc('status', {}, a)).visitor.name, 'Alice');
    assert.equal((await fresh.service.rpc('status', {}, b)).visitor.name, 'Bob');
  } finally { await fresh.service.close(); }
});

test('authorized history removal persists without renaming sessions, changing attribution or restoring deleted names automatically', async () => {
  const f = fixture(); const s = f.service; let playlist;
  try {
    await s.init(); s.store.db.exec('DELETE FROM visitor_names'); s.phase = 'running'; s.authority.beginRun();
    const grant = s.authority.create('Friends', ['view','add']); const a = f.accessFor(grant); const b = f.accessFor(grant);
    await s.rpc('identity.set', { name: 'Alice' }, a); await s.rpc('identity.set', { name: 'Bob' }, b);
    playlist = s.store.saveLocalPlaylist({ name: 'Saved attribution', songs: [{ id: '1', name: 'Song' }], openedBy: 'Bob' });
    await assert.rejects(s.rpc('identity.remove', { name: 'Bob' }, { ...a, csrf: 'bad' }), /校验/);
    await assert.rejects(s.rpc('identity.remove', { name: 'Bob' }, { owner: false, session: 'invalid', csrf: '' }));
    await assert.rejects(s.rpc('identity.remove', { name: '' }, a));
    await assert.rejects(s.rpc('identity.set', { name: 'Invalid remember flag', remember: 'false' }, a), /设置无效/);
    assert.deepEqual(await s.rpc('identity.remove', { name: 'Bob' }, a), { name: 'Bob', removed: true });
    assert.deepEqual((await s.rpc('identity.history', {}, a)).names, ['Alice']);
    assert.equal((await s.rpc('status', {}, b)).visitor.name, 'Bob'); assert.equal((await s.rpc('status', {}, a)).visitor.name, 'Alice');
    assert.equal(s.store.localPlaylist(playlist.id).openedBy, 'Bob'); assert.equal(f.calls.length, 0); assert.deepEqual(grant.permissions, ['view','add']);
    await s.rpc('identity.set', { name: 'Bob', remember: false }, b); assert.equal(s.store.visitorNames().includes('Bob'), false, 'browser auto-restore cannot recreate a removed history row');
    await s.rpc('identity.remove', { name: 'Alice' }, a); assert.deepEqual(s.store.visitorNames(), []);
    assert.deepEqual(await s.rpc('identity.remove', { name: 'Alice' }, a), { name: 'Alice', removed: false });
    s.authority.revoke(grant.id); await assert.rejects(s.rpc('identity.remove', { name: 'Bob' }, a), /失效/);
  } finally { await s.close(); }
  const fresh = fixture();
  try {
    await fresh.service.init(); assert.deepEqual(fresh.service.store.visitorNames(), []); assert.equal(fresh.service.store.localPlaylist(playlist.id).openedBy, 'Bob');
    fresh.service.phase = 'running'; fresh.service.authority.beginRun(); const a = fresh.accessFor(fresh.service.authority.create('New link', ['view']));
    await fresh.service.rpc('identity.set', { name: 'Bob', remember: false }, a); assert.deepEqual(fresh.service.store.visitorNames(), []);
    await fresh.service.rpc('identity.set', { name: 'Bob' }, a); assert.deepEqual(fresh.service.store.visitorNames(), ['Bob'], 'explicitly saving the name can add it again');
  } finally { await fresh.service.close(); }
});
