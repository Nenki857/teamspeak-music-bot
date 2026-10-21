import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { preparePublicTunnel } from '../scripts/prepare-public-tunnel.mjs';
const payload=Buffer.from('verified test executable');
const digest=createHash('sha256').update(payload).digest('hex');
function fixture(){
  mkdirSync('work',{recursive:true});const root=mkdtempSync(resolve('work/tunnel-setup-'));mkdirSync(join(root,'resources'));
  writeFileSync(join(root,'resources/cloudflared-version.json'),JSON.stringify({url:'https://github.com/cloudflare/cloudflared/releases/download/2026.10.0/cloudflared-windows-amd64.exe',digest:'sha256:'+digest}));
  const messages=[];const log={log:m=>messages.push(m),warn:m=>messages.push(m)};
  return{root,log,messages,target:join(root,'resources/cloudflared.exe')};
}
test('a verified public-sharing binary is reused without any download',async()=>{
  const f=fixture();writeFileSync(f.target,payload);
  assert.equal(await preparePublicTunnel({...f,download:()=>{throw Error('must not download');}}),true);
  assert.match(f.messages.join('\n'),/already verified/);
});
test('public-sharing download retries once and only publishes verified bytes',async()=>{
  const f=fixture();let calls=0;
  const download=async({destination})=>{calls++;writeFileSync(destination,calls===1?'partial':payload);if(calls===1)throw Error('connection reset');};
  assert.equal(await preparePublicTunnel({...f,download}),true);assert.equal(calls,2);assert.deepEqual(readFileSync(f.target),payload);
  assert.deepEqual(readdirSync(join(f.root,'resources')).filter(n=>n.endsWith('.part')),[]);
  assert.match(f.messages.join('\n'),/attempt 2\/2/);
});
test('unavailable optional download allows local playback with explicit sharing warning',async()=>{
  const f=fixture();let calls=0;
  const download=async({destination})=>{calls++;writeFileSync(destination,'incomplete');throw Error('fetch failed',{cause:{code:'ETIMEDOUT',message:'connect timeout'}});};
  assert.equal(await preparePublicTunnel({...f,download}),false);assert.equal(calls,2);assert.equal(existsSync(f.target),false);
  assert.deepEqual(readdirSync(join(f.root,'resources')).filter(n=>n.endsWith('.part')),[]);
  assert.match(f.messages.join('\n'),/Local playback can run, but the public friend link is unavailable/);
  assert.match(f.messages.join('\n'),/ETIMEDOUT/);
});
test('release packaging requires a complete sharing component',async()=>{
  const f=fixture();let calls=0;
  await assert.rejects(preparePublicTunnel({...f,required:true,download:async()=>{calls++;throw Error('network unavailable');}}),/Cannot create a complete release/);
  assert.equal(calls,2);assert.equal(existsSync(f.target),false);
});
test('checksum failures cannot publish an untrusted component',async()=>{
  const f=fixture();
  await assert.rejects(preparePublicTunnel({...f,required:true,download:async({destination})=>writeFileSync(destination,'wrong bytes')}),/Cannot create a complete release/);
  assert.equal(existsSync(f.target),false);assert.deepEqual(readdirSync(join(f.root,'resources')).filter(n=>n.endsWith('.part')),[]);
  assert.match(f.messages.join('\n'),/SHA-256 verification failed/);
});
test('an existing mismatched binary is not overwritten or accepted',async()=>{
  const f=fixture();writeFileSync(f.target,'old or damaged');
  await assert.rejects(preparePublicTunnel({...f,download:()=>{throw Error('must not download');}}),/Existing public-sharing component failed SHA-256/);
  assert.equal(readFileSync(f.target,'utf8'),'old or damaged');
});
test('unapproved metadata cannot redirect the component download',async()=>{
  const f=fixture();writeFileSync(join(f.root,'resources/cloudflared-version.json'),JSON.stringify({url:'https://example.com/cloudflared.exe',digest:'sha256:'+digest}));
  await assert.rejects(preparePublicTunnel({...f,download:()=>{throw Error('must not download');}}),/Invalid public-sharing component metadata/);
});
