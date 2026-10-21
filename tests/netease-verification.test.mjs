import test from 'node:test';
import assert from 'node:assert/strict';
import { officialVerificationUrl, completeVerificationUrl, requestVerification, verificationPage } from '../scripts/netease-verification.mjs';

test('verification pages must use official HTTPS origins without alternate ports or embedded credentials', () => {
  assert.equal(officialVerificationUrl('https://music.163.com/verify?token=private'), 'https://music.163.com/verify?token=private');
  for (const url of ['http://music.163.com/verify', 'https://music.163.com.evil.example/verify', 'https://evil.example/verify', 'https://user:password@music.163.com/verify', 'https://music.163.com:444/verify', 'file:///private', 'javascript:alert(1)']) assert.equal(officialVerificationUrl(url), null);
});

test('only the returned verification page is retained and there is one request without account changes or retries', async () => {
  let calls = 0;
  const api = { async cloudsearch(args) { calls++; assert.equal(args.cookie, 'PRIVATE_LOGIN'); throw { body: { code: -462, data: { verifyType: 40, verifyId: 1, verifyUrl: 'https://music.163.com/verify', verifyToken: 'CHALLENGE_TOKEN', params: { event_id: 'event', sign: 'signed' }, secret: 'PRIVATE_ACCOUNT' } }, cookie: ['PRIVATE_COOKIE'] }; } };
  const record = await requestVerification(api, 'PRIVATE_LOGIN');
  assert.equal(calls, 1); assert.equal(record.state, 'verification-available'); assert.equal(record.verifyType, 40);
  assert.equal(record.contextComplete,true);assert.doesNotMatch(JSON.stringify(record), /PRIVATE_/);
  const rejected = await requestVerification({ cloudsearch: async () => { throw { body: { code: -462, data: { verifyUrl: 'https://evil.example/?private=SECRET' } } }; } });
  assert.equal(rejected.state, 'verification-unavailable'); assert.equal(rejected.url, undefined);
});

test('stale or malformed records cannot launch a browser', () => {
  const now = Date.now(), record = { kind: 'TS Music Bot official verification page', createdAt: new Date(now).toISOString(), state: 'verification-available', contextComplete:true, url: completeVerificationUrl({verifyUrl:'https://st.music.163.com/encrypt-pages',verifyToken:'token',verifyId:1,verifyType:40,params:{event_id:'event'}}) };
  assert.equal(verificationPage(record, now), record.url);
  assert.equal(verificationPage(record, now + 600001), null);
  assert.equal(verificationPage({ ...record, createdAt: 'invalid' }, now), null);
  assert.equal(verificationPage({ ...record, kind: 'untrusted' }, now), null);
  assert.equal(verificationPage({...record,contextComplete:undefined},now),null);
  assert.equal(verificationPage({...record,url:'https://st.music.163.com/encrypt-pages'},now),null);
});

test('official page query parsing recovers every supplied field including nested signed parameters',()=>{
  const input={verifyUrl:'https://st.music.163.com/encrypt-pages',verifyId:1,verifyType:40,verifyToken:'token+/=&%',params:{event_id:'event+id',sign:'A&B=C+/='}};
  const url=new URL(completeVerificationUrl(input));
  const parsed=new URLSearchParams(decodeURIComponent(url.search.slice(1)));
  assert.equal(parsed.get('verifyToken'),input.verifyToken);assert.equal(parsed.get('verifyId'),'1');assert.equal(parsed.get('verifyType'),'40');
  assert.deepEqual(JSON.parse(parsed.get('params')),input.params);
  for(const key of ['verifyToken','verifyId','verifyType','params'])assert.equal(completeVerificationUrl({...input,[key]:undefined}),null);
  assert.equal(completeVerificationUrl({...input,params:'invalid-json'}),null);
});
