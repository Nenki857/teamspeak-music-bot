// Opt-in compatibility with the API library's existing web request protocol.
// Do not alter account cookies, request destinations, IP headers or audio transport.
const WEB_METHODS = new Set(['cloudsearch', 'search', 'personalized', 'playlist_detail', 'playlist_track_all',
  'album', 'song_detail', 'song_url_v1', 'lyric', 'artist_detail', 'artist_songs', 'user_playlist',
  'login_qr_key', 'login_qr_check']);
export function neteaseWebRequest(method, args, enabled = false) {
  return enabled && WEB_METHODS.has(method) && !args.crypto ? { ...args, crypto: 'weapi' } : args;
}
