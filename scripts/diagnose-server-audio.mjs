import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Report known failure categories only. Never return raw initialization logs:
// SinusBot can put its initial password in those logs.
export function classifyAudioErrors(text = '') {
  const issues = new Set(); const missingLibraries = new Set();
  const patterns = [
    [/error while loading shared libraries|cannot open shared object|could not load.*lib/i,'shared-library-load-failed'],
    [/permission denied|EACCES/i,'permission-denied'],
    [/address already in use|EADDRINUSE/i,'port-already-in-use'],
    [/unknown (?:flag|option)|flag provided but not defined/i,'unsupported-command-option'],
    [/(?:run|running|start).{0,30}(?:as root|root user)/i,'root-user-rejected'],
    [/(?:could not|cannot|failed to).{0,40}(?:lock|already running)/i,'process-lock-conflict'],
    [/(?:could not|cannot|failed to|unable to).{0,40}(?:TS3|teamspeak|client)/i,'teamspeak-client-start-failed'],
    [/(?:could not|cannot|failed to|unable to).{0,40}(?:config|database)/i,'config-or-database-failed'],
    [/(?:SSL|certificate).{0,40}(?:error|failed|invalid|expired)|TLS handshake/i,'tls-connection-failed'],
    [/no such file or directory|ENOENT/i,'file-not-found'],
    [/segmentation fault|SIGSEGV|panic:/i,'process-crashed']
  ];
  for(const line of String(text).split(/\r?\n/)){
    for(const [pattern,code] of patterns)if(pattern.test(line))issues.add(code);
    if(/error while loading shared libraries|cannot open shared object|could not load.*lib/i.test(line)){
      for(const match of line.matchAll(/\b(lib[A-Za-z0-9_+.-]{1,80}\.so(?:\.\d+)*)\b/g))missingLibraries.add(match[1]);
    }
  }
  return { issues:[...issues], missingLibraries:[...missingLibraries] };
}
export function sanitizedAudioErrors(text='') {
  return String(text).replace(/\x1b\[[0-9;]*m/g,'').split(/\r?\n/)
    .filter(line=>/error|fatal|failed|could not|couldn't|unable|cannot|can't|invalid|denied|not found|unsupported|exception|panic|too old|expired/i.test(line))
    .filter(line=>!/(?:password|token|cookie|secret|authorization|bearer|MUSIC_U|csrf|credential|username|login|account)/i.test(line))
    .slice(-8).map(line=>line.replace(/https?:\/\/\S+/gi,'<url>').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,'<email>').replace(/[A-Za-z0-9_+/=-]{24,}/g,'<redacted>').slice(0,240));
}
export function collectAudioDiagnostics(app, { read=readFileSync, exists=existsSync, command=spawnSync } = {}) {
  const safeRead=file=>{try{return String(read(file,'utf8')).slice(-256*1024);}catch{return '';}};
  const run=(name,args)=>{try{return command(name,args,{encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:512*1024});}catch{return {status:1,stdout:''};}};
  const service=name=>{
    const result=run('systemctl',['show',name,'-p','LoadState','-p','ActiveState','-p','SubState','-p','Result','-p','ExecMainCode','-p','ExecMainStatus']);
    const fields={};for(const line of (result.stdout||'').split(/\r?\n/)){const [key,value]=line.split('=');if(['LoadState','ActiveState','SubState','Result','ExecMainCode','ExecMainStatus'].includes(key)&&/^[a-zA-Z0-9_-]{1,40}$/.test(value||''))fields[key]=value;}
    return fields;
  };
  const environment=safeRead(resolve(app,'server.env'));
  const backend=environment.match(/^TSMD_AUDIO_BACKEND=(custom|official)\r?$/m)?.[1]||'custom';
  const base=resolve(app,'runtime/sinusbot');
  const files={sinusbot:exists(resolve(base,'sinusbot')),teamspeakClient:exists(resolve(base,'TeamSpeak3-Client-linux_amd64/ts3client_linux_amd64')),audioPlugin:exists(resolve(base,'TeamSpeak3-Client-linux_amd64/plugins/libsoundbot_plugin.so')),bridgeConfig:exists(resolve(base,'config.ini')),encryptedBridgeAccount:exists(resolve(app,'server-data/official-transport.json')),originalArchiveRecord:exists(resolve(app,'runtime/last-audio-chain-archive.path'))};
  const initial=safeRead(resolve(app,'server-data/sinusbot-init.log'));
  const initializationCompleted=/\bInitialization complete\b/i.test(initial);
  const initialPasswordRecorded=/password(?:\s+is)?\s*[:=]?\s*["']?[^\s"',]{6,128}/i.test(initial);
  const journal=run('journalctl',['-u','ts-music-desk-official.service','-n','80','--no-pager','--output=cat']);
  const reasons=[];
  if(!files.sinusbot)reasons.push('audio-component-not-extracted');
  else if(!files.teamspeakClient)reasons.push('teamspeak-client-installation-incomplete');
  else if(!files.encryptedBridgeAccount)reasons.push('private-bridge-initialization-incomplete');
  else if(backend!=='official')reasons.push('bridge-installed-but-backend-not-selected');
  return {kind:'TS Music Desk audio installation diagnostics',capturedAt:new Date().toISOString(),backend,files,services:{music:service('ts-music-desk.service'),official:service('ts-music-desk-official.service')},initializationLog:{present:exists(resolve(app,'server-data/sinusbot-init.log')),initializationCompleted,initialPasswordRecorded,...classifyAudioErrors(initial),sanitizedErrors:sanitizedAudioErrors(initial)},serviceLog:{readable:journal.status===0,...classifyAudioErrors(journal.stdout||''),sanitizedErrors:sanitizedAudioErrors(journal.stdout||'')},possibleStages:reasons,rawLogsIncluded:false};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(!process.argv[2])throw Error();console.log(JSON.stringify(collectAudioDiagnostics(resolve(process.argv[2])),null,2));}
  catch{console.error('Audio diagnostic collection did not complete. No configuration or playback changes were requested.');process.exitCode=1;}
}
