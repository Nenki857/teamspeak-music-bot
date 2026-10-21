import test from 'node:test';
import assert from 'node:assert/strict';
import { createNeteaseApiSession } from '../src/worker/netease-api-session.mjs';

test('normal guest handshake is coalesced and cached while existing owner cookies stay untouched',async()=>{
  let registrations=0;const calls=[];
  const api={register_anonimous:async()=>{registrations++;await new Promise(resolve=>setTimeout(resolve,5));return{status:200,body:{code:200,cookie:'MUSIC_A=private-guest; deviceId=guest-device'}};},cloudsearch:async args=>{calls.push(args);return{status:200,body:{code:200}};},login_qr_create:async args=>{calls.push(args);return{};}};
  const client=createNeteaseApiSession(api,{enabled:true});
  await Promise.all([client.call('cloudsearch',{type:1}),client.call('cloudsearch',{type:10})]);
  assert.equal(registrations,1);assert.ok(calls.every(x=>x.cookie==='MUSIC_A=private-guest; deviceId=guest-device'));
  const owner={type:1,cookie:'MUSIC_U=private-owner'};await client.call('cloudsearch',owner);assert.equal(calls.at(-1),owner);
  await client.call('login_qr_create',{key:'private-key'});assert.equal(calls.at(-1).cookie,undefined);
  await client.call('cloudsearch',{});assert.equal(registrations,1);
});
test('upstream restriction does not trigger identity rotation or repeated guest registration',async()=>{
  let registrations=0,at=0;
  const error={status:400,body:{code:-462}};
  const client=createNeteaseApiSession({register_anonimous:async()=>{registrations++;throw error;}},{enabled:true,now:()=>at});
  await assert.rejects(client.call('cloudsearch',{}));await assert.rejects(client.call('cloudsearch',{}));assert.equal(registrations,1);
  at=60001;await assert.rejects(client.call('cloudsearch',{}));assert.equal(registrations,2);
});
test('default local behavior makes no guest session request and forwards original parameters',async()=>{
  let called;const client=createNeteaseApiSession({cloudsearch:args=>{called=args;return{ok:true};},register_anonimous:()=>{throw Error('must not run');}});
  const args={cookie:'owner',type:1};assert.deepEqual(await client.call('cloudsearch',args),{ok:true});assert.equal(called,args);
});
test('malformed successful handshake is rejected instead of issuing a request without a valid guest cookie',async()=>{
  const client=createNeteaseApiSession({register_anonimous:async()=>({status:200,body:{code:200,cookie:'other=value'}}),cloudsearch:()=>{throw Error('must not run');}},{enabled:true});
  await assert.rejects(client.call('cloudsearch',{}),/游客会话初始化失败/);
});
