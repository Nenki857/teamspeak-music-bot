import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareOfficialAudio, validateAudioArchive, officialSinusbotUrl } from '../scripts/prepare-official-audio.mjs';
mkdirSync('work/official-audio-download-tests',{recursive:true});
const temp=()=>mkdtempSync(resolve('work/official-audio-download-tests/run-'));
function fixture(){const dir=temp(),files=join(dir,'files'),file=join(dir,'sinusbot.current.tar.bz2');mkdirSync(join(files,'plugin'),{recursive:true});for(const name of ['sinusbot','config.ini.dist','plugin/libsoundbot_plugin.so'])writeFileSync(join(files,name),'synthetic fixture '+name);const packed=spawnSync('tar',['-cjf',file,'-C',files,'.'],{windowsHide:true,encoding:'utf8'});assert.equal(packed.status,0,packed.stderr);return{dir,file};}
test('browser-downloaded official archive is validated, copied and cached without a remote download',async()=>{
  const {dir,file}=fixture(),cache=join(dir,'cache');let requests=0;const fetcher=async()=>{requests++;throw Error('must not download');};
  const target=await prepareOfficialAudio({directory:cache,downloads:dir,fetcher,log:()=>{}});
  assert.deepEqual(readFileSync(target),readFileSync(file));assert.ok(readFileSync(target+'.sha256','utf8').startsWith(validateAudioArchive(file)));
  await prepareOfficialAudio({directory:cache,downloads:join(dir,'missing'),fetcher,log:()=>{}});assert.equal(requests,0);
});
test('HTTP 403 gives a manual official-download instruction and does not create an installable cache',async()=>{
  const dir=temp(),cache=join(dir,'cache');let requested;
  await assert.rejects(prepareOfficialAudio({directory:cache,downloads:join(dir,'downloads'),fetcher:async url=>{requested=url;return new Response('Forbidden',{status:403});},log:()=>{}}),error=>/HTTP 403/.test(error.message)&&/Download for Linux 64 bit/.test(error.message)&&/尚未更新或停止服务器机器人/.test(error.message));
  assert.equal(requested,officialSinusbotUrl);assert.equal(existsSync(join(cache,'sinusbot.current.tar.bz2')),false);assert.equal(existsSync(join(cache,'sinusbot.current.tar.bz2.part')),false);
});
test('successful download must contain an actual complete archive, not an HTML challenge or partial file',async()=>{
  const {dir,file}=fixture(),cache=join(dir,'cache');const target=await prepareOfficialAudio({directory:cache,downloads:join(dir,'missing'),fetcher:async()=>new Response(readFileSync(file),{headers:{'content-type':'application/octet-stream'}}),log:()=>{}});assert.equal(validateAudioArchive(target),validateAudioArchive(file));
  const bad=temp();await assert.rejects(prepareOfficialAudio({directory:bad,downloads:join(bad,'missing'),fetcher:async()=>new Response('<html>verify</html>',{headers:{'content-type':'text/html'}}),log:()=>{}}),/网页验证/);
  const partial=temp();await assert.rejects(prepareOfficialAudio({directory:partial,downloads:join(partial,'missing'),fetcher:async()=>new Response('BZh'+'x'.repeat(200)),log:()=>{}}),/无法完整解压/);assert.equal(existsSync(join(partial,'sinusbot.current.tar.bz2.part')),false);
});
