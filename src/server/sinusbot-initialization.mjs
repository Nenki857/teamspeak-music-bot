import { existsSync, readFileSync, openSync, closeSync, chmodSync, writeSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
export function initialPasswordCandidates(text) {
  const clean=String(text).replace(/\x1b\[[0-9;]*m/g,'');
  return [...new Set([...clean.matchAll(/password(?:\s+is)?\s*[:=]?\s*["']?([^\s"',]{6,128})/gi)].map(match=>match[1]))].slice(-5);
}
export function inspectInitialization(text) {
  return { completed:/\bInitialization complete\b/i.test(String(text)), hasInitialPassword:initialPasswordCandidates(text).length>0 };
}
export function initializeSinusbot(app,{run=spawnSync}={}) {
  const directory=resolve(app,'server-data'),file=resolve(directory,'sinusbot-init.log');
  if(existsSync(resolve(directory,'official-transport.json')))return {reused:true,accountAlreadyConfigured:true};
  const before=existsSync(file)?readFileSync(file,'utf8'):'';const previous=inspectInitialization(before);
  if(previous.completed&&previous.hasInitialPassword)return {reused:true,initializationCompleted:true};
  // Preserve the first generated password when retrying an interrupted setup.
  const output=openSync(file,'a',0o600);let result;
  try{
    chmodSync(file,0o600);writeSync(output,'\n--- Music Desk initialization attempt ---\n');
    result=run(resolve(app,'runtime/sinusbot/sinusbot'),['--initonly'],{cwd:resolve(app,'runtime/sinusbot'),stdio:['ignore',output,output],timeout:60000,windowsHide:true});
  }finally{closeSync(output);}
  const state=inspectInitialization(readFileSync(file,'utf8'));
  if(result.error||![0,255].includes(result.status)||!state.completed||!state.hasInitialPassword)throw Error('音频桥初始化尚未确认完成，原始私有日志已保留；音频选项未切换');
  // This only permits service startup. Private API authentication must still
  // succeed in --bootstrap before the installer can select this backend.
  return {reused:false,initializationCompleted:true,exitCode:result.status};
}
