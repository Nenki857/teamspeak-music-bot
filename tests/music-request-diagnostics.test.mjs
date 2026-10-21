import test from 'node:test';
import assert from 'node:assert/strict';
import { musicFailure, probeApi, probeQr } from '../scripts/diagnose-server-music.mjs';
import { musicRequestError } from '../src/worker/music-request-error.mjs';

test('music diagnostics retain useful error codes without exposing upstream messages or credentials',()=>{
  const value=musicFailure({status:502,body:{code:502,msg:'connect ETIMEDOUT https://private.invalid/?cookie=MUSIC_U=secret'},cookie:['PRIVATE_COOKIE']});
  assert.equal(value.networkCode,'ETIMEDOUT');assert.equal(value.status,502);assert.equal(value.category,'network');
  assert.doesNotMatch(JSON.stringify(value),/private.invalid|MUSIC_U|secret|PRIVATE_COOKIE/);
  assert.equal(musicFailure({status:400,body:{code:-462,msg:'private account'}}).bodyCode,-462);
  assert.equal(musicFailure(new TypeError('private object')).category,'client-code');
});

test('restriction hints distinguish explicit text from an assumed IP ban without exporting verification tokens',()=>{
  const result=musicFailure({status:400,body:{code:-462,message:'网络太拥挤，请稍后再试',data:{actionCode:'1102401',verifyType:50,verifyUrl:'https://music.163.com/verify?token=PRIVATE',params:{sign:'PRIVATE_SIGN'}}}});
  assert.equal(result.restriction.noticeCategory,'upstream-network-busy');assert.equal(result.restriction.mentionsBan,false);
  assert.equal(result.restriction.actionCode,'1102401');assert.equal(result.restriction.verifyType,50);assert.equal(result.restriction.hasOfficialVerificationPage,true);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE|verify\?|https:|SIGN/);
  assert.equal(musicFailure({body:{code:-460,msg:'This IP address is banned'}}).restriction.mentionsIp,true);
});
test('anonymous probe separates song, playlist and album failures and never supplies account cookies',async()=>{
  const calls=[];
  const api={async cloudsearch(args){calls.push(args);if(args.type===1000)throw{status:403,body:{code:403,msg:'private response'}};return{status:200,body:{code:200}};},async personalized(args){calls.push(args);return{status:200,body:{code:200}};}};
  const report=await probeApi(api);
  assert.deepEqual(report.map(x=>x.ok),[true,false,true,true]);assert.equal(report[1].status,403);
  assert.ok(calls.every(args=>!Object.hasOwn(args,'cookie')&&args.limit===1));assert.doesNotMatch(JSON.stringify(report),/private response/);
});

test('actual upstream HTTP 400 with body -462 is shown as a restricted request without exposing its body',()=>{
  const failure=musicRequestError({status:400,body:{code:-462,msg:'MUSIC_U=private https://private.invalid'}});
  assert.match(failure.message,/-462/);assert.match(failure.message,/限制/);assert.equal(failure.status,400);
  assert.doesNotMatch(failure.message,/MUSIC_U|private|网络/);
  assert.match(musicRequestError({status:502,body:{code:502,msg:'connect ETIMEDOUT private'}}).message,/超时/);
  assert.match(musicRequestError({status:400,body:{code:301}}).message,/登录已失效/);
  assert.doesNotMatch(musicRequestError({message:'MUSIC_U=private'}).message,/private|MUSIC_U/);
});

test('QR diagnosis separates upstream key rejection from image creation and never exports login keys or QR URLs',async()=>{
  let creates=0;
  const denied=await probeQr({login_qr_key:async()=>{throw{status:400,body:{code:-462,msg:'private'}};},login_qr_create:async()=>{creates++;}});
  assert.equal(denied.stage,'request-key');assert.equal(denied.bodyCode,-462);assert.equal(creates,0);
  const ok=await probeQr({login_qr_key:async()=>({status:200,body:{code:200,data:{unikey:'PRIVATE_LOGIN_KEY'}}}),login_qr_create:async({key,qrimg})=>{
    assert.equal(key,'PRIVATE_LOGIN_KEY');assert.equal(qrimg,true);return{status:200,body:{code:200,data:{qrurl:'https://music.163.com/login?codekey=PRIVATE_LOGIN_KEY',qrimg:'data:image/png;base64,PRIVATE_IMAGE'}}};
  }});
  assert.equal(ok.ok,true);assert.equal(ok.imageGenerated,true);assert.doesNotMatch(JSON.stringify(ok),/PRIVATE_|codekey|qrurl|base64/);
  const broken=await probeQr({login_qr_key:async()=>({status:200,body:{code:200,data:{}}}),login_qr_create:async()=>{throw Error('must not run');}});
  assert.equal(broken.category,'missing-qr-key');
});
