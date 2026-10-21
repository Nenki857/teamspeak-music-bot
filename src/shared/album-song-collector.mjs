// Read a bounded batch, preserving album track order and only deduplicating
// repeated IDs inside each album. Cross-album appearances remain visible.
export async function collectAlbumSongBatch(state,{readAlbum,readPage,onProgress=()=>{},isCurrent=()=>true,maxAlbums=3,targetSongs=50,maxSongs=500}={}) {
  let albumsRead=0,pagesRead=0;const startCount=state.trackCount;
  while(isCurrent() && albumsRead<maxAlbums && state.trackCount<maxSongs && state.trackCount-startCount<targetSongs) {
    if(state.cursor>=state.albums.length) {
      if(!state.more || pagesRead>=1)break;
      const offset=state.offset+30;const page=await readPage(offset);if(!isCurrent())return;
      const seen=new Set(state.albums.map(a=>String(a.id)));for(const album of page.albums)if(!seen.has(String(album.id))){state.albums.push(album);seen.add(String(album.id));}
      state.offset=offset;state.more=!!page.more;pagesRead++;onProgress();
      if(state.cursor>=state.albums.length)break;
    }
    const album=state.albums[state.cursor];const result=await readAlbum(album.id);if(!isCurrent())return;
    if(String(result.id)!==String(album.id)||!Array.isArray(result.songs))throw Error('专辑内容不匹配');
    const seen=new Set();const songs=result.songs.filter(song=>{const id=String(song.id);if(seen.has(id))return false;seen.add(id);return true;});
    const remaining=maxSongs-state.trackCount;const shown=songs.slice(0,remaining);
    state.groups.push({album:{...album,...result,publishTime:result.publishTime||album.publishTime,coverUrl:result.coverUrl||album.coverUrl,songs:undefined},songs:shown,truncated:shown.length<songs.length});
    state.trackCount+=shown.length;state.cursor++;albumsRead++;onProgress();
  }
}
export function sortAlbumSongGroups(groups,sort='time') {
  const heat=song=>Number.isFinite(song.popularity)?song.popularity:-1;
  const score=group=>group.songs.reduce((best,song)=>Math.max(best,heat(song)),-1);
  return groups.map(group=>({...group,songs:sort==='popular'?[...group.songs].sort((a,b)=>heat(b)-heat(a)):group.songs})).sort((a,b)=>sort==='popular'?score(b)-score(a):(Number(b.album.publishTime)||0)-(Number(a.album.publishTime)||0));
}
