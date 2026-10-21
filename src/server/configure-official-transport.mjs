import { readFileSync,writeFileSync,renameSync,existsSync,chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createVault } from '../shared/security.mjs';
import { serverVaultKey } from './vault-key.mjs';
import { SinusBotApi } from './sinusbot-api.mjs';
import { initialPasswordCandidates, initializeSinusbot } from './sinusbot-initialization.mjs';
export function changeBackend(environment,backend){if(!['custom','official'].includes(backend))throw Error('音频链路无效');return environment.split(/\r?\n/).filter(line=>!/^TSMD_AUDIO_BACKEND=/.test(line)).join('\n').trimEnd()+`\nTSMD_AUDIO_BACKEND=${backend}\n`;}
export function sinusbotConfiguration(text,client){if(!/^\/[A-Za-z0-9_./-]+$/.test(client))throw Error('客户端路径无效');return `TS3Path = "${client}"\nListenHost = "127.0.0.1"\nListenPort = 18087\nEnableWebStream = false\n`+text.split(/\r?\n/).filter(line=>!/^\s*(TS3Path|ListenHost|ListenPort|EnableWebStream)\s*=/.test(line)).join('\n');}
function atomic(file,value){writeFileSync(file+'.new',value,{mode:0o600});renameSync(file+'.new',file);chmodSync(file,0o600);}
export async function configure({app,operation}){
  const directory=resolve(process.env.TSMD_DATA_DIR||resolve(app,'server-data')),file=resolve(directory,'official-transport.json');
  if(operation==='--initialize'){const result=initializeSinusbot(app);console.log(JSON.stringify(result));return;}
  if(operation==='--render-config'){const base=resolve(app,'runtime/sinusbot');atomic(resolve(base,'config.ini'),sinusbotConfiguration(readFileSync(resolve(base,'config.ini.dist'),'utf8'),resolve(base,'TeamSpeak3-Client-linux_amd64/ts3client_linux_amd64')));return;}
  if(operation==='--custom'){atomic(resolve(app,'server.env'),changeBackend(readFileSync(resolve(app,'server.env'),'utf8'),'custom'));console.log('Selected archived-compatible original transport.');return;}
  const vault=createVault(serverVaultKey(directory));let config;
  if(existsSync(file)){const saved=JSON.parse(readFileSync(file,'utf8'));config={...saved,password:vault.decrypt(saved.password)};}
  else{
    const initial=readFileSync(resolve(directory,'sinusbot-init.log'),'utf8').replace(/\x1b\[[0-9;]*m/g,'');
    const candidates=initialPasswordCandidates(initial);
    for(const password of candidates){const candidate={url:'http://127.0.0.1:18087',username:'admin',password};try{await new SinusBotApi(candidate).login();config=candidate;break;}catch{}}
    if(!config)throw Error('未能读取并验证音频桥初始密码。旧链路未切换；请查看服务器受保护的 sinusbot-init.log。');
  }
  const api=new SinusBotApi(config);await api.login();
  if(!config.instanceId){let instances=await api.request('/bot/instances');if(!Array.isArray(instances))throw Error('音频桥实例列表无效');let item=instances.find(instance=>instance.backend==='ts3');if(!item)item=await api.request('/bot/instances','POST',{backend:'ts3',nick:'Music Bot'});config.instanceId=item.uuid;}
  await new SinusBotApi(config).instance('/settings','GET');
  atomic(file,JSON.stringify({...config,password:vault.encrypt(config.password)},null,2)+'\n');
  if(operation==='--official'){atomic(resolve(app,'server.env'),changeBackend(readFileSync(resolve(app,'server.env'),'utf8'),'official'));console.log('Selected official TS3 client transport.');}
  else if(operation==='--probe'){const value=await api.control('status');console.log(JSON.stringify({backend:'official-client-sinusbot',bridgeVersion:value.bridgeVersion,connected:value.connected,channelId:value.channelId}));}
  else console.log('Private audio bridge credentials and instance configured.');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){configure({app:resolve(process.argv[3]||'.'),operation:process.argv[2]||'--bootstrap'}).catch(()=>{console.error('官方音频桥配置未完成；请检查其私有初始化日志、实例和 18087 监听。不会输出密码。');process.exitCode=1;});}
