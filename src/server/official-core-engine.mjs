import { initialServerAuth } from '../worker/server-music-session.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CoreEngine as ExistingCore } from '../worker/core-engine.mjs';
import { IsolatedMusicProvider } from '../worker/music-provider.mjs';
import { coreRoot,dataDir } from '../worker/paths.mjs';
import { allowedShareUrl } from '../shared/public-url.mjs';
import { SinusBotApi } from './sinusbot-api.mjs';
const delay=ms=>new Promise(accept=>setTimeout(accept,ms));

// Queue commands and catalog behavior stay shared. This implementation never
// instantiates the original TS protocol, Opus encoder or frame scheduler.
export class CoreEngine extends ExistingCore {
  constructor(store,vault,onChange,onDisconnect,options={}){super(store,vault,onChange,onDisconnect);this.options=options;this.revision=0;this.serial=Promise.resolve();this.remote={connected:false,state:'idle',elapsed:0};this.connected=false;this.generation=0;}
  async init(){
    if(this.options.api)this.api=this.options.api;else{const config=JSON.parse(readFileSync(resolve(dataDir,'official-transport.json'),'utf8'));config.password=this.vault.decrypt(config.password);this.api=new SinusBotApi(config);}
    this.provider=this.options.provider||new IsolatedMusicProvider();await this.provider.ready;
    const cookie=this.store.get('neteaseCookie','');if(cookie)this.provider.setCookie(this.vault.decrypt(cookie));
    this.config={audioQuality:{netease:this.store.get('quality','exhigh')}};this.provider.setQuality(this.config.audioQuality.netease);
    const {PlayQueue,normalizePlayMode}=await import(pathToFileURL(resolve(coreRoot,'dist/audio/queue.js')).href);this.queue=new PlayQueue();this.queue.setMode(normalizePlayMode(this.store.get('officialPlayMode','loop')));this.volume=this.store.get('officialVolume',35);
    this.db={saveVolume:(_id,value)=>this.store.set('officialVolume',value),savePlayMode:(_id,value)=>this.store.set('officialPlayMode',value)};
    this.pending=[];this.player={getState:()=>this.remote.paused?'paused':this.currentPlayback?'playing':'idle',resetFailures(){},pause:()=>this.enqueue('pause'),resume:()=>this.enqueue('resume'),stop:()=>{this.currentPlayback='';this.enqueue('stop');},setVolume:value=>{this.volume=value;this.enqueue('volume',{value});}};
    const bot=new EventEmitter();this.instance=bot;bot.id='official-client';bot.autoPaused=false;
    Object.assign(bot,{getQueueManager:()=>this.queue,getPlayer:()=>this.player,getStatus:()=>this.status(),isConnected:()=>this.connected,runExclusive:fn=>fn(),resolveAndPlay:song=>this.resolveAndPlay(song),playNext:()=>this.playNext(),seek:value=>this.enqueue('seek',{value}),loadSavedQueue:(songs,mode,name)=>this.loadSavedQueue(songs,mode,name)});
    bot.on('stateChange',()=>this.onChange?.());
    this.timer=setInterval(()=>{if(!this.closed&&!this.polling){this.polling=true;this.poll().catch(()=>{this.bridgeError='官方音频桥暂未响应';}).finally(()=>{this.polling=false;});}},600);this.timer.unref();
    this.auth=this.serverMusic?initialServerAuth(this,cookie):{loggedIn:false};if(cookie)this.refreshAuth().catch(()=>{});
  }
  bot(){return this.activeId?this.instance:null;}
  exclusive(fn){const task=this.serial.then(fn);this.serial=task.catch(()=>{});return task;}
  enqueue(op,args){const task=(this.controls||Promise.resolve()).then(()=>this.api.control(op,args)).then(status=>{this.apply(status);return status;});this.controls=task.catch(()=>{});task.catch(()=>{});this.pending.push(task);return task;}
  async flush(){const tasks=this.pending.splice(0);await Promise.all(tasks);}
  apply(value){if(value.boot===this.remote.boot&&Number(value.sequence)<Number(this.remote.sequence))return;this.remote=value;if(this.startedBoot&&value.boot!==this.startedBoot&&this.connected){this.connected=false;this.currentPlayback='';this.onDisconnect?.();}}
  async poll(){if(!this.activeId||!this.connected)return;const status=await this.api.control('status');this.apply(status);this.bridgeError='';
    if(!status.connected&&this.connected){this.connected=false;this.currentPlayback='';this.onDisconnect?.();return;}
    if(this.connected&&Number(status.arrivals)>this.arrivals){this.arrivals=Number(status.arrivals);this.onChange?.({channelJoin:{channelId:String(status.channelId),connectionId:this.connectionId}});}
    if(status.state==='error'&&this.currentPlayback){this.currentPlayback='';this.onChange?.({diagnostic:{level:'warn',message:'官方音频服务未能在 45 秒内开始播放，请重试或换一首歌。',time:Date.now()}});this.onChange?.();}
    const ended=this.currentPlayback&&status.endedId===this.currentPlayback;
    if(ended){const id=this.currentPlayback;await this.exclusive(async()=>{if(id===this.currentPlayback){this.currentPlayback='';await this.playNext(true);}});this.onChange?.();}
  }
  async start(preset){await this.stop();this.activeId='official-client';
    try{
      await this.api.waitReady?.();
      await this.api.instance('/settings','POST',{serverHost:preset.serverAddress,serverPort:preset.serverPort,nick:preset.nickname,serverPassword:preset.serverPassword||'',channelName:preset.defaultChannel||'',channelPassword:preset.channelPassword||''});
      await this.api.instance('/spawn','POST',{});
      const deadline=Date.now()+30000;let status;
      while(Date.now()<deadline){try{status=await this.api.control('status');if(status.connected)break;}catch{}await delay(400);}
      if(!status?.connected)throw Error('官方 TS3 客户端连接超时，请检查预设和客户端日志');
      if(preset.channelId||preset.defaultChannel){const joined=await this.api.control('join',{channelId:preset.channelId,name:preset.defaultChannel,password:preset.channelPassword||''});const target=String(joined.joinTarget||preset.channelId||'0');const end=Date.now()+10000;while(Date.now()<end){status=await this.api.control('status');if(String(status.channelId)===target)break;await delay(300);}if(String(status.channelId)!==target)throw Error('官方客户端未进入目标频道，请检查频道密码和权限；复杂路径请使用频道 ID');}
      this.connected=true;this.startedBoot=status.boot;this.connectionId=randomUUID();this.arrivals=Number(status.arrivals)||0;this.apply(status);await this.api.control('volume',{value:this.volume});this.onChange?.();return {connected:true,channelId:status.channelId,backend:'official-client-sinusbot'};
    }catch(error){await this.api.control('stop').catch(()=>{});await this.api.instance('/kill','POST',{}).catch(()=>{});this.activeId=null;this.connected=false;throw error;}
  }
  async stop(){this.generation++;const wasActive=this.activeId;await this.controls?.catch(()=>{});if(wasActive){await this.api.control('stop');await this.api.instance('/kill','POST',{});}this.currentPlayback='';this.connected=false;this.connectionId=null;this.activeId=null;this.remote={connected:false,state:'idle',elapsed:0};this.queue?.clear();this.lastTrack=null;this.revision++;}
  async resolveAndPlay(song){
    const generation=this.generation;const resolved=await this.provider.getSongUrl(song.id);if(this.closed||generation!==this.generation||!this.connected)throw Error('播放会话已结束');if(!resolved?.url)return false;
    const id=randomUUID();const status=await this.api.control('play',{url:resolved.url,playbackId:id});if(this.closed||generation!==this.generation){await this.api.control('stop').catch(()=>{});throw Error('播放会话已结束');}this.currentPlayback=id;this.effectiveDuration=resolved.trialDuration??song.duration;this.apply(status);return true;
  }
  async playNext(automatic=false){this.currentPlayback='';const next=this.queue.next(automatic);if(next){if(!await this.resolveAndPlay(next))throw Error('下一首暂时无法播放');}else this.remote={...this.remote,state:'idle',playing:false};this.observeTrack();}
  async loadSavedQueue(songs,mode,name){const tagged=songs.map(song=>({...song,requestedBy:name}));if(mode!=='append'){this.player.stop();await this.flush();this.queue.clear();}const from=this.queue.size(),idle=this.player.getState()==='idle';this.queue.addMany(tagged);if(idle&&tagged.length){const song=this.queue.playAt(from);if(!await this.resolveAndPlay(song))throw Error('歌单首曲暂时无法播放');}}
  async command(...args){return this.exclusive(async()=>{const result=await super.command(...args);await this.flush();return {...result,...this.status()};});}
  status({includeQueue=true}={}){this.observeTrack();const clean=song=>{if(!song)return null;if(!song.entryId)song.entryId=randomUUID();const keys=['entryId','id','name','artist','artists','popularity','album','coverUrl','duration','vip','requestedBy'];return Object.fromEntries(keys.filter(key=>song[key]!==undefined).map(key=>[key,song[key]]));};return {connected:this.connected,playing:this.connected&&Boolean(this.currentPlayback)&&!this.remote.paused,paused:Boolean(this.remote.paused),volume:this.volume??35,playMode:this.queue?.getMode()||'loop',elapsed:Number(this.remote.elapsed)||0,currentSong:clean(this.queue?.current()),effectiveDuration:this.effectiveDuration,queueSize:this.queue?.size()||0,revision:this.revision,channelId:String(this.remote.channelId||'0'),backend:'official-client-sinusbot',...(includeQueue?{queue:this.queue?.list().map(clean)||[]}:{})};}
  health(){return {supported:false,backend:'official-client-sinusbot',officialClient:true,state:this.remote.state||'idle',bridgeStatus:this.bridgeError?'unavailable':'ok',deliveryVerified:false,tsConnectionStatistics:'unsupported',note:'编码、音频缓冲和 UDP 发送由独立的官方 TS3 客户端处理；原内核帧诊断不适用。'};}
  announcementTarget(){return this.connected&&this.connectionId?{channelId:String(this.remote.channelId),connectionId:this.connectionId}:null;}
  async sendShareAnnouncement({channelId,connectionId,url}){if(!this.connected||connectionId!==this.connectionId||String(channelId)!==String(this.remote.channelId))return false;if(!allowedShareUrl(url))throw Error('分享地址无效');await this.api.control('chat',{channelId:String(channelId),text:`音乐控制台：[URL=${url}]点此打开网页点歌 / 切歌[/URL]`});return true;}
  async channels(){throw Error('官方客户端模式暂不读取频道列表，请使用预设频道 ID');}
  async removeBot(){return true;}
  async close(){this.closed=true;clearInterval(this.timer);try{await this.stop();}finally{await this.provider?.close();this.audioHealth.close();this.audioClock.close();}}
}
