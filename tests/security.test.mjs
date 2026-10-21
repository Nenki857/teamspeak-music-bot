import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createVault, ShareAuthority, CommandGate } from '../src/shared/security.mjs';
test('credentials are authenticated ciphertext and wrong keys fail', () => {
  const vault = createVault(randomBytes(32)); const sealed = vault.encrypt('private-server-password');
  assert.equal(vault.decrypt(sealed), 'private-server-password'); assert.ok(!sealed.includes('private-server-password'));
  assert.throws(() => createVault(randomBytes(32)).decrypt(sealed)); assert.throws(() => vault.decrypt('plaintext'));
});
test('each link has independent permissions, live edits and revocation', () => {
  const auth = new ShareAuthority(); auth.beginRun();
  const first = auth.create('A', ['skip']); const second = auth.create('B', ['view']);
  const a = auth.exchange(first.raw); const b = auth.exchange(second.raw);
  assert.equal(auth.authenticate(a.session, 'skip', a.csrf).grant.name, 'A');
  assert.throws(() => auth.authenticate(b.session, 'skip', b.csrf));
  assert.throws(() => auth.authenticate(a.session, 'skip', 'incorrect'));
  auth.update(first.id, ['view']); assert.throws(() => auth.authenticate(a.session, 'skip', a.csrf));
  auth.revoke(first.id); assert.throws(() => auth.exchange(first.raw)); assert.throws(() => auth.authenticate(a.session, 'view'));
  assert.equal(auth.authenticate(b.session, 'view').grant.name, 'B');
});
test('closing and restarting a run invalidates old links and existing sessions', () => {
  const auth = new ShareAuthority(); const run = auth.beginRun(); const grant = auth.create('friend'); const session = auth.exchange(grant.raw);
  auth.endRun(); assert.throws(() => auth.exchange(grant.raw)); assert.throws(() => auth.authenticate(session.session, 'view'));
  assert.notEqual(auth.beginRun(), run); assert.throws(() => auth.exchange(grant.raw)); assert.throws(() => auth.authenticate(session.session, 'view'));
});
test('duplicate requests execute once; two skips against one revision skip once', async () => {
  const gate = new CommandGate(); let revision = 10; let skips = 0;
  const skip = expected => { if (expected !== revision) throw new Error('stale'); revision++; skips++; return revision; };
  const first = gate.run('a', 'request-001', () => skip(10));
  const retry = gate.run('a', 'request-001', () => skip(10));
  const conflict = gate.run('b', 'request-002', () => skip(10));
  assert.equal(await first, 11); assert.equal(await retry, 11); await assert.rejects(conflict, /stale/); assert.equal(skips, 1);
});
