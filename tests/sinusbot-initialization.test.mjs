import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { initializeSinusbot, inspectInitialization, initialPasswordCandidates } from '../src/server/sinusbot-initialization.mjs';
mkdirSync('work/sinusbot-init-tests',{recursive:true});
function fixture(){const app=mkdtempSync(resolve('work/sinusbot-init-tests/run-'));mkdirSync(resolve(app,'server-data'));mkdirSync(resolve(app,'runtime/sinusbot'),{recursive:true});return {app,log:resolve(app,'server-data/sinusbot-init.log')};}
test('initialization exit 255 requires explicit completion and a private password record',()=>{
  const {app,log}=fixture();const result=initializeSinusbot(app,{run:(file,args,options)=>{assert.equal(file,resolve(app,'runtime/sinusbot/sinusbot'));assert.deepEqual(args,['--initonly']);writeSync(options.stdio[1],'Initial admin password: synthetic-private-password\nInitialization complete\n');return {status:255};}});
  assert.equal(result.exitCode,255);assert.equal(result.initializationCompleted,true);assert.ok(!JSON.stringify(result).includes('synthetic-private-password'));assert.equal(inspectInitialization(readFileSync(log,'utf8')).hasInitialPassword,true);
  let executed=false;assert.equal(initializeSinusbot(app,{run:()=>{executed=true;}}).reused,true);assert.equal(executed,false);
});
test('actual initialization failures remain failures and retries preserve previous private output',()=>{
  for(const status of [0,1,255]){
    const {app,log}=fixture();writeFileSync(log,'Preserved first password: first-synthetic-password\n');
    assert.throws(()=>initializeSinusbot(app,{run:(_file,_args,options)=>{writeSync(options.stdio[2],'Failed before initialization completed\n');return {status};}}),/未确认完成/);
    assert.ok(readFileSync(log,'utf8').includes('first-synthetic-password'));
  }
  const {app}=fixture();assert.throws(()=>initializeSinusbot(app,{run:(_file,_args,options)=>{writeSync(options.stdio[1],'password: synthetic-private-password\nInitialization complete\n');return {status:null,error:new Error('timeout')};}}),/未确认完成/);
});
test('existing bridge account skips initialization and candidate extraction does not output credentials in status',()=>{
  const {app}=fixture();writeFileSync(resolve(app,'server-data/official-transport.json'),'synthetic encrypted account marker');
  assert.equal(initializeSinusbot(app,{run:()=>{throw Error('must not run');}}).accountAlreadyConfigured,true);
  const text='\u001b[32mpassword is "synthetic-password-one"\u001b[0m\npassword: synthetic-password-two\nInitialization complete';
  assert.deepEqual(initialPasswordCandidates(text),['synthetic-password-one','synthetic-password-two']);assert.deepEqual(inspectInitialization(text),{completed:true,hasInitialPassword:true});
});
