import test from 'node:test';
import assert from 'node:assert/strict';
import {ShareAuthority} from '../src/shared/security.mjs';
import {createShareServer} from '../src/worker/share-server.mjs';
test('host metrics require a valid view session, CSRF and origin, and do not consume music RPC allowance',async t=>{
 const authority=new ShareAuthority();authority.beginRun();const grant=authority.create('Viewer',['view']);let reads=0,rpcs=0;const service={authority,snapshot:()=>({ready:true}),rpc:async()=>{rpcs++;return true;}};
 const server=await createShareServer(service,{resources:async()=>{reads++;return{scope:'server-host',cpu:{percent:12},memory:{bytes:123}};}});t.after(()=>server.close());const origin='http://127.0.0.1:'+server.port;
 const post=async(path,input={},headers={})=>{const response=await fetch(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(input)});return{response,data:await response.json()};};
 assert.equal((await post('/api/share/resources')).data.ok,false);const exchange=await post('/api/share/exchange',{token:grant.raw});const cookie=exchange.response.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie,'X-TSMD-CSRF':exchange.data.csrf};
 assert.equal((await post('/api/share/resources',{}, {Cookie:cookie})).data.ok,false);assert.equal((await post('/api/share/resources',{}, {...headers,Origin:'https://wrong.example'})).data.ok,false);assert.equal(reads,0);
 const result=await post('/api/share/resources',{},headers);assert.equal(result.data.ok,true);assert.equal(result.data.result.cpu.percent,12);assert.equal(rpcs,0);assert.equal(reads,1);
 authority.revoke(grant.id);assert.equal((await post('/api/share/resources',{},headers)).data.ok,false);assert.equal(reads,1);
});
