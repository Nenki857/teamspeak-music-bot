import { deploymentBash } from './bash-runtime.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fixedEndpointConfig, writeFixedEndpointFiles } from '../src/server/fixed-endpoint-config.mjs';
const shell = deploymentBash();
const unix=path=>path.replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase()).replaceAll('\\','/');
for(const file of ['deploy/update-ubuntu.sh','deploy/enable-fixed-endpoint.sh','deploy/install-ubuntu.sh','deploy/preflight.sh','deploy/official-transport.sh']){
  const checked=spawnSync(shell,['-n',file],{encoding:'utf8',windowsHide:true});assert.equal(checked.status,0,checked.stderr);
}
const base=resolve('work');mkdirSync(base,{recursive:true});
const stage=mkdtempSync(join(base,'fixed-deploy-check-')),app=join(stage,'app'),bin=join(stage,'bin'),trace=join(stage,'sudo-trace');
for(const tree of ['runtime/node/bin','server-data','src/server'])mkdirSync(join(app,tree),{recursive:true});mkdirSync(bin);
writeFileSync(join(app,'runtime/node/bin/node'),'#!/bin/sh\nexit 0\n');chmodSync(join(app,'runtime/node/bin/node'),0o755);
writeFileSync(join(app,'server-data/server-admin.json'),'{}');writeFileSync(join(app,'server.env'),'TSMD_HOST=127.0.0.1\nTSMD_PORT=18080\n');
for(const name of ['fixed-endpoint-config.mjs','persistent-shares.mjs'])writeFileSync(join(app,'src/server',name),'');
function stub(name,text){writeFileSync(join(bin,name),'#!/bin/sh\n'+text);chmodSync(join(bin,name),0o755);}
stub('systemctl','case "$1" in show) printf "%s\\n" "$TSMD_TEST_APP";; is-active) exit 0;; *) echo "Unexpected service operation" >&2;exit 91;; esac\n');
stub('sudo','printf "%s\\n" "$*" >> "$TSMD_TEST_TRACE"\nexit 1\n');stub('ss','exit 0\n');
const archive=join(stage,'synthetic.tar.gz');writeFileSync(archive,'synthetic archive: permission refusal must happen before extraction');const digest=createHash('sha256').update(readFileSync(archive)).digest('hex');
// MinGit omits sha256sum. Archive hashes are independently checked by the
// package checker; this fixture exercises only the denied-sudo control flow.
stub('sha256sum',`printf '%s  %s\\n' '${digest}' "$1"\n`);
stub('realpath','if [ "$1" = -e ]; then shift; fi\nprintf "%s\\n" "$1"\n');
for(const[script,args]of [['deploy/update-ubuntu.sh',[unix(archive),digest]],['deploy/enable-fixed-endpoint.sh',['203.0.113.10']]]){
  const checked=spawnSync(shell,['--noprofile','--norc','-c','PATH="$1:/usr/bin:/bin";export PATH;shift;exec /usr/bin/sh "$@"','check',unix(bin),unix(resolve(script)),...args],{encoding:'utf8',windowsHide:true,env:{...process.env,TSMD_TEST_APP:unix(app),TSMD_TEST_TRACE:unix(trace)}});
  assert.equal(checked.status,20,checked.stderr);assert.ok(!existsSync(join(app,'runtime/caddy')));assert.equal(readFileSync(join(app,'server.env'),'utf8'),'TSMD_HOST=127.0.0.1\nTSMD_PORT=18080\n');
}
assert.ok(readFileSync(trace,'utf8').trim().split('\n').every(line=>line.startsWith('-n -l ')),'only permission checks may run, no stop/restart');
console.log('Deployment checks passed: shell syntax; denied sudo exits before stopping services or staging/replacing files. Only synthetic local commands were used.');
// Exercise the retry after the download succeeded but configuration failed.
// Every external operation is a local stub; no service, network or sudo runs.
const generated=join(stage,'generated');mkdirSync(generated);
const fixtureConfig=writeFixedEndpointFiles({ip:'203.0.113.10',app:unix(app),user:'ubuntu',environment:readFileSync(join(app,'server.env'),'utf8')},generated);
writeFileSync(join(app,'runtime/node/bin/node'),'#!/bin/sh\nfor name in Caddyfile environment unit; do cp "$TSMD_TEST_GENERATED/$name" "$5/$name"; done\n');
mkdirSync(join(app,'runtime/caddy'),{recursive:true});
const retryStage=join(app,'runtime/caddy/setup-fixture');
for(const tree of [retryStage,join(app,'server-data/https'),join(app,'server-data/https-config')])mkdirSync(tree,{recursive:true});
// MSYS mkdir -p probes sandbox-denied ancestor directories on Windows.
// Node has created the exact synthetic directories; keep those probes local.
stub('mkdir','exit 0\n');
stub('mktemp','printf "%s\\n" "$TSMD_TEST_RETRY_STAGE"\n');
stub('id','printf "ubuntu\\n"\n');stub('chmod','exit 0\n');
const cachedCaddy='#!/bin/sh\n[ "$1" = adapt ] && [ "$2" = --config ] || exit 92\ncase "$3" in */Caddyfile) ;; *) exit 93;; esac\ncmp "$3" "$TSMD_TEST_GENERATED/Caddyfile" || exit 94\nprintf "{}\\n"\n';
writeFileSync(join(app,'runtime/caddy/caddy'),cachedCaddy);chmodSync(join(app,'runtime/caddy/caddy'),0o755);
stub('sudo','printf "%s\\n" "$*" >> "$TSMD_TEST_TRACE"\nexit 0\n');
stub('curl','case "$*" in *api/admin/session*) printf 404;; *http://127.0.0.1:18081/*) printf 200;; *https://203.0.113.10/*) exit 0;; *) echo "Unexpected download or request" >&2; exit 95;; esac\n');
stub('tar','echo "Cached retry must not extract or download Caddy" >&2;exit 96\n');
const retried=spawnSync(shell,['--noprofile','--norc','-c','PATH="$1:/usr/bin:/bin";export PATH;shift;exec /usr/bin/sh "$@"','check',unix(bin),unix(resolve('deploy/enable-fixed-endpoint.sh')),'203.0.113.10'],{encoding:'utf8',windowsHide:true,env:{...process.env,TSMD_TEST_APP:unix(app),TSMD_TEST_TRACE:unix(trace),TSMD_TEST_GENERATED:unix(generated),TSMD_TEST_RETRY_STAGE:unix(retryStage)}});
assert.equal(retried.status,0,retried.stdout+'\n'+retried.stderr);
assert.match(retried.stdout,/Reusing the Caddy program/);
assert.equal(readFileSync(join(app,'runtime/caddy/caddy'),'utf8'),cachedCaddy,'retry preserves the cached executable');
assert.equal(readFileSync(join(app,'runtime/caddy/Caddyfile'),'utf8'),fixtureConfig.caddy);
assert.equal(readFileSync(join(app,'server.env'),'utf8'),fixtureConfig.environment);
console.log('Cached HTTPS retry passed with simulated commands: no download or extraction; text config and executable stay separate.');
const checkHelper=join(stage,'check-helper.mjs');writeFileSync(checkHelper,'synthetic diagnostic helper');
writeFileSync(join(app,'runtime/node/bin/node'),'#!/bin/sh\nprintf "READ_ONLY_DIAGNOSTIC_HELPER_REACHED\\n"\n');
const traceBefore=readFileSync(trace,'utf8'),environmentBefore=readFileSync(join(app,'server.env'),'utf8');
const diagnostic=spawnSync(shell,['--noprofile','--norc','-c','PATH="$1:/usr/bin:/bin";export PATH;shift;exec /usr/bin/sh "$@"','check',unix(bin),unix(resolve('deploy/official-transport.sh')),'--diagnose',unix(checkHelper)],{encoding:'utf8',windowsHide:true,env:{...process.env,TSMD_TEST_APP:unix(app),TSMD_TEST_TRACE:unix(trace)}});
assert.equal(diagnostic.status,0,diagnostic.stderr);assert.match(diagnostic.stdout,/READ_ONLY_DIAGNOSTIC_HELPER_REACHED/);assert.equal(readFileSync(trace,'utf8'),traceBefore,'diagnostic mode must not run sudo or change any service');assert.equal(readFileSync(join(app,'server.env'),'utf8'),environmentBefore);
console.log('Read-only audio installation diagnosis reaches only the helper; no sudo, dependency installation, configuration writes or service restarts.');
const caddy=resolve('work/caddy-validation/caddy.exe');
if(existsSync(caddy)){
  const configuration=fixedEndpointConfig({ip:'203.0.113.10',app:'/home/ubuntu/ts-music-desk',user:'ubuntu',environment:'TSMD_PORT=18080\nTSMD_HOST=127.0.0.1\n'});const file=join(stage,'Caddyfile');writeFileSync(file,configuration.caddy);
  const checked=spawnSync(caddy,['adapt','--config',file,'--adapter','caddyfile'],{encoding:'utf8',windowsHide:true});assert.equal(checked.status,0,checked.stderr);
  const adapted=JSON.parse(checked.stdout);assert.equal(adapted.admin.disabled,true);const policy=adapted.apps.tls.automation.policies[0];assert.equal(policy.issuers[0].profile,'shortlived');
  assert.equal(policy.issuers[0].module,'acme');assert.ok(!checked.stdout.includes('18080'));assert.ok(checked.stdout.includes('127.0.0.1:18081'));
  console.log('Official Caddy 2.11.7 accepted the generated IP HTTPS configuration. No listener or certificate issuance was started.');
}else console.log('Caddy binary unavailable; runtime config adaptation was not checked.');
