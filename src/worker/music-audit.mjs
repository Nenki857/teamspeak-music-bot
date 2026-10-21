import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
const METHODS = new Set(['cloudsearch','search','personalized','playlist_detail','playlist_track_all','album','song_detail','song_url_v1','lyric','artist_detail','artist_songs','user_playlist','user_detail','login_qr_key','login_qr_create','login_qr_check','login_status','personal_fm','recommend_songs']);
const TYPES = new Set(['request-start','request-ok','request-failed','queue-expired','cooldown-start','cooldown-blocked','auth-check-ok','auth-check-failed','auth-logged-out','auth-login-saved']);
export function createMusicAudit(file, { maxBytes = 1024 * 1024, now = Date.now } = {}) {
  return entry => {
    if (!TYPES.has(entry?.type)) return;
    const safe = { time: new Date(now()).toISOString(), type: entry.type };
    if (METHODS.has(entry.method)) safe.method = entry.method;
    for (const key of ['code','httpStatus','elapsedMs','pending','retryAfterMs']) if (Number.isFinite(entry[key]) && Math.abs(entry[key]) < 1e9) safe[key] = Math.round(entry[key]);
    if (['web-session','legacy-api'].includes(entry.transport)) safe.transport = entry.transport;
    try {
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file) && statSync(file).size >= maxBytes) { if (existsSync(file + '.1')) unlinkSync(file + '.1'); renameSync(file, file + '.1'); }
      appendFileSync(file, JSON.stringify(safe) + '\n', { mode: 0o600 });
    } catch { /* Diagnostics must not interrupt playback or account operations. */ }
  };
}
