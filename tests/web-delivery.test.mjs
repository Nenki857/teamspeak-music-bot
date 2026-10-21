import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createStaticResponder, createPacedSender, sendJson, stateFrame } from '../src/worker/web-delivery.mjs';
import { writeServerIcons } from '../scripts/server-icons.mjs';

async function fixture(t) {
  mkdirSync('work', { recursive: true });const dir=mkdtempSync(resolve('work/web-cache-test-'));
  const text='export const value = "cacheable static content";\n'.repeat(100);
  mkdirSync(resolve(dir,'assets'));writeFileSync(resolve(dir,'assets/app-12345678.js'),text);writeFileSync(resolve(dir,'index.html'),'<html>entry point</html>');
  const sender=createPacedSender({bytesPerSecond:1024*1024});
  const headers={'Cache-Control':'no-store'};
  const responder=createStaticResponder({headers,mime:{'.html':'text/html','.js':'application/javascript'},sender});
  const server=createServer((req,res)=>{
    if(req.url==='/api')return sendJson(res,200,{private:true},headers);
    responder(req,res,resolve(dir,req.url==='/app.js'?'assets/app-12345678.js':'index.html')).catch(()=>res.destroy());
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{sender.close();server.closeAllConnections();server.close();});
  return {url:`http://127.0.0.1:${server.address().port}`,text,dir};
}
test('static assets compress and revalidate while HTML and API responses remain uncached',async t=>{
  const f=await fixture(t);
  const js=await fetch(f.url+'/app.js',{headers:{'Accept-Encoding':'br'}});
  assert.equal(js.headers.get('content-encoding'),'br');assert.equal(await js.text(),f.text);
  assert.match(js.headers.get('cache-control'),/immutable/);assert.ok(Number(js.headers.get('content-length'))<f.text.length/2);
  const again=await fetch(f.url+'/app.js',{headers:{'Accept-Encoding':'br','If-None-Match':js.headers.get('etag')}});
  assert.equal(again.status,304);assert.equal(await again.text(),'');
  for(const path of ['/','/api'])assert.equal((await fetch(f.url+path)).headers.get('cache-control'),'no-store');
  const head=await fetch(f.url+'/app.js',{method:'HEAD',headers:{'Accept-Encoding':'identity'}});
  assert.equal(head.status,200);assert.equal(await head.text(),'');assert.equal(Number(head.headers.get('content-length')),f.text.length);
});
test('compression honors q=0 and returns the same asset from memory after a repeated request',async t=>{
  const f=await fixture(t);const response=await fetch(f.url+'/app.js',{headers:{'Accept-Encoding':'br;q=0,gzip;q=0'}});
  assert.equal(response.headers.get('content-encoding'),null);assert.equal(await response.text(),f.text);
  writeFileSync(resolve(f.dir,'assets/app-12345678.js'),'changed on disk');
  assert.equal(await (await fetch(f.url+'/app.js')).text(),f.text);
});
test('guest deltas omit unchanged queues, detect mutations and clear removed fields',()=>{
  const state={runId:'a',publications:[{id:'list'}],player:{queue:[{id:'song'}],elapsed:1}};
  const first=stateFrame(state,null,true);assert.equal(JSON.parse(first.payload).partial,undefined);
  assert.equal(stateFrame(state,first.previous,true).payload,null);
  state.player.elapsed=2;const next=stateFrame(state,first.previous,true);
  assert.deepEqual(JSON.parse(next.payload),{type:'state',partial:true,state:{player:{elapsed:2}}});
  state.player.queue.push({id:'second'});delete state.publications;const changed=JSON.parse(stateFrame(state,next.previous,true).payload);
  assert.equal(changed.state.player.queue.length,2);assert.equal(changed.state.publications,null);
  assert.equal(JSON.parse(stateFrame({...state,runId:'b'},next.previous,true).payload).partial,undefined);
});
test('server packages get small web icons without changing desktop assets or source artwork',async()=>{
  const hash=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
  const protectedFiles=['resources/logo-source.png','resources/app.ico','public/logo.png','public/favicon.ico'];
  const before=protectedFiles.map(hash);const output=mkdtempSync(resolve('work/server-icon-test-'));
  const result=await writeServerIcons(output);assert.ok(result.logoBytes<64*1024);assert.ok(result.faviconBytes<8*1024);
  const png=readFileSync(resolve(output,'logo.png'));assert.equal(png.readUInt32BE(16),192);assert.equal(png.readUInt32BE(20),192);
  const ico=readFileSync(resolve(output,'favicon.ico'));assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),2);assert.equal(ico[6],16);assert.equal(ico[22],32);
  assert.deepEqual(protectedFiles.map(hash),before);
});
