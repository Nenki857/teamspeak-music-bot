import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { observeChannelJoins } from '../src/worker/channel-joins.mjs';
import { ShareAnnouncement, ANNOUNCEMENT_COOLDOWN_MS } from '../src/worker/share-announcement.mjs';
import { CommandGate, createVault } from '../src/shared/security.mjs';
import { TestTunnel } from './fixtures/test-tunnel.mjs';
process.env.TSMD_DATA_DIR = resolve('work/share-announcement-' + randomUUID());
const { CoreEngine } = await import('../src/worker/core-engine.mjs');
const { Service } = await import('../src/worker/service.mjs');
const url = 'https://fixture.trycloudflare.com/#invite=' + 'a'.repeat(43);
function clock() {
  let now = 1000; let id = 0; const tasks = new Map();
  return { now: () => now, advance: () => { now += ANNOUNCEMENT_COOLDOWN_MS; }, tasks,
    schedule: fn => { tasks.set(++id, fn); return id; }, cancel: id => tasks.delete(id), fire: () => { const copy = [...tasks.values()]; tasks.clear(); for (const fn of copy) fn(); } };
}

test('TS push events identify genuine arrivals in the current channel, deduplicate presence and detach cleanly', () => {
  const client = new EventEmitter(); let channel = 1n;
  client.getChannelId = () => channel; client.getClientId = () => 9;
  const joins = []; const stop = observeChannelJoins(client, event => joins.push(event));
  client.emit('clientEnter', { id: 9, channelID: 1n });
  client.emit('clientEnter', { id: 1, channelID: 2n });
  client.emit('clientEnter', { id: 2, channelID: 1n, type: 1 });
  assert.equal(joins.length, 0);
  client.emit('clientEnter', { id: 1, channelID: 1n, type: 0, nickname: 'Private', uid: 'private-uid' });
  client.emit('clientMoved', { id: 1, targetChannelID: 1n }); assert.deepEqual(joins, [{ channelId: '1' }]);
  client.emit('clientMoved', { id: 1, targetChannelID: 2n }); client.emit('clientMoved', { id: 1, targetChannelID: 1n });
  client.emit('clientLeave', { id: 1 }); client.emit('clientEnter', { id: 1, channelID: 1n }); assert.equal(joins.length, 3);
  channel = 2n; client.emit('clientMoved', { id: 9, targetChannelID: 2n }); client.emit('clientEnter', { id: 1, channelID: 2n }); assert.equal(joins.at(-1).channelId, '2');
  stop(); for (const name of ['clientEnter', 'clientMoved', 'clientLeave']) assert.equal(client.listenerCount(name), 0);
});

test('channel sending verifies the exact connection and channel and only builds the intended control link message', async () => {
  const messages = []; const engine = Object.create(CoreEngine.prototype); engine.connectionId = 'connection';
  engine.bot = () => ({ isConnected: () => true, tsClient: { getChannelId: () => 1n, sendTextMessage: async (...args) => messages.push(args) } });
  assert.equal(await engine.sendShareAnnouncement({ connectionId: 'old', channelId: '1', url }), false);
  assert.equal(await engine.sendShareAnnouncement({ connectionId: 'connection', channelId: '2', url }), false);
  await assert.rejects(engine.sendShareAnnouncement({ connectionId: 'connection', channelId: '1', url: 'https://attacker.invalid/' }), /地址/);
  assert.equal(await engine.sendShareAnnouncement({ connectionId: 'connection', channelId: '1', url }), true);
  assert.deepEqual(messages, [[`音乐控制台：[URL=${url}]点此打开网页点歌 / 切歌[/URL]`, 2, true]]);
});

test('arrival bursts coalesce and use the latest tunnel address with a three-second cooldown', async () => {
  const time = clock(); const gate = new CommandGate(); const messages = []; let context = { runId: 'run', url };
  const auto = new ShareAnnouncement({ ...time, gate, current: () => context, send: async event => { messages.push(event); return true; }, changed() {} });
  auto.joined({ channelId: '1' }); assert.equal(time.tasks.size, 0);
  auto.configure('grant'); for (let i = 0; i < 10; i++) auto.joined({ channelId: '1', connectionId: 'connection' }); assert.equal(time.tasks.size, 1);
  context = { ...context, url: url.replace('fixture.', 'latest.') }; time.fire(); await gate.tail;
  assert.equal(messages.length, 1); assert.equal(messages[0].url, context.url); assert.equal(auto.state().lastSentAt, time.now());
  auto.joined({ channelId: '1' }); assert.equal(time.tasks.size, 1, 'arrivals during cooldown receive one trailing message'); assert.equal(messages.length, 1);
  time.advance(); auto.joined({ channelId: '1' }); time.fire(); await gate.tail; assert.equal(messages.length, 2);
});

test('cancellation invalidates delayed and queued sends; failed sends remain bounded and redact private errors', async () => {
  const time = clock(); const gate = new CommandGate(); const messages = []; let context = { runId: 'run', url };
  const auto = new ShareAnnouncement({ ...time, gate, current: () => context, send: async event => { messages.push(event); throw new Error(url); }, changed() {} });
  auto.configure('grant'); auto.joined({ channelId: '1' }); auto.reset(); time.fire(); await gate.tail; assert.equal(messages.length, 0);
  let release; const blocker = new Promise(resolve => { release = resolve; }); gate.run('blocker', randomUUID(), () => blocker);
  auto.configure('grant'); auto.joined({ channelId: '1' }); time.fire(); auto.clearPending(); release(); await gate.tail; assert.equal(messages.length, 0);
  auto.joined({ channelId: '1' }); context = { ...context, runId: 'new-run' }; time.fire(); await gate.tail; assert.equal(messages.length, 0);
  auto.joined({ channelId: '1' }); time.fire(); await gate.tail; assert.equal(messages.length, 1);
  assert.match(auto.state().error, /文字消息/); assert.ok(!auto.state().error.includes('trycloudflare'));
  auto.joined({ channelId: '1' }); assert.equal(time.tasks.size, 1); assert.equal(messages.length, 1, 'a failure never triggers an immediate retry'); auto.reset();
});

test('new links default to arrival distribution and only the owner can change the selection or cancel it', async () => {
  const sent = []; let notify;
  const core = { init: async () => {}, close() {}, status: () => ({ connected: true, queue: [] }), health: () => ({}), announcementTarget: async () => ({ channelId: '1', connectionId: 'connection' }), sendShareAnnouncement: async event => { sent.push(event); return true; } };
  const service = new Service(createVault(randomBytes(32)), () => {}, { createCore: (_store, _vault, callback) => { notify = callback; return core; } });
  const time = clock(); Object.assign(service.announcement, { now: time.now, schedule: time.schedule, cancel: time.cancel });
  try {
    await service.init(); service.phase = 'running'; service.authority.beginRun();
    const a = await service.rpc('sharing.create', { name: 'A', permissions: ['view'] }); const b = await service.rpc('sharing.create', { name: 'B', permissions: ['view', 'skip'] });
    assert.equal(service.announcement.grantId, b.id, 'latest created link is selected even before the public entry is available'); assert.equal(sent.length, 0);
    const session = service.authority.exchange(service.authority.grants.get(a.id).raw); const access = { owner: false, session: session.session, csrf: session.csrf };
    await assert.rejects(service.rpc('sharing.announce', { enabled: true, grantId: a.id }, access), /本机/);
    await assert.rejects(service.rpc('sharing.announce', { enabled: true, grantId: a.id }), /公网/);
    service.tunnel.state = { status: 'online', url: 'https://fixture.trycloudflare.com' };
    await assert.rejects(service.rpc('sharing.announce', { enabled: 'true', grantId: a.id }), /无效/);
    await assert.rejects(service.rpc('sharing.announce', { enabled: true, grantId: randomUUID() }), /有效授权/);
    await service.rpc('sharing.announce', { enabled: true, grantId: a.id }); assert.equal(sent.length, 1, 'selecting an unpublished link sends it immediately');
    notify({ channelJoin: { channelId: '1', connectionId: 'connection' } }); await service.rpc('sharing.announce', { enabled: true, grantId: b.id }); time.fire(); await service.gate.tail; assert.equal(sent.length, 2);
    notify({ channelJoin: { channelId: '1', connectionId: 'connection' } }); time.advance(); time.fire(); await service.gate.tail;
    assert.equal(sent.length, 3); assert.ok(sent[2].url.endsWith(service.authority.grants.get(b.id).raw));
    assert.deepEqual(service.authority.grants.get(b.id).permissions, ['view', 'skip']); assert.equal(service.snapshot(false).shareAnnouncement, undefined);
    time.advance(); notify({ channelJoin: { channelId: '1', connectionId: 'connection' } }); await service.rpc('sharing.revoke', { id: b.id }); time.fire(); await service.gate.tail; assert.equal(sent.length, 3); assert.equal(service.snapshot().shareAnnouncement.enabled, false);
    await service.rpc('sharing.announce', { enabled: true, grantId: a.id }); notify({ channelJoin: { channelId: '1' } }); await service.rpc('sharing.disable'); time.fire(); await service.gate.tail; assert.equal(sent.length, 3);
    service.tunnel.state = { status: 'online', url: 'https://new.trycloudflare.com' }; await service.rpc('sharing.announce', { enabled: true, grantId: a.id });
    assert.equal(sent.length, 4, 'a changed public URL is published without waiting for arrivals');
    notify({ channelJoin: { channelId: '1' } }); service.endRun(); time.fire(); await service.gate.tail; assert.equal(sent.length, 4); assert.equal(service.snapshot().shareAnnouncement.enabled, false);
  } finally { await service.close(); }
});

test('creation and public-address updates publish every live link once, deduplicate callbacks and cancel stale work', async () => {
  const sent = []; const service = new Service(createVault(randomBytes(32)), () => {}, {
    createTunnel: changed => new TestTunnel(changed),
    createCore: () => ({ init() {}, close() {}, health: () => ({}), status: () => ({ queue: [] }), announcementTarget: async () => ({ channelId: '1', connectionId: 'connection' }), sendShareAnnouncement: async event => { sent.push(event); return true; } })
  });
  try {
    await service.init(); service.phase = 'running'; service.authority.beginRun();
    const a = await service.rpc('sharing.create', { name: 'A', permissions: ['view'] }); const b = await service.rpc('sharing.create', { name: 'B', permissions: ['skip'] });
    assert.equal(sent.length, 0); assert.equal(service.snapshot().grants[0].delivery.status, 'waiting');
    await service.rpc('sharing.enable'); await service.gate.tail; assert.equal(sent.length, 2);
    assert.ok(sent[0].url.endsWith(service.authority.grants.get(a.id).raw)); assert.ok(sent[1].url.endsWith(service.authority.grants.get(b.id).raw));
    service.tunnel.changed(); service.tunnel.changed(); await service.gate.tail; assert.equal(sent.length, 2);
    service.tunnel.state = { status: 'online', url: 'https://latest.trycloudflare.com' }; service.tunnel.changed(); await service.gate.tail;
    assert.equal(sent.length, 4); assert.ok(sent.slice(2).every(event => event.url.startsWith('https://latest.')));
    const id = randomUUID(); const c = await service.rpc('sharing.create', { name: 'C', permissions: ['view'] }, undefined, id);
    assert.deepEqual(await service.rpc('sharing.create', { name: 'C', permissions: ['view'] }, undefined, id), c); assert.equal(sent.length, 5);
    assert.equal(service.announcement.grantId, c.id); assert.ok(service.snapshot().grants.every(grant => grant.delivery.status === 'sent'));
    assert.ok(service.snapshot().grants.every(grant => !Object.hasOwn(grant.delivery, 'url')));
    await service.rpc('sharing.permissions', { id: c.id, permissions: ['skip'] }); await service.rpc('sharing.send', { grantId: c.id }); assert.equal(sent.length, 5);
    let release; service.gate.run('blocker', randomUUID(), () => new Promise(resolve => { release = resolve; })); await Promise.resolve();
    service.tunnel.state = { status: 'online', url: 'https://obsolete.trycloudflare.com' }; service.tunnel.changed();
    service.endRun(); release(); await service.gate.tail; assert.equal(sent.length, 5);
  } finally { await service.close(); }
});

test('link publication failures are visible without leaking tokens and owner retries preserve permissions', async () => {
  let fail = true; let target = true; const sent = [];
  const service = new Service(createVault(randomBytes(32)), () => {}, {
    createTunnel: changed => new TestTunnel(changed),
    createCore: () => ({ init() {}, close() {}, health: () => ({}), status: () => ({ queue: [] }), announcementTarget: async () => target ? { channelId: '1', connectionId: 'connection' } : null,
      sendShareAnnouncement: async event => { if (fail) throw new Error(event.url); sent.push(event); return true; } })
  });
  try {
    await service.init(); service.phase = 'running'; service.authority.beginRun(); await service.rpc('sharing.enable');
    const grant = await service.rpc('sharing.create', { name: 'A', permissions: ['view','skip'] });
    let delivery = service.snapshot().grants[0].delivery; assert.equal(delivery.status, 'error'); assert.match(delivery.error, /文字消息/); assert.ok(!delivery.error.includes('trycloudflare'));
    assert.equal(service.phase, 'running'); assert.equal(service.authority.grants.size, 1);
    const session = service.authority.exchange(service.authority.grants.get(grant.id).raw);
    await assert.rejects(service.rpc('sharing.send', { grantId: grant.id }, { owner: false, session: session.session, csrf: session.csrf }), /本机/);
    fail = false; target = false; assert.equal(await service.rpc('sharing.send', { grantId: grant.id }), false); assert.equal(service.snapshot().grants[0].delivery.status, 'error');
    target = true; assert.equal(await service.rpc('sharing.send', { grantId: grant.id }), true); delivery = service.snapshot().grants[0].delivery;
    assert.equal(delivery.status, 'sent'); assert.equal(delivery.error, ''); assert.equal(sent.length, 1);
    assert.deepEqual(service.authority.grants.get(grant.id).permissions, ['view','skip']);
    await service.rpc('sharing.revoke', { id: grant.id }); await assert.rejects(service.rpc('sharing.send', { grantId: grant.id }), /有效授权/);
  } finally { await service.close(); }
});
