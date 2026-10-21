import {appendFileSync} from 'node:fs';
const call=method=>{if(process.env.TSMD_TEST_ARTIST_TRACE)appendFileSync(process.env.TSMD_TEST_ARTIST_TRACE,method+'\n');};
export default {
  async song_detail(){call('song_detail');throw {status:400,body:{code:-462}};},
  async artist_detail(){call('artist_detail');throw {status:400,body:{code:-462,msg:'PRIVATE_COOKIE'}};},
  async artist_songs({id,order,offset=0,limit=30}){call('artist_songs');if(String(id)==='462')throw {status:400,body:{code:-462}};return {status:200,body:{code:200,songs:Array.from({length:limit},(_,i)=>({id:String(Number(id)*1000+offset+i+(order==='time'?100:0)),name:'Song '+id,ar:[{id,name:'Artist '+id}],al:{name:'Album'},dt:180000})),more:offset+limit<500}};},
  async song_url_v1(){call('song_url_v1');return {status:200,body:{code:200,data:[{url:null}]}};}
};
