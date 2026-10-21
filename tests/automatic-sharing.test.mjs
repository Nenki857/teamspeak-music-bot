import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createVault, ALL_PERMISSIONS } from '../src/shared/security.mjs';
import { TestTunnel } from './fixtures/test-tunnel.mjs';
process.env.TSMD_DATA_DIR = resolve('work/automatic-sharing-' + randomUUID());
const { Service } = await import('../src/worker/service.mjs');
const key = randomBytes(32);
async function fixture(options = {}, resetSetting = true) {
  const sent = []; let sendAttempts = 0; let connected = false; let connection = 0; const calls = [];
  const service = new Service(createVault(key), () => {}, {
    autoShareRetryMs: options.retryMs ?? 10,
    createTunnel: changed => new TestTunnel(changed, options),
    createCore: () => ({ init() {}, close() {}, health: () => ({}), status: () => ({ connected, queue: [] }),
      start: async () => { if (options.tsFail) throw new Error('Synthetic TS failure'); connected = true; connection++; }, stop: async () => { connected = false; },
      announcementTarget: async () => connected ? { channelId: '1', connectionId: String(connection) } : null,
      sendShareAnnouncement: async event => { if (++sendAttempts <= (options.sendFailures || 0) || options.sendFail) throw new Error('private token=' + event.url); sent.push(event); return connected; },
      command: async method => { calls.push(method); return {}; } }) });
  await service.init(); service.sharePort = 12345;
  if (resetSetting) await service.rpc('sharing.auto', { enabled: true });
  const preset = await service.rpc('presets.save', { name: 'Automatic sharing', serverAddress: '127.0.0.1' });
  return { service, preset, sent, calls, get sendAttempts() { return sendAttempts; }, connect: () => service.rpc('bot.start', { id: preset.id }) };
}
test('connecting automatically opens the public entry, creates one all-permission grant and sends it to the channel', async () => {
  const f = await fixture(); const s = f.service;
  try {
    assert.equal(s.snapshot().autoSharing.enabled, true); await f.connect(); await s.autoShareTask;
    assert.equal(s.phase, 'running'); assert.equal(s.tunnel.starts, 1); assert.equal(s.tunnel.port, 12345);
    assert.equal(s.authority.grants.size, 1); const grant = [...s.authority.grants.values()][0];
    assert.equal(grant.name, '频道共享（自动）'); assert.deepEqual(grant.permissions, ALL_PERMISSIONS);
    assert.equal(f.sent.length, 1); assert.equal(f.sent[0].channelId, '1'); assert.ok(f.sent[0].url.endsWith(grant.raw));
    assert.equal(s.announcement.grantId, grant.id); assert.equal(s.snapshot().autoSharing.status, 'ready'); assert.equal(s.snapshot(false).autoSharing, undefined);
    const session = s.authority.exchange(grant.raw); const access = { owner: false, session: session.session, csrf: session.csrf };
    for (const method of ['sharing.auto','sharing.autoRetry']) await assert.rejects(s.rpc(method, { enabled: true }, access), /本机/);
  } finally { await s.close(); }
});
test('a slow tunnel does not block playback controls, deduplicates concurrent attempts and stops cleanly', async () => {
  const f = await fixture({ defer: true }); const s = f.service;
  try {
    await f.connect(); const task = s.autoShareTask; assert.equal(s.phase, 'running'); assert.equal(s.autoShareState.status, 'starting');
    assert.equal(s.startAutomaticSharing(), task); await s.rpc('sharing.autoRetry'); assert.equal(s.tunnel.starts, 1);
    await s.rpc('player.volume', { value: 20 }); assert.deepEqual(f.calls, ['player.volume']);
    await s.rpc('bot.stop'); await task; assert.equal(s.autoShareTask, null); assert.equal(s.phase, 'stopped'); assert.equal(s.authority.grants.size, 0); assert.equal(f.sent.length, 0); assert.equal(s.tunnel.state.status, 'off');
    s.tunnel.options.defer = false; await f.connect(); await s.autoShareTask; assert.equal(s.authority.grants.size, 1); assert.equal(f.sent.length, 1);
  } finally { await s.close(); }
});
test('tunnel and message failures keep TS online; retry reuses the grant and preserves edited permissions', async () => {
  const options = { fail: true }; const f = await fixture(options); const s = f.service;
  try {
    await f.connect(); await s.autoShareTask; assert.equal(s.phase, 'running'); assert.equal(s.autoShareState.status, 'error'); assert.equal(s.authority.grants.size, 0);
    options.fail = false; options.sendFail = true; await s.rpc('sharing.autoRetry'); await s.autoShareTask;
    assert.equal(s.authority.grants.size, 1); assert.equal(s.autoShareState.status, 'error'); assert.ok(!s.autoShareState.error.includes('trycloudflare'));
    const id = s.autoGrantId; await s.rpc('sharing.permissions', { id, permissions: ['view','search'] }); options.sendFail = false;
    await s.rpc('sharing.autoRetry'); await s.autoShareTask; assert.equal(s.autoShareState.status, 'ready'); assert.equal(s.authority.grants.size, 1); assert.equal(s.autoGrantId, id);
    assert.deepEqual(s.authority.grants.get(id).permissions, ['view','search']); assert.equal(f.sent.length, 1); assert.equal(s.tunnel.starts, 3, 'retrying a message must reuse an online tunnel');
    await s.rpc('sharing.revoke', { id }); assert.equal(s.announcement.grantId, ''); assert.equal(s.autoShareState.status, 'off');
  } finally { await s.close(); }
});
test('manual shutdown cancels startup and failed TS connections never open the public entry', async () => {
  const f = await fixture({ defer: true }); const s = f.service;
  try { await f.connect(); const task = s.autoShareTask; await s.rpc('sharing.disable'); await task; assert.equal(s.tunnel.state.status, 'off'); assert.equal(s.authority.grants.size, 0); assert.equal(f.sent.length, 0); assert.equal(s.phase, 'running'); }
  finally { await s.close(); }
  const failed = await fixture({ tsFail: true }); try { await assert.rejects(failed.connect(), /TS failure/); assert.equal(failed.service.tunnel.starts, 0); assert.equal(failed.service.authority.grants.size, 0); } finally { await failed.service.close(); }
});
test('disabling automatic sharing persists across reopening and prevents automatic public connections', async () => {
  const f = await fixture(); try { await f.service.rpc('sharing.auto', { enabled: false }); await f.connect(); assert.equal(f.service.tunnel.starts, 0); assert.equal(f.service.authority.grants.size, 0); } finally { await f.service.close(); }
  const reopened = await fixture({}, false); try { assert.equal(reopened.service.snapshot().autoSharing.enabled, false); await reopened.connect(); assert.equal(reopened.service.tunnel.starts, 0); assert.equal(reopened.service.authority.grants.size, 0); } finally { await reopened.service.close(); }
});

test('enabling automatic sharing while TS is already connected publishes immediately without any arrival event', async () => {
  const f = await fixture({ defer: true }); const s = f.service;
  try {
    await s.rpc('sharing.auto', { enabled: false }); await f.connect(); assert.equal(s.tunnel.starts, 0); assert.equal(f.sent.length, 0);
    await s.rpc('sharing.auto', { enabled: true }); const task = s.autoShareTask;
    assert.equal(s.phase, 'running'); assert.equal(s.autoShareState.status, 'starting'); assert.equal(s.tunnel.starts, 1);
    s.tunnel.complete(); await task; assert.equal(f.sent.length, 1); assert.equal(s.autoShareState.status, 'ready'); assert.equal(s.authority.grants.size, 1);
    await s.rpc('sharing.auto', { enabled: true }); await s.autoShareTask; assert.equal(f.sent.length, 1, 're-enabling an already successful run does not duplicate the initial message');
  } finally { await s.close(); }
});

const until = async condition => { for (let i = 0; i < 200 && !condition(); i++) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(condition(), 'condition was not reached'); };
test('first tunnel startup failure automatically retries once, then creates and confirms exactly one link', async () => {
  const f = await fixture({ failStarts: 1 }); const s = f.service;
  try { await f.connect(); await s.autoShareTask; assert.equal(s.tunnel.starts, 2); assert.equal(f.sent.length, 1); assert.equal(s.authority.grants.size, 1); assert.equal(s.autoShareState.status, 'ready'); assert.equal(s.autoShareState.attempt, 2); }
  finally { await s.close(); }
});
test('first message failure automatically retries using the same tunnel and grant without resetting changed permissions', async () => {
  const f = await fixture({ sendFailures: 1, retryMs: 40 }); const s = f.service;
  try {
    await f.connect(); const task = s.autoShareTask; await until(() => s.autoShareState.status === 'retrying'); const id = s.autoGrantId;
    assert.equal(s.startAutomaticSharing(), task); await s.rpc('sharing.permissions', { id, permissions: ['view','search'] }); await s.rpc('player.volume', { value: 20 }); await task;
    assert.equal(f.sendAttempts, 2); assert.equal(f.sent.length, 1); assert.equal(s.tunnel.starts, 1); assert.equal(s.authority.grants.size, 1); assert.equal(s.autoGrantId, id); assert.deepEqual(s.authority.grants.get(id).permissions, ['view','search']); assert.equal(s.autoShareState.status, 'ready'); assert.deepEqual(f.calls, ['player.volume']);
  } finally { await s.close(); }
});
test('a persistent failure stops after one retry without state notifications starting another cycle', async () => {
  const f = await fixture({ fail: true }); const s = f.service;
  try {
    await f.connect(); await s.autoShareTask; s.changed(); await new Promise(resolve => setTimeout(resolve, 35));
    assert.equal(s.tunnel.starts, 2); assert.equal(s.autoShareState.status, 'error'); assert.equal(s.autoShareState.attempt, 2); assert.equal(s.autoShareTask, null); assert.match(s.autoShareState.error, /重试一次/); assert.equal(s.phase, 'running');
  } finally { await s.close(); }
});
test('stopping, disabling or revoking during the retry delay cancels the pending retry', async () => {
  for (const method of ['bot.stop','sharing.disable','sharing.auto','sharing.revoke']) {
    const f = await fixture({ sendFailures: 1, retryMs: 100 }); const s = f.service;
    try {
      await f.connect(); const task = s.autoShareTask; await until(() => s.autoShareState.status === 'retrying');
      await s.rpc(method, { enabled: false, id: s.autoGrantId }); await task; await new Promise(resolve => setTimeout(resolve, 110));
      assert.equal(f.sendAttempts, 1, method); assert.equal(f.sent.length, 0, method); assert.equal(s.autoShareTask, null); assert.equal(s.tunnel.starts, 1, method);
    } finally { await s.close(); }
  }
});
