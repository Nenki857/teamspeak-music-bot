import {readFile} from 'node:fs/promises';
const finite=value=>Number.isFinite(value)&&value>=0;
function cpuCounters(text){
 const lines=text.trim().split('\n'),line=lines.find(row=>/^cpu\s/.test(row));if(!line)throw Error('No CPU counters');
 const values=line.trim().split(/\s+/).slice(1,9).map(Number);if(values.length<4||!values.every(finite))throw Error('Invalid CPU counters');
 return{total:values.reduce((a,b)=>a+b,0),idle:values[3]+(values[4]||0),cores:Math.max(1,lines.filter(row=>/^cpu\d+\s/.test(row)).length)};
}
function memoryCounters(text){
 const values=new Map();for(const line of text.split('\n')){const match=line.match(/^([A-Za-z_]+):\s+(\d+)\s+kB/);if(match)values.set(match[1],Number(match[2])*1024);}
 const total=values.get('MemTotal');let available=values.get('MemAvailable');
 if(!finite(available)&&values.has('MemFree'))available=values.get('MemFree')+(values.get('Buffers')||0)+(values.get('Cached')||0)+(values.get('SReclaimable')||0)-(values.get('Shmem')||0);
 if(!finite(total)||total<=0||!finite(available))throw Error('No memory counters');available=Math.min(total,available);const bytes=total-available;
 return{bytes,totalBytes:total,availableBytes:available,percent:bytes/total*100,status:'ok'};
}
function networkCounters(text){
 const rows=new Map();for(const line of text.split('\n').slice(2)){const match=line.trim().match(/^([^:]+):\s*(.*)$/);if(!match||match[1]==='lo'||/^(docker|veth|br-|tun|tap)/.test(match[1]))continue;const values=match[2].trim().split(/\s+/);if(!/^\d+$/.test(values[0])||!/^\d+$/.test(values[8]))continue;rows.set(match[1],{received:BigInt(values[0]),sent:BigInt(values[8])});}return rows;
}
export function createLinuxHostMonitor({proc='/proc',read=readFile,now=Date.now}={}){
 let previous,cached,pending;
 async function collect(){
  const at=now();if(cached&&at-cached.sampledAt>=0&&at-cached.sampledAt<2000)return cached;
  const reads=await Promise.allSettled(['stat','meminfo','loadavg','net/dev'].map(name=>read(proc+'/'+name,'utf8')));
  const interval=previous?at-previous.at:0,continuous=interval>=1000&&interval<=10000;let cpu,adapters;
  const result={scope:'server-host',sampledAt:at,intervalMs:interval,cpu:{percent:null,status:'unavailable',cores:null},memory:{bytes:null,totalBytes:null,percent:null,status:'unavailable'},load:{one:null,five:null,fifteen:null,status:'unavailable'},network:{scope:'server-total',receivedPerSecond:null,sentPerSecond:null,status:'unavailable',adapters:0}};
  try{cpu=cpuCounters(reads[0].value);const before=continuous&&previous.cpu,delta=before?cpu.total-before.total:0,idle=before?cpu.idle-before.idle:0;const ready=delta>0&&idle>=0&&idle<=delta;result.cpu={percent:ready?Math.max(0,Math.min(100,(1-idle/delta)*100)):null,status:ready?'ok':'warming',cores:cpu.cores};}catch{}
  try{result.memory=memoryCounters(reads[1].value);}catch{}
  try{const values=reads[2].value.trim().split(/\s+/).slice(0,3).map(Number);if(values.length!==3||!values.every(finite))throw Error('No load');result.load={one:values[0],five:values[1],fifteen:values[2],status:'ok'};}catch{}
  try{adapters=networkCounters(reads[3].value);let received=0n,sent=0n,compared=0;for(const [name,row] of adapters){const before=continuous&&previous.adapters?.get(name);if(before&&row.received>=before.received&&row.sent>=before.sent){received+=row.received-before.received;sent+=row.sent-before.sent;compared++;}}result.network={scope:'server-total',status:compared?'ok':adapters.size?'warming':'disconnected',receivedPerSecond:compared?Number(received)/interval*1000:null,sentPerSecond:compared?Number(sent)/interval*1000:null,adapters:adapters.size};}catch{}
  previous={at,cpu,adapters};cached=result;return result;
 }
 return{sample(){if(!pending)pending=collect().finally(()=>{pending=null;});return pending;}};
}
