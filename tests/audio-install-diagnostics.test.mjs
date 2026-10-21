import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { classifyAudioErrors, collectAudioDiagnostics, sanitizedAudioErrors } from '../scripts/diagnose-server-audio.mjs';

test('audio error classification identifies missing libraries and flags without returning raw credential logs',()=>{
  const value=classifyAudioErrors('Initial admin password: synthetic-secret\nBearer token: secret-token\n./sinusbot: error while loading shared libraries: libssl.so.1.1: cannot open shared object file\nflag provided but not defined: -initonly\n');
  assert.ok(value.issues.includes('shared-library-load-failed'));assert.ok(value.issues.includes('unsupported-command-option'));assert.deepEqual(value.missingLibraries,['libssl.so.1.1']);assert.ok(!JSON.stringify(value).includes('synthetic-secret'));assert.ok(!JSON.stringify(value).includes('secret-token'));
});
test('installation report locates the incomplete stage and calls only read-only service/log commands',()=>{
  const app=resolve('work/synthetic-audio-report');const files=new Map([
    [resolve(app,'server.env'),'TSMD_AUDIO_BACKEND=custom\nSENSITIVE_VALUE=never-export-this\n'],
    [resolve(app,'runtime/sinusbot/sinusbot'),'binary'],
    [resolve(app,'runtime/sinusbot/TeamSpeak3-Client-linux_amd64/ts3client_linux_amd64'),'binary'],
    [resolve(app,'server-data/sinusbot-init.log'),'Initial admin password: never-export-password\nerror while loading shared libraries: libavformat.so.58: cannot open shared object file']
  ]);const calls=[];
  const value=collectAudioDiagnostics(app,{read:path=>{if(!files.has(path))throw Error();return files.get(path);},exists:path=>files.has(path),command:(name,args)=>{calls.push([name,args]);return name==='systemctl'?{status:0,stdout:'LoadState=not-found\nActiveState=inactive\nExecMainStatus=255\nEnvironment=never-export-env'}:{status:0,stdout:'Error spawning TeamSpeak client'};}});
  assert.equal(value.backend,'custom');assert.deepEqual(value.possibleStages,['private-bridge-initialization-incomplete']);assert.deepEqual(value.initializationLog.missingLibraries,['libavformat.so.58']);assert.equal(value.services.official.ExecMainStatus,'255');
  assert.equal(value.rawLogsIncluded,false);assert.ok(!/never-export/.test(JSON.stringify(value)));
  assert.equal(calls.length,3);assert.ok(calls.every(([name,args])=>(name==='systemctl'&&args[0]==='show')||(name==='journalctl'&&args.includes('--no-pager'))));
});
test('unknown failure excerpts omit credential lines, URLs and long opaque identifiers',()=>{
  const value=sanitizedAudioErrors('Error password: do-not-forward\nError token: another-secret\nError fetching https://private.invalid/key?value=opaque\nFATAL invalid configuration field XYZ\nError request abcdefghijklmnopqrstuvwxyz0123456789');
  assert.ok(!/do-not-forward|another-secret|private.invalid|abcdefghijklmnopqrstuvwxyz/.test(JSON.stringify(value)));assert.ok(value.some(line=>line.includes('invalid configuration field')));assert.ok(value.some(line=>line.includes('<url>')));
});
