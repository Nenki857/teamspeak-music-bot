import { imageMetadataUrl, songMetadata } from '../shared/playlist-format.mjs';
const idOf = input => { const id=String(input); if(!/^\d{1,20}$/.test(id)) throw new Error('网易云 ID 无效'); return id; };
const albumMetadata = raw => ({ id:idOf(raw.id), name:String(raw.name || '未命名专辑').slice(0,160), coverUrl:imageMetadataUrl(raw.picUrl), songCount:Math.max(0,Math.min(10000,Number(raw.size ?? raw.songCount)||0)), artist:String(raw.artist?.name || raw.artists?.map(a=>a.name).join(' / ') || '').slice(0,300), publishTime:Number.isFinite(raw.publishTime)?Math.max(0,Math.min(8640000000000000,raw.publishTime)):0 });
export async function artistAlbums(provider,input,offset=0) {
  const id=idOf(input);if(!Number.isInteger(offset)||offset<0||offset>270)throw new Error('专辑页码无效');
  const result=await provider.api.get('/artist/album',{params:{id,limit:30,offset,...(provider.getCookie()?{cookie:provider.getCookie()}:{})}});
  const body=result.data || {};if(body.artist?.id!==undefined&&String(body.artist.id)!==id)throw new Error('歌手专辑返回内容不匹配');const raw=body.hotAlbums ?? body.albums;
  if(!Array.isArray(raw))throw new Error('专辑列表响应无效');
  const albums=raw.slice(0,30).filter(a=>a && /^\d{1,20}$/.test(String(a.id))).map(albumMetadata);
  return { artist:{id}, albums, offset, more:offset+30<300&&(body.more===undefined?raw.length===30:!!body.more) };
}
export async function albumPage(provider,input,mapSongs) {
  const id=idOf(input);const result=await provider.api.get('/album',{params:{id,...(provider.getCookie()?{cookie:provider.getCookie()}:{})}});
  const body=result.data || {};if(!body.album || String(body.album.id)!==id || !Array.isArray(body.songs))throw new Error('专辑不存在或返回内容不匹配');
  return {...albumMetadata(body.album), songs:mapSongs(body.songs).slice(0,500).map(songMetadata)};
}
