import { deploymentBash } from '../scripts/bash-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture({pass=false,updateFailure=false,mode='guest', sourceIP='203.0.113.10'}={}){
  const base=resolve('work');mkdirSync(base,{recursive:true});
  const dir=mkdtempSync(join(base,'music-repair-test-')),app=join(dir,'app'),bin=join(dir,'bin'),report=join(dir,'report.json'),trace=join(dir,'trace.txt');
  for(const path of [join(app,'runtime/node/bin'),join(app,'src/worker'),bin])mkdirSync(path,{recursive:true});
  writeFileSync(join(app,'src/worker/netease-library.mjs'),readFileSync('src/worker/netease-library.mjs'));
  writeFileSync(join(app,'server.env'),'EXISTING_SETTINGS=unchanged\n');
  const unix=path=>path.replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase()).replaceAll('\\','/');
  const stub=(file,body)=>{writeFileSync(file,'#!/bin/sh\n'+body);chmodSync(file,0o755);};
  stub(join(bin,'systemctl'),'case "$1" in show) printf "%s\\n" "$TSMD_TEST_APP";; is-active) exit 0;; *) exit 99;; esac\n');
  stub(join(bin,'realpath'),'printf "%s\\n" "$2"\n');
  stub(join(bin,'sudo'),'printf "SUDO %s\\n" "$*" >> "$TSMD_TEST_TRACE";exit 0\n');
  stub(join(bin,'mktemp'),'printf "%s\\n" "$TSMD_TEST_BACKUP"\n');
  stub(join(bin,'curl'),'printf 401\n');
  stub(join(bin,'bash'),'exec /usr/bin/sh "$@"\n');
  stub(join(app,'runtime/node/bin/node'),'case "$1" in *checker.mjs) printf \'{"candidatePassed":'+pass+'}\\n\';exit '+(pass?'0':'21')+';; *) exec "$TSMD_TEST_NODE" "$@";; esac\n');
  const checker=join(dir,'checker.mjs'),adapter=join(dir,'adapter.mjs'),archive=join(dir,'archive.tar.gz'),updater=join(dir,'updater.sh');
  for(const path of [checker,adapter,archive])writeFileSync(path,'synthetic');
  if(mode.startsWith('maintained')){
    const library=join(app,'runtime/netease-api-4.41.1/node_modules/@neteasecloudmusicapienhanced/api');mkdirSync(library,{recursive:true});writeFileSync(join(library,'main.js'),'synthetic');
  }
  writeFileSync(updater,'printf "UPDATE\\n" >> "$TSMD_TEST_TRACE"\nexit '+(updateFailure?'15':'0')+'\n');writeFileSync(trace,'');
  const shell = deploymentBash();
  const args=[resolve('deploy/repair-server-music.sh'),checker,adapter,archive,'a'.repeat(64),updater,report,mode].map(unix);
  const result=spawnSync(shell,['--noprofile','--norc','-c','PATH="$1:/usr/bin:/bin";export PATH;shift;if [ "$TSMD_TEST_MODE" = maintained-ip ]; then exec /usr/bin/sh "$@" "$TSMD_TEST_SOURCE_IP"; else exec /usr/bin/sh "$@"; fi','test',unix(bin),...args],{encoding:'utf8',windowsHide:true,env:{...process.env,TSMD_TEST_MODE:mode,TSMD_TEST_SOURCE_IP:sourceIP,TSMD_TEST_APP:unix(app),TSMD_TEST_TRACE:unix(trace),TSMD_TEST_BACKUP:unix(join(dir,'environment-backup')),TSMD_TEST_NODE:unix(process.execPath)}});
  return{result,trace,app,report};
}
test('failed live music check cannot install, restart or change configuration',()=>{
  const {result,trace,app,report}=fixture();
  assert.equal(result.status,21,result.stdout+result.stderr);assert.match(result.stdout+result.stderr,/No running program, login or service was changed/);
  assert.equal(readFileSync(trace,'utf8'),'');assert.equal(readFileSync(join(app,'server.env'),'utf8'),'EXISTING_SETTINGS=unchanged\n');
  assert.equal(JSON.parse(readFileSync(report,'utf8')).candidatePassed,false);
});
test('successful live check enables only the music session flag and runs the normal updater',()=>{
  const {result,trace,app}=fixture({pass:true});assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal(readFileSync(join(app,'server.env'),'utf8'),'EXISTING_SETTINGS=unchanged\nTSMD_NETEASE_SESSION_FIX=1\n');
  assert.equal((readFileSync(trace,'utf8').match(/UPDATE/g)||[]).length,1);assert.match(result.stdout,/Music session repair enabled/);
});
test('update failure restores the prior environment instead of leaving the repair flag enabled',()=>{
  const {result,app}=fixture({pass:true,updateFailure:true});assert.equal(result.status,1,result.stdout+result.stderr);
  assert.equal(readFileSync(join(app,'server.env'),'utf8'),'EXISTING_SETTINGS=unchanged\n');assert.match(result.stderr,/previous environment was restored/);
});

test('web compatibility activates its server-only flag without requiring guest registration',()=>{
  const {result,app}=fixture({pass:true,mode:'web'});assert.equal(result.status,0,result.stdout+result.stderr);
  assert.equal(readFileSync(join(app,'server.env'),'utf8'),'EXISTING_SETTINGS=unchanged\nTSMD_NETEASE_WEB_REQUESTS=1\n');
  assert.match(result.stdout,/enabled \(web\)/);
});

test('maintained library is selected only after its server preflight passes',()=>{
  const good=fixture({pass:true,mode:'maintained'});assert.equal(good.result.status,0,good.result.stdout+good.result.stderr);
  assert.equal(readFileSync(join(good.app,'server.env'),'utf8'),'EXISTING_SETTINGS=unchanged\nTSMD_NETEASE_MAINTAINED_API=1\n');
  const failed=fixture({mode:'maintained'});assert.equal(failed.result.status,21,failed.result.stdout+failed.result.stderr);
  assert.equal(readFileSync(join(failed.app,'server.env'),'utf8'),'EXISTING_SETTINGS=unchanged\n');assert.equal(readFileSync(failed.trace,'utf8'),'');
});

test('actual-source mode activates together with the maintained library only after a passing check', () => {
  const good = fixture({ pass: true, mode: 'maintained-ip' });
  assert.equal(good.result.status, 0, good.result.stdout + good.result.stderr);
  assert.equal(readFileSync(join(good.app, 'server.env'), 'utf8'), 'EXISTING_SETTINGS=unchanged\nTSMD_NETEASE_MAINTAINED_API=1\nTSMD_NETEASE_SOURCE_IP=203.0.113.10\n');
  const failed = fixture({ mode: 'maintained-ip' });
  assert.equal(failed.result.status, 21, failed.result.stdout + failed.result.stderr);
  assert.equal(readFileSync(join(failed.app, 'server.env'), 'utf8'), 'EXISTING_SETTINGS=unchanged\n');
  assert.equal(readFileSync(failed.trace, 'utf8'), '');
  const rollback = fixture({ pass: true, updateFailure: true, mode: 'maintained-ip' });
  assert.equal(rollback.result.status, 1, rollback.result.stdout + rollback.result.stderr);
  assert.equal(readFileSync(join(rollback.app, 'server.env'), 'utf8'), 'EXISTING_SETTINGS=unchanged\n');
});

test('normal web login bootstrap does not select the app library and remains honest about unverified playback', () => {
  const good = fixture({ pass: true, mode: 'browser' });
  assert.equal(good.result.status, 0, good.result.stdout + good.result.stderr);
  assert.equal(readFileSync(join(good.app, 'server.env'), 'utf8'), 'EXISTING_SETTINGS=unchanged\nTSMD_NETEASE_WEB_CLIENT=1\n');
  assert.match(good.result.stdout, /Search and playback have NOT been verified/);
  const failed = fixture({ mode: 'browser' });
  assert.equal(failed.result.status, 21, failed.result.stdout + failed.result.stderr);
  assert.equal(readFileSync(failed.trace, 'utf8'), '');
});

test('source address repair accepts another configured public address and rejects invalid input before changes', () => {
  const good = fixture({ pass: true, mode: 'maintained-ip', sourceIP: '198.51.100.12' });
  assert.equal(good.result.status, 0, good.result.stdout + good.result.stderr);
  assert.match(readFileSync(join(good.app, 'server.env'), 'utf8'), /TSMD_NETEASE_SOURCE_IP=198[.]51[.]100[.]12/);
  for (const sourceIP of ['', '127.0.0.1', '10.0.0.1', '198.51.100.12\nEXTRA=1', 'example.com']) {
    const failed = fixture({ pass: true, mode: 'maintained-ip', sourceIP });
    assert.notEqual(failed.result.status, 0, JSON.stringify(sourceIP) + '\n' + failed.result.stdout + failed.result.stderr);
    assert.equal(readFileSync(join(failed.trace), 'utf8'), '');
    assert.equal(readFileSync(join(failed.app, 'server.env'), 'utf8'), 'EXISTING_SETTINGS=unchanged\n');
  }
});
