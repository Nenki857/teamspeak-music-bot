import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';

const NETWORK_CODES = ['ENOTFOUND','EAI_AGAIN','ETIMEDOUT','ECONNABORTED','ECONNRESET','ECONNREFUSED','ENETUNREACH','EHOSTUNREACH','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID','DEPTH_ZERO_SELF_SIGNED_CERT'];
const number = value => Number.isFinite(Number(value)) && Math.abs(Number(value)) < 1000000 ? Number(value) : null;
// Never serialize upstream messages, cookies, query parameters or response bodies.
export function musicFailure(error) {
  const status = number(error?.status ?? error?.response?.status);
  const bodyCode = number(error?.body?.code ?? error?.response?.data?.code);
  const text = [error?.code,error?.cause?.code,error?.message,error?.body?.msg,error?.response?.data?.msg].filter(value=>typeof value==='string').join(' ');
  const networkCode = NETWORK_CODES.find(code=>new RegExp('\\b'+code+'\\b').test(text)) || (/timeout|timed out/i.test(text) ? 'TIMEOUT' : null);
  const body=error?.body||error?.response?.data||{}, data=body?.data;
  const notice=[body.message,body.msg,data?.blockText].filter(value=>typeof value==='string').join(' ').slice(0,2000);
  const actionCode=/^\d{1,16}$/.test(String(data?.actionCode||''))?String(data.actionCode):null;
  const verifyType=Number.isFinite(data?.verifyType)?data.verifyType:null;
  let hasOfficialVerificationPage=false;
  try{const url=new URL(data?.verifyUrl);hasOfficialVerificationPage=url.protocol==='https:'&&(url.hostname==='music.163.com'||url.hostname.endsWith('.music.163.com'));}catch{}
  const restriction=[-460,-462].includes(bodyCode)||actionCode||verifyType!==null?{
    actionCode,verifyType,hasOfficialVerificationPage,
    noticeCategory:/网络太拥挤/.test(notice)?'upstream-network-busy':/cheating|风控|风险/i.test(notice)?'risk-control':/封禁|封锁|拉黑|banned|blacklisted/i.test(notice)?'ban-mentioned':'unspecified',
    mentionsBan:/封禁|封锁|拉黑|banned|blacklisted/i.test(notice),
    mentionsIp:/\bIP\b|IP地址|ip address/i.test(notice)
  }:undefined;
  return { ok:false, status, bodyCode, networkCode, category:networkCode?'network':status||bodyCode?'upstream-response':['TypeError','SyntaxError','ReferenceError'].includes(error?.name)?'client-code':'unknown',...(restriction?{restriction}:{}) };
}
async function bounded(work, milliseconds=12000) {
  let timer;
  try { return await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('timeout'),{code:'ETIMEDOUT'})),milliseconds);})]); }
  finally { clearTimeout(timer); }
}
export async function probeApi(api, { stopOnFailure = false } = {}) {
  const definitions=[['searchSongs','cloudsearch',{keywords:'音乐',type:1,limit:1}],['searchPlaylists','cloudsearch',{keywords:'音乐',type:1000,limit:1}],['searchAlbums','cloudsearch',{keywords:'音乐',type:10,limit:1}],['recommendedPlaylists','personalized',{limit:1}]];
  const probe = async([name,method,args])=>{
    const started=Date.now();
    if(typeof api[method]!=='function')return{name,ok:false,category:'api-method-missing'};
    try {
      const response=await bounded(Promise.resolve().then(()=>api[method](args)));
      const status=number(response?.status),bodyCode=number(response?.body?.code);
      const ok=status===200&&bodyCode===200;
      return {name,elapsedMs:Date.now()-started,...(ok?{ok:true,status,bodyCode}:{...musicFailure(response)})};
    }catch(error){return{name,elapsedMs:Date.now()-started,...musicFailure(error)};}
  };
  if (!stopOnFailure) return Promise.all(definitions.map(probe));
  const results = [];
  for (const definition of definitions) {
    const result = await probe(definition); results.push(result);
    if (!result.ok) break;
  }
  return results;
}
export async function probeQr(api) {
  if(typeof api.login_qr_key!=='function'||typeof api.login_qr_create!=='function')return{ok:false,category:'api-method-missing'};
  let key;
  try{
    const result=await bounded(Promise.resolve().then(()=>api.login_qr_key({timestamp:Date.now()})));
    key=result?.body?.data?.unikey;
    if(result?.status!==200||result?.body?.code!==200)return{stage:'request-key',...musicFailure(result)};
    if(typeof key!=='string'||!key)return{ok:false,stage:'request-key',category:'missing-qr-key'};
  }catch(error){return{stage:'request-key',...musicFailure(error)};}
  try{
    const result=await bounded(Promise.resolve().then(()=>api.login_qr_create({key,qrimg:true})));
    if(result?.status!==200||result?.body?.code!==200)return{stage:'create-image',...musicFailure(result)};
    const data=result?.body?.data;
    return{ok:typeof data?.qrurl==='string'&&data.qrurl.startsWith('https://music.163.com/')&&typeof data?.qrimg==='string'&&data.qrimg.startsWith('data:image/'),stage:'create-image',keyReceived:true,imageGenerated:typeof data?.qrimg==='string'&&data.qrimg.startsWith('data:image/')};
  }catch(error){return{stage:'create-image',...musicFailure(error)};}
}
async function networkProbe(host) {
  let dns;
  try { const addresses=await bounded(lookup(host,{all:true}),7000);dns={ok:true,ipv4:addresses.filter(a=>a.family===4).length,ipv6:addresses.filter(a=>a.family===6).length}; }
  catch(error){return{host,dns:musicFailure(error)};}
  const started=Date.now();
  const https=await new Promise(accept=>{
    const req=request({hostname:host,path:'/',method:'HEAD',timeout:8000},response=>{accept({ok:true,status:response.statusCode,elapsedMs:Date.now()-started});response.destroy();});
    const deadline=setTimeout(()=>req.destroy(Object.assign(Error('timeout'),{code:'ETIMEDOUT'})),9000);
    req.once('close',()=>clearTimeout(deadline));
    req.on('timeout',()=>req.destroy(Object.assign(Error('timeout'),{code:'ETIMEDOUT'})));
    req.on('error',error=>accept({...musicFailure(error),elapsedMs:Date.now()-started}));req.end();
  });
  return{host,dns,https};
}
if(!isMainThread&&workerData?.role==='music-diagnostic'){
  // Isolate third-party initialization and logs from the bot and from this report.
  try {
    const temporary=mkdtempSync(resolve(tmpdir(),'tsmd-music-diagnostic-'));
    process.env.TMP=temporary;process.env.TEMP=temporary;process.env.TMPDIR=temporary;
    const require=createRequire(resolve(workerData.app,'vendor/teamspeak-music-bot-1.13.2/package.json'));
    let api=require('NeteaseCloudMusicApi');
    const version=String(require('NeteaseCloudMusicApi/package.json').version||'').replace(/[^0-9A-Za-z.+-]/g,'').slice(0,40);
    if(workerData.sessionAdapter){
      const {createNeteaseApiSession}=await import(pathToFileURL(workerData.sessionAdapter).href);
      const client=createNeteaseApiSession(api,{enabled:true});
      api=Object.fromEntries(['cloudsearch','personalized','login_qr_key','login_qr_create'].map(method=>[method,args=>client.call(method,args)]));
    }
    // Request one disposable QR key and generate its image; never poll it or log in.
    const [requests,qrLogin]=await Promise.all([probeApi(api),probeQr(api)]);
    parentPort.postMessage({apiVersion:version,requests,qrLogin});
  }catch(error){parentPort.postMessage({initialization:musicFailure(error)});}
}else if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const app=resolve(process.argv[2]||'.');
  const sessionAdapter=process.argv[3]?resolve(process.argv[3]):undefined;
  const worker=new Worker(new URL(import.meta.url),{workerData:{role:'music-diagnostic',app,sessionAdapter},stdout:true,stderr:true});
  worker.stdout.resume();worker.stderr.resume();
  const api=new Promise(accept=>{
    const timer=setTimeout(()=>accept({timedOut:true}),sessionAdapter?30000:18000);
    worker.once('message',value=>{clearTimeout(timer);accept(value);});
    worker.once('error',()=>{clearTimeout(timer);accept({workerFailed:true});});
  });
  try {
    const [network,musicApi]=await Promise.all([Promise.all(['music.163.com','interface.music.163.com'].map(networkProbe)),api]);
    let version='unknown';try{version=JSON.parse(readFileSync(resolve(app,'package.json'),'utf8')).version;}catch{}
    const candidatePassed=Boolean(sessionAdapter&&musicApi.requests?.length===4&&musicApi.requests.every(item=>item.ok)&&musicApi.qrLogin?.ok);
    console.log(JSON.stringify({kind:'TS Music Desk music request diagnostics',capturedAt:new Date().toISOString(),version,anonymousOnly:true,accountDataRead:false,sessionRepairTest:Boolean(sessionAdapter),candidatePassed,network,musicApi,rawErrorsIncluded:false},null,2));
    if(sessionAdapter&&!candidatePassed)process.exitCode=21;
  }finally{await worker.terminate();}
}
