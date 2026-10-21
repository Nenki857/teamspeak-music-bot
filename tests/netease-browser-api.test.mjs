import test from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { browserCookieJar, createNeteaseBrowserApi } from '../src/worker/netease-browser-api.mjs';
import { checkBrowserLogin } from '../scripts/check-netease-browser.mjs';

test('web cookies retain CSRF, respect domain/path/expiry, and reject header injection', () => {
  let now = 10000;
  const jar = browserCookieJar('MUSIC_U=owner; __csrf=csrf%31; _ntes_nnid=id,123', () => now);
  jar.receive(['NMTID=real; Path=/; Domain=.music.163.com; Max-Age=10', 'other=discard; Domain=example.com', 'restricted=value; Path=/weapi/login', 'bad=value\r\nX-Test: 1']);
  assert.equal(jar.csrf('/weapi/search'), 'csrf1');
  assert.match(jar.header('/weapi/search'), /NMTID=real/);
  assert.match(jar.header('/weapi/search'), /_ntes_nnid=id,123/);
  assert.doesNotMatch(jar.header('/weapi/search'), /other|restricted|bad/);
  assert.match(jar.header('/weapi/login/check'), /restricted=value/);
  now += 11000; assert.doesNotMatch(jar.header('/'), /NMTID/);
  jar.receive(['MUSIC_U=gone; Path=/; Max-Age=0']); assert.doesNotMatch(jar.header('/'), /MUSIC_U/);
  assert.throws(() => browserCookieJar('MUSIC_U=a\r\nX-Test: 1'));
});

function fixture({ reject = false, unsafeRoute = false, confirmed = false } = {}) {
  const calls = [], payloads = [];
  const requireLibrary = path => {
    if (path === './util/crypto.js') return { weapi: data => { payloads.push(data); return { params: JSON.stringify(data), encSecKey: 'test' }; } };
    if (path.endsWith('/cloudsearch.js')) return (args, request) => request(unsafeRoute ? '/api/../evil' : '/api/cloudsearch/pc', { s: args.keywords, type: args.type || 1 });
    if (path.endsWith('/login_qr_key.js')) return async (_args, request) => { const response = await request('/api/login/qrcode/unikey', { type: 3 }); return { ...response, body: { code: 200, data: response.body } }; };
    if (path.endsWith('/login_qr_create.js')) return async () => ({ status: 200, body: { code: 200, data: { qrimg: 'data:image/png;base64,PRIVATE_IMAGE' } } });
    return () => { throw Error('Unexpected builder call'); };
  };
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    const path = new URL(url).pathname;
    if (path === '/') return new Response('<html/>', { headers: { 'Set-Cookie': '__csrf=server_csrf; Path=/' } });
    const body = path.endsWith('unikey') ? { code: 200, unikey: 'PRIVATE_QR_KEY' } : path.endsWith('client/login') ? { code: confirmed ? 803 : 801 } : reject ? { code: -462, data: { verifyToken: 'PRIVATE_CHALLENGE' } } : { code: 200, result: { songs: [{ id: 1 }] } };
    return Response.json(body, { headers: confirmed ? { 'Set-Cookie': 'MUSIC_U=PRIVATE_SESSION; Path=/; HttpOnly' } : {} });
  };
  return { api: createNeteaseBrowserApi({ requireLibrary, fetchImpl }), calls, payloads };
}

test('normal web search uses the web route and returned CSRF without synthetic app/IP fields', async () => {
  const { api, calls, payloads } = fixture();
  const result = await api.cloudsearch({ keywords: 'music', cookie: 'MUSIC_U=PRIVATE_OWNER' });
  assert.equal(result.status, 200); assert.equal(calls.length, 2);
  assert.equal(calls[1][0], 'https://music.163.com/weapi/cloudsearch/get/web');
  assert.equal(calls[1][1].redirect, 'error');
  assert.match(calls[1][1].headers.Cookie, /MUSIC_U=PRIVATE_OWNER/);
  assert.deepEqual(payloads[0], { s: 'music', type: 1, csrf_token: 'server_csrf' });
  for (const name of ['X-Real-IP', 'X-Forwarded-For', 'X-antiCheatToken', 'deviceId', 'os', 'appver']) assert.equal(Object.hasOwn(calls[1][1].headers, name), false);
});

test('public requests do not inherit owner sessions and returned cookies stay in their own jar', async () => {
  const { api, calls } = fixture();
  await api.cloudsearch({ keywords: 'owner', cookie: 'MUSIC_U=PRIVATE_OWNER' });
  await api.cloudsearch({ keywords: 'public' });
  assert.equal(calls.length, 4);
  assert.doesNotMatch(calls[3][1].headers.Cookie || '', /PRIVATE_OWNER/);
  await api.cloudsearch({ keywords: 'public again' }); assert.equal(calls.length, 5);
});

test('QR uses web type 1 and persists a confirmed complete session without cookie attributes', async () => {
  const { api, payloads } = fixture({ confirmed: true });
  const key = await api.login_qr_key({}); assert.equal(key.body.data.unikey, 'PRIVATE_QR_KEY');
  const result = await api.login_qr_check({ key: key.body.data.unikey });
  assert.equal(payloads[0].type, 1); assert.equal(payloads[1].type, 1);
  assert.equal(result.body.code, 803); assert.match(result.body.cookie, /MUSIC_U=PRIVATE_SESSION/);
  assert.match(result.body.cookie, /__csrf=server_csrf/); assert.doesNotMatch(result.body.cookie, /HttpOnly|Path=/);
});

test('restricted web requests propagate the code and do not retry or change identities', async () => {
  const { api, calls } = fixture({ reject: true });
  await assert.rejects(api.cloudsearch({ keywords: 'music' }), error => error.body?.code === -462);
  assert.equal(calls.length, 2);
});

test('payload builders cannot turn fixed-origin requests into arbitrary paths', async () => {
  const { api, calls } = fixture({ unsafeRoute: true });
  await assert.rejects(api.cloudsearch({ keywords: 'music' }), /Invalid music web route/);
  assert.equal(calls.length, 1);
});

test('login preflight reports only QR readiness, never full search or playback recovery', async () => {
  const { api, calls } = fixture();
  const result = await checkBrowserLogin(api);
  assert.equal(result.candidatePassed, true); assert.equal(result.stage, 'awaiting-user-login');
  assert.equal(result.searchVerified, false); assert.equal(result.playbackVerified, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|csrf|MUSIC_U/);
  assert.equal(calls.length, 3);
  let attempts = 0;
  const failure = await checkBrowserLogin({ login_qr_key: async () => { attempts++; throw { status: 400, body: { code: -462, private: 'PRIVATE_KEY' } }; } });
  assert.equal(attempts, 1); assert.equal(failure.candidatePassed, false);
  assert.equal(failure.bodyCode, -462); assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_/);
});

test('artist metadata uses the existing web artist route without app device or IP headers', async () => {
  const calls=[];
  const requireLibrary = name => name==='./util/crypto.js' ? {weapi:data=>({params:JSON.stringify(data)})} : name.endsWith('/artist_detail.js') ? (args,request)=>request('/api/artist/head/info/get',{id:args.id}) : ()=>{throw Error('Unexpected builder');};
  const api=createNeteaseBrowserApi({requireLibrary,fetchImpl:async(url,options)=>{calls.push([url,options]);return new Response(JSON.stringify({code:200,artist:{id:99,name:'Fixture'}}),{headers:{'Content-Type':'application/json'}});}});
  const result=await api.artist_detail({id:'99',cookie:'MUSIC_U=fixture'});
  assert.equal(result.body.artist.name,'Fixture');assert.equal(calls[1][0],'https://music.163.com/weapi/v1/artist/99');
  assert.equal(calls[1][1].headers['X-Forwarded-For'],undefined);assert.equal(calls[1][1].headers['X-Real-IP'],undefined);
  await assert.rejects(api.artist_detail({id:'../other'}),/Invalid artist ID/);
});

test('every actual web HTTP exchange, including homepage bootstrap, passes the shared request gate', async()=>{
  const gated=[];const fetched=[];
  const requireLibrary=name=>name==='./util/crypto.js'?{weapi:()=>({params:'fixture'})}:name.endsWith('/cloudsearch.js')?(args,request)=>request('/api/cloudsearch/pc',{}):()=>{throw Error('Unexpected builder');};
  const api=createNeteaseBrowserApi({requireLibrary,requestGate:{run:async(method,perform,options)=>{gated.push({method,deadline:options.deadline});return perform();}},fetchImpl:async(url)=>{fetched.push(url);return Response.json({code:200,result:{songs:[]}});}});
  await api.cloudsearch({keywords:'fixture',cookie:'MUSIC_U=fixture'});assert.equal(gated.length,2);assert.equal(fetched.length,2);assert.ok(gated.every(e=>e.method==='cloudsearch'&&e.deadline>Date.now()));
});

function artistCacheFixture() {
  let clock=1000, restricted=false; const calls=[];
  const requireLibrary=name=>name==='./util/crypto.js'?{weapi:data=>({params:JSON.stringify(data)})}:name.endsWith('/artist_detail.js')?(args,request)=>request('/api/artist/head/info/get',{id:args.id}):name.endsWith('/artist_songs.js')?(args,request)=>request('/api/v1/artist/songs',{id:args.id,order:args.order,offset:args.offset}):()=>{throw Error('Unexpected builder');};
  const api=createNeteaseBrowserApi({now:()=>clock,requireLibrary,fetchImpl:async(url,options)=>{
    calls.push({path:new URL(url).pathname,payload:options.body?(new URLSearchParams(options.body).has('params')?JSON.parse(new URLSearchParams(options.body).get('params')):Object.fromEntries(new URLSearchParams(options.body))):null,cookie:options.headers.Cookie});
    return Response.json(restricted?{code:-462}:{code:200,artist:{id:99,name:'Fixture'},songs:[{id:1}]});
  }});
  return{api,calls,advance:ms=>clock+=ms,restrict:value=>restricted=value};
}
test('artist sorting, pagination, repeat clicks and concurrent viewers reuse metadata within one session',async()=>{
  const{api,calls}=artistCacheFixture();const cookie='MUSIC_U=fixture';
  const first=await api.artist_detail({id:'99',cookie});first.body.artist.name='MUTATED';
  await api.artist_songs({id:'99',order:'hot',offset:0,cookie});
  const values=await Promise.all([api.artist_detail({id:99,cookie}),api.artist_detail({id:'99',cookie}),api.artist_songs({id:'99',order:'time',offset:0,cookie}),api.artist_songs({id:'99',order:'time',offset:30,cookie})]);
  await api.artist_songs({id:'99',order:'time',offset:30,cookie});
  assert.equal(values[0].body.artist.name,'Fixture');assert.equal(values[1].body.artist.name,'Fixture');
  assert.deepEqual(calls.map(c=>c.path),['/','/weapi/v1/artist/99','/api/v1/artist/songs','/api/v1/artist/songs','/api/v1/artist/songs']);
  assert.deepEqual(calls.filter(c=>c.payload?.order).map(c=>[c.payload.order,c.payload.offset]),[['hot','0'],['time','0'],['time','30']]);
});
test('artist caches expire, stay isolated between login sessions and do not remember a failed request',async()=>{
  const f=artistCacheFixture();const args={id:'99',cookie:'MUSIC_U=first'};
  await f.api.artist_detail(args);await f.api.artist_detail({...args,cookie:'MUSIC_U=second'});
  assert.equal(f.calls.filter(c=>c.path==='/weapi/v1/artist/99').length,2);
  f.advance(600001);f.restrict(true);await assert.rejects(f.api.artist_detail(args),e=>e.body.code===-462);
  f.restrict(false);await f.api.artist_detail(args);assert.equal(f.calls.filter(c=>c.path==='/weapi/v1/artist/99').length,4);
  await f.api.artist_songs({...args,order:'hot',offset:0});f.advance(30001);await f.api.artist_songs({...args,order:'hot',offset:0});assert.equal(f.calls.filter(c=>c.path==='/api/v1/artist/songs').length,2);
});

test('real artist song builder keeps API route and artist IDs in plain form parameters, with isolated cache keys',async()=>{
  const requireLibrary=createRequire(new URL('../vendor/teamspeak-music-bot-1.13.2/node_modules/NeteaseCloudMusicApi/main.js',import.meta.url));
  const calls=[];
  const api=createNeteaseBrowserApi({requireLibrary,fetchImpl:async(url,options)=>{
    if(new URL(url).pathname==='/')return new Response('<html/>');
    assert.equal(url,'https://music.163.com/api/v1/artist/songs');const data=Object.fromEntries(new URLSearchParams(options.body));calls.push(data);
    assert.equal(data.params,undefined);assert.equal(data.encSecKey,undefined);assert.equal(data.private_cloud,'true');assert.equal(data.work_type,'1');
    return Response.json({code:200,songs:[{id:data.id+'-'+data.order+'-'+data.offset,ar:[{id:data.id}]}]});
  }});
  const first=await api.artist_songs({id:'21',order:'hot',offset:0,limit:30,cookie:'MUSIC_U=fixture'});
  const second=await api.artist_songs({id:'33',order:'hot',offset:0,limit:30,cookie:'MUSIC_U=fixture'});
  const latest=await api.artist_songs({id:'21',order:'time',offset:30,limit:30,cookie:'MUSIC_U=fixture'});
  const cached=await api.artist_songs({id:'21',order:'hot',offset:0,limit:30,cookie:'MUSIC_U=fixture'});
  assert.equal(first.body.songs[0].id,'21-hot-0');assert.equal(second.body.songs[0].id,'33-hot-0');assert.equal(latest.body.songs[0].id,'21-time-30');assert.deepEqual(cached,first);assert.equal(calls.length,3);
});
