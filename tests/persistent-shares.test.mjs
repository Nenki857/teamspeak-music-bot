import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createVault, ShareAuthority, ALL_PERMISSIONS } from '../src/shared/security.mjs';
import { PersistentShareAuthority } from '../src/server/persistent-shares.mjs';
process.env.TSMD_DATA_DIR = resolve('work/fixed-share-tests-' + randomUUID());
process.env.TSMD_PUBLIC_URL = 'https://203.0.113.10';
const [{ Service }, { createShareServer }] = await Promise.all([import('../src/worker/service.mjs'), import('../src/worker/share-server.mjs')]);
function fixture() { let value; let fail = false; return { store: { get: () => value, set: (_key, next) => { if (fail) throw Error('Synthetic disk failure'); value = next; } }, vault: createVault(randomBytes(32)), get value() { return value; }, fail: next => { fail = next; } }; }
test('server invitations and permission edits survive restarts, while sessions expire and stopped access is denied', () => {
  const f = fixture(); const first = new PersistentShareAuthority(f.store, f.vault); const oldRun = first.beginRun();
  const automatic = first.createAutomatic(ALL_PERMISSIONS); const manual = first.create('朋友', ['search']);
  first.update(automatic.id, ['view','search']); const session = first.exchange(automatic.raw);
  assert.ok(!f.value.includes(automatic.raw)); assert.ok(!f.value.includes(manual.raw));
  first.endRun(); assert.throws(() => first.exchange(automatic.raw), /失效/);
  const second = new PersistentShareAuthority(f.store, f.vault); assert.notEqual(second.beginRun(), oldRun);
  const reused = second.createAutomatic(ALL_PERMISSIONS); assert.equal(reused.raw, automatic.raw); assert.equal(second.grants.size, 2);
  assert.deepEqual(reused.permissions, ['view','search']); assert.throws(() => second.authenticate(session.session), /重新|失效/);
  assert.ok(second.exchange(automatic.raw).session); assert.ok(second.exchange(manual.raw).session);
  second.revoke(automatic.id); const third = new PersistentShareAuthority(f.store, f.vault); third.beginRun();
  assert.throws(() => third.exchange(automatic.raw), /失效/); assert.notEqual(third.createAutomatic(ALL_PERMISSIONS).raw, automatic.raw);
  assert.ok(third.exchange(manual.raw).session);
  const desktop = new ShareAuthority(); desktop.beginRun(); const ephemeral = desktop.create('local'); desktop.endRun(); desktop.beginRun(); assert.throws(() => desktop.exchange(ephemeral.raw), /失效/);
});
test('failed invitation persistence leaves existing permissions and sessions usable without creating untracked links', () => {
  const f = fixture(); const auth = new PersistentShareAuthority(f.store, f.vault); auth.beginRun();
  const automatic = auth.createAutomatic(ALL_PERMISSIONS); const session = auth.exchange(automatic.raw); const before = f.value; f.fail(true);
  assert.throws(() => auth.update(automatic.id, ['view']), /disk/); assert.throws(() => auth.revoke(automatic.id), /disk/); assert.throws(() => auth.create('new'), /disk/);
  assert.equal(f.value, before); assert.equal(auth.grants.size, 1); assert.deepEqual(auth.authenticate(session.session).grant.permissions, ALL_PERMISSIONS);
  const empty = fixture(); const a = new PersistentShareAuthority(empty.store, empty.vault); a.beginRun(); empty.fail(true);
  assert.throws(() => a.createAutomatic(['view']), /disk/); assert.equal(a.grants.size, 0); assert.equal(a.automaticId, '');
  empty.fail(false); a.createAutomatic(['view']); assert.equal(a.grants.size, 1);
  assert.throws(() => new PersistentShareAuthority(f.store, createVault(randomBytes(32))));
});
test('server automatic sharing reuses the complete announced URL after bot stop and backend restart', async () => {
  const vault = createVault(randomBytes(32)); const sent = [];
  function make(persistent = true) {
    return new Service(vault, () => {}, {
      ...(persistent ? { createAuthority: (store, key) => new PersistentShareAuthority(store, key) } : {}),
      createTunnel: changed => ({ state: { status:'off' }, async start() { this.state={status:'online',url:'https://203.0.113.10',kind:'fixed'}; changed(); }, stop() { this.state={status:'off'}; changed(); } }),
      createCore: () => ({ init(){}, close(){}, stop(){}, start(){}, status:()=>({queue:[]}), health:()=>({}), announcementTarget:async()=>({channelId:'1',connectionId:randomUUID()}), sendShareAnnouncement:async event=>{sent.push(event.url);return true;} })
    });
  }
  let service = make();
  try {
    await service.init(); service.sharePort=18081;
    const preset=await service.rpc('presets.save',{name:'fixed server',serverAddress:'127.0.0.1'});
    const connect=async()=>{await service.rpc('bot.start',{id:preset.id});await service.autoShareTask;};
    await connect(); const url=service.snapshot().grants[0].url,token=new URL(url).hash.slice(8);
    const old=service.authority.exchange(token); await service.rpc('bot.stop'); assert.throws(()=>service.authority.exchange(token),/失效/);
    await connect(); assert.equal(service.snapshot().grants[0].url,url); assert.throws(()=>service.authority.authenticate(old.session),/失效|重新/);
    await service.close(); service=make();await service.init();service.sharePort=18081;await connect();
    assert.equal(service.snapshot().grants[0].url,url); assert.ok(service.authority.exchange(token).session); assert.ok(sent.filter(value=>value===url).length>=3);
    const id=service.snapshot().grants[0].id;await service.rpc('sharing.revoke',{id});await service.close();service=make();await service.init();service.sharePort=18081;await connect();
    assert.notEqual(service.snapshot().grants[0].url,url);assert.throws(()=>service.authority.exchange(token),/失效/);
    await service.close();service=make(false);await service.init();service.sharePort=18081;await connect();const local=service.snapshot().grants[0].url;await service.rpc('bot.stop');await connect();assert.notEqual(service.snapshot().grants[0].url,local);
  } finally { await service.close(); }
});
test('friend-only HTTP endpoint has no owner API, preserves bookmarked invitations and blocks access while sharing is off', async t => {
  const f = fixture(); const authority = new PersistentShareAuthority(f.store, f.vault); authority.beginRun(); const grant=authority.create('fixed',['view']);
  let enabled=true;const service={authority,snapshot:()=>({ready:true}),rpc:async()=>({})};
  const server=await createShareServer(service,{persistentInvites:true,publicEnabled:()=>enabled});t.after(()=>server.close());const origin=`http://127.0.0.1:${server.port}`;
  assert.match(await(await fetch(origin)).text(),/data-persistent-invitations/);
  const post=async(path,input)=>fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(input)});
  for(const path of ['/api/admin/session','/admin'])assert.notEqual((await fetch(origin+path)).status,200);
  for(const path of ['/api/admin/login','/api/admin/password','/api/admin/rpc'])assert.equal((await post(path,{password:'any'})).status,404);
  assert.equal((await post('/api/share/exchange',{token:grant.raw})).status,200);enabled=false;assert.equal((await post('/api/share/exchange',{token:grant.raw})).status,400);
  const normal=await createShareServer(service);t.after(()=>normal.close());assert.doesNotMatch(await(await fetch(`http://127.0.0.1:${normal.port}`)).text(),/data-persistent-invitations/);
});
