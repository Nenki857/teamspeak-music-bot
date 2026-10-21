import {readFile,writeFile,mkdir,rename,readdir,stat,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {normalizeLyrics} from '../shared/lyrics.mjs';
const DAY=86400000;
export class LyricsCache {
  constructor({directory,load,now=Date.now,maxEntries=200}={}) {
    Object.assign(this,{directory,load,now,maxEntries});this.memory=new Map();this.inflight=new Map();this.failures=new Map();this.writes=Promise.resolve();
  }
  remember(id,value) {this.memory.delete(id);this.memory.set(id,value);if(this.memory.size>32)this.memory.delete(this.memory.keys().next().value);return value.lines;}
  valid(value,id) {return value?.version===1 && value.id===id && Number.isFinite(value.at) && value.at<=this.now()+60000 && this.now()-value.at<(value.lines?.length?30*DAY:DAY);}
  async get(input) {
    const id=String(input);if(!/^\d{1,20}$/.test(id))throw new Error('歌曲 ID 无效');
    const cached=this.memory.get(id);if(this.valid(cached,id))return this.remember(id,cached);
    if(this.inflight.has(id))return this.inflight.get(id);
    const failure=this.failures.get(id);if(failure&&failure.until>this.now())throw failure.error;
    const promise=this.readOrLoad(id).catch(error=>{this.failures.delete(id);this.failures.set(id,{until:this.now()+60000,error});if(this.failures.size>32)this.failures.delete(this.failures.keys().next().value);throw error;});
    this.inflight.set(id,promise);
    try{return await promise;}finally{if(this.inflight.get(id)===promise)this.inflight.delete(id);}
  }
  async readOrLoad(id) {
    if(this.directory)try {
      const file=join(this.directory,id+'.json');const info=await stat(file);
      if(info.size<=262144){const value=JSON.parse(await readFile(file,'utf8'));if(this.valid(value,id)){value.lines=normalizeLyrics(value.lines);return this.remember(id,value);}}
    }catch{}
    const lines=normalizeLyrics(await this.load(id));const value={version:1,id,at:this.now(),lines};this.remember(id,value);this.failures.delete(id);
    if(this.directory){this.writes=this.writes.then(()=>this.persist(id,value)).catch(()=>{});await this.writes;}
    return lines;
  }
  async persist(id,value) {
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const file=join(this.directory,id+'.json'),temporary=file+'.'+randomUUID()+'.tmp';
    try{await writeFile(temporary,JSON.stringify(value),{mode:0o600});await rename(temporary,file);}finally{await unlink(temporary).catch(()=>{});}
    const files=await readdir(this.directory);const entries=await Promise.all(files.filter(name=>/^\d{1,20}\.json$/.test(name)).map(async name=>({name,at:(await stat(join(this.directory,name))).mtimeMs})));
    entries.sort((a,b)=>b.at-a.at);
    for(const item of entries.slice(this.maxEntries))await unlink(join(this.directory,item.name)).catch(()=>{});
  }
}
