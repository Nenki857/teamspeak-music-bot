// TS Music Desk bridge. SinusBot script API; no public: handlers are registered.
registerPlugin({name:'TS Music Desk transport',version:'1.0.0',description:'Private official TS3-client transport for TS Music Desk',author:'TS Music Desk',autorun:true,backends:['ts3'],requiredModules:['backend','media','audio','event']},function(){
  var backend=require('backend'),media=require('media'),audio=require('audio'),event=require('event');
  var mode='idle',url='',playbackId='',endedId='',position=0,pendingSeek=0,arrivals=0,joinTarget='';
  var boot=String(Date.now())+'-'+String(Math.random()),sequence=0,startedAt=0;
  function snapshot(){if(mode==='starting'&&Date.now()-startedAt>45000)mode='error';var channel=backend.getCurrentChannel();return {bridgeVersion:1,sequence:++sequence,boot:boot,connected:backend.isConnected(),channelId:channel?String(channel.id()):'0',joinTarget:joinTarget,playing:mode==='playing'&&audio.isPlaying(),paused:mode==='paused',state:mode,playbackId:playbackId,endedId:endedId,elapsed:mode==='paused'?position:Number(audio.getTrackPosition())||0,volume:audio.getVolume(),arrivals:arrivals};}
  function start(){mode='starting';startedAt=Date.now();media.clearQueue();audio.setRepeat(false);audio.setShuffle(false);media.stop();if(!media.playURL(url)){mode='idle';throw new Error('无法开始音频流');}}
  event.on('track',function(){if(mode==='starting'){if(pendingSeek>0)audio.seek(pendingSeek);pendingSeek=0;mode='playing';}});
  event.on('trackEnd',function(){if(mode==='playing'&&!audio.isPlaying()){endedId=playbackId;mode='idle';}});
  event.on('clientMove',function(info){var here=backend.getCurrentChannel();if(here&&info.client&&!info.client.isSelf()&&info.toChannel&&String(info.toChannel.id())===String(here.id()))arrivals++;});
  event.on('api:tsmd',function(ev){
    try{var data=ev.data()||{},op=data.op;
      if(op==='status')return {ok:true,result:snapshot()};
      if(op==='play'){if(typeof data.url!=='string'||!/^https?:\/\//i.test(data.url)||typeof data.playbackId!=='string')throw new Error('无效播放请求');url=data.url;playbackId=data.playbackId;endedId='';position=0;pendingSeek=0;start();}
      else if(op==='pause'){if(mode==='playing'||mode==='starting'){position=Number(audio.getTrackPosition())||0;mode='paused';media.stop();}}
      else if(op==='resume'){if(mode==='paused'&&url){pendingSeek=position;start();}}
      else if(op==='seek'){var value=Number(data.value);if(!isFinite(value)||value<0)throw new Error('进度无效');if(mode==='paused')position=value;else if(mode==='starting')pendingSeek=value;else audio.seek(value);}
      else if(op==='volume'){var volume=Number(data.value);if(!isFinite(volume)||volume<0||volume>100)throw new Error('音量无效');audio.setVolume(volume);}
      else if(op==='stop'){mode='idle';url='';playbackId='';endedId='';position=0;pendingSeek=0;media.clearQueue();media.stop();}
      else if(op==='join'){var channel;if(data.channelId)channel=backend.getChannelByID(String(data.channelId));else{var found=backend.getChannelsByName(String(data.name||''));if(found.length===1)channel=found[0];}if(!channel)throw new Error('目标频道不可用或名称不唯一，请使用频道 ID');joinTarget=String(channel.id());backend.getBotClient().moveTo(channel,String(data.password||''));}
      else if(op==='chat'){var current=backend.getCurrentChannel();if(!current||String(current.id())!==String(data.channelId)||typeof data.text!=='string'||data.text.length>1200)throw new Error('频道已变化');if(!current.chat(data.text))throw new Error('频道消息发送失败');}
      else throw new Error('操作无效');
      return {ok:true,result:snapshot()};
    }catch(error){return {ok:false,error:'官方客户端音频桥操作失败，请检查连接、音源或频道权限'};}
  });
});
