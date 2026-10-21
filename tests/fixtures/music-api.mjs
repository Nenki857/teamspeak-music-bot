import { performance } from 'node:perf_hooks';
let lists = 0;
const burn = ms => { const end = performance.now() + ms; while (performance.now() < end) Math.sqrt(Math.random()); };
const response = body => ({ status: 200, body });
const song = id => ({ id, name: 'Song ' + id, ar: [{ id: 99, name: 'Artist' }], pop: Number(id) % 101, al: { name: 'Album', picUrl: 'http://p5.music.126.net/fixture-cover.png' }, dt: 180000 });
export default {
  async lyric({id}) {return response({lrc:{lyric:'[00:00.00]First '+id+'\n[00:04.50]Second'},tlyric:{lyric:'[00:00.00]第一句'}});},
  async artist_album({id,offset=0,limit=30}) { return response({artist:{id},hotAlbums:Array.from({length:limit},(_,i)=>({id:Number(id)*1000+offset+i,name:'Album '+id+'-'+(offset+i),picUrl:'https://p1.music.126.net/album.jpg',size:2,artist:{id,name:'Artist '+id},publishTime:1000000000000})),more:offset===0}); },
  async album({id}) { return response({album:{id,name:'Album '+id,picUrl:'https://p1.music.126.net/album.jpg',size:2,artist:{name:'Artist'},secret:'PRIVATE'},songs:[song(Number(id)*10),song(Number(id)*10+1)]}); },
  async artist_detail({ id }) { return response({ data: { artist: { id, name: 'Artist ' + id, cover: 'https://p5.music.126.net/artist.jpg', briefDesc: 'Fixture biography', musicSize: 530 } } }); },
  async artist_songs({ order, limit, offset }) { return response({ songs: Array.from({ length: limit }, (_, i) => song((order === 'time' ? 1000 : 1) + offset + i)), more: offset + limit < 530 }); },
  async login_status({ cookie }) { return response({ data: { profile: { userId: 1, nickname: cookie || 'Guest' } } }); },
  async user_detail({ uid, cookie }) { if (cookie) throw new Error('public endpoint received owner cookie'); return response({ profile: { userId: uid, nickname: 'Public ' + uid, avatarUrl: 'http://p5.music.126.net/user.jpg', phone: 'must-not-forward' } }); },
  async search({ type, cookie }) { if (cookie || type !== 1002) throw new Error('public search params invalid'); return response({ result: { userprofiles: [{ userId: 42, nickname: 'Public user', avatarUrl: 'http://p5.music.126.net/user.jpg', phone: 'must-not-forward' }], userprofileCount: 1 } }); },
  async user_playlist({ cookie, uid }) { lists++; return response({ playlist: cookie ? [{ id: 1, name: `${cookie}:${lists}`, trackCount: 500, coverImgUrl: '' }] : [{ id: 7, name: 'Public playlist ' + uid, trackCount: 3, privacy: 0, creator: { nickname: 'Public user' } }, { id: 8, privacy: 10, name: 'Private playlist' }], more: false }); },
  async playlist_detail({ id }) { return response({ playlist: { id, name: 'Playlist', trackCount: String(id) === '7' ? 3 : 500, privacy: id === '8' ? 10 : 0 } }); },
  async playlist_track_all({ id, limit }) { return response({ songs: Array.from({ length: String(id) === '7' ? 3 : limit }, (_, i) => song(i + 1)) }); },
  async personalized() { return response({ result: [] }); },
  async song_url_v1({ level }) { return response({ data: [{ url: `https://example.invalid/${level}.mp3` }] }); },
  async song_detail({ ids }) { return response({ songs: String(ids || '1').split(',').map(id => song(Number(id))) }); },
  async cloudsearch({ keywords, type }) {
    if (keywords === 'slow-catalog') await new Promise(resolve => setTimeout(resolve, 150));
    if (keywords.startsWith('cpu-stress')) burn(180);
    if (keywords === 'denied') throw { status: 403, message: 'cookie=do-not-forward https://private.invalid/token' };
    return response({ result: type === 1 ? { songs: Array.from({ length: 30 }, (_, i) => song(i)) } : type === 1000 ? { playlists: [] } : { albums: [] } });
  },
  async login_qr_key() { return response({ data: { unikey: 'fixture-key' } }); },
  async login_qr_create() { return response({ data: { qrurl: 'https://example.invalid/qr' } }); },
  async login_qr_check({ key }) { if (key === 'slow') await new Promise(resolve => setTimeout(resolve, 100)); return response({ code: 803, cookie: 'fixture-confirmed' }); }
};
