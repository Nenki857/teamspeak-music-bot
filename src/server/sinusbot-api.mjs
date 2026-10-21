export class SinusBotApi {
  constructor(config,{fetcher=fetch,timeoutMs=12000}={}){
    const base=new URL(config.url||'http://127.0.0.1:18087');
    if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw Error('音频桥必须使用本机 127.0.0.1 地址');
    Object.assign(this,{config,base:base.origin,fetcher,timeoutMs});this.token='';
  }
  async request(path,method='GET',input,auth=true,retry=true){
    if(auth&&!this.token)await this.login();
    let response;try{response=await this.fetcher(this.base+'/api/v1'+path,{method,headers:{'Content-Type':'application/json',...(auth?{Authorization:'bearer '+this.token}:{})},...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(this.timeoutMs),redirect:'error'});}catch{throw Error('官方客户端音频桥未响应，请检查 ts-music-desk-official 服务');}
    if(response.status===401&&auth&&retry){this.token='';await this.login();return this.request(path,method,input,true,false);}
    if(!response.ok)throw Error(`官方客户端音频桥请求失败（${response.status}）`);
    let data;try{data=await response.json();}catch{throw Error('音频桥响应格式无效');}
    if(data?.success===false||data?.ok===false)throw Error('音频桥拒绝了操作，请检查实例、音源或频道权限');return data;
  }
  async login(){if(this.loggingIn)return this.loggingIn;this.loggingIn=(async()=>{const bot=await this.request('/botId','GET',undefined,false);const result=await this.request('/bot/login','POST',{username:this.config.username||'admin',password:this.config.password,botId:bot.defaultBotId},false);if(typeof result.token!=='string'||!result.token)throw Error('音频桥登录失败');this.token=result.token;})();try{await this.loggingIn;}finally{this.loggingIn=null;}}
  async waitReady(milliseconds=10000){const end=Date.now()+milliseconds;while(true){try{await this.request('/botId','GET',undefined,false);return;}catch{if(Date.now()>=end)throw Error('官方音频服务尚未就绪，请检查其启动日志');await new Promise(accept=>setTimeout(accept,300));}}}
  instance(path,method='POST',data){if(!/^[a-zA-Z0-9-]{1,80}$/.test(this.config.instanceId||''))throw Error('请先配置音频桥实例');return this.request('/bot/i/'+this.config.instanceId+path,method,data);}
  async control(op,data={}){const response=await this.instance('/event/tsmd','POST',{op,...data});const reply=Array.isArray(response)?response.find(item=>item?.result?.bridgeVersion===1):response;const value=reply?.result;if(reply?.ok!==true||value?.bridgeVersion!==1)throw Error('缺少 TS Music Bot 音频桥脚本，请更新音频服务');return value;}
}
