import { musicRequestError } from './music-request-error.mjs';
import { musicErrorCode } from './music-request-gate.mjs';
export const isServerMusic = (env = process.env) => env.TSMD_SERVER_EDITION === '1';
const configured = Symbol('serverMusicErrors');
export function configureServerMusicBot(bot) {
  if (bot[configured]) return;
  const resolve = bot.resolveAndPlay.bind(bot);
  bot.resolveAndPlay = song => resolve(song, { propagateErrors: true });
  bot[configured] = true;
}

const profile = auth => ({ loggedIn: true, nickname: String(auth.nickname || '').slice(0,160), avatarUrl: String(auth.avatarUrl || '').slice(0,2048) });
export function initialServerAuth(core, cookie) {
  const saved = cookie && core.store.get('neteaseAuthProfile', null);
  return { ...(saved?.loggedIn ? profile(saved) : { loggedIn: false }), hasSession: !!cookie, checking: !!cookie };
}
export function rememberServerAuth(core, auth) {
  if (!core.serverMusic) return;
  core.store.set('neteaseAuthProfile', auth.loggedIn ? profile(auth) : null);
  core.onChange?.({ diagnostic: { kind: 'music-session', type: auth.loggedIn ? 'auth-login-saved' : 'auth-logged-out', level: 'info', message: auth.loggedIn ? '网易云登录会话已保存' : '已退出网易云登录', time: Date.now() } });
}
export async function refreshServerAuth(core) {
  const epoch = core.authEpoch;
  try {
    const auth = await core.provider.getAuthStatus();
    if (epoch === core.authEpoch) {
      core.auth = { ...auth, hasSession: !!core.provider.getCookie(), checking: false, checkFailed: false };
      core.store.set('neteaseAuthProfile', auth.loggedIn ? profile(auth) : null);
      core.onChange?.({ diagnostic: { kind: 'music-session', type: 'auth-check-ok', level: 'info', message: auth.loggedIn ? '网易云登录状态检查通过' : '网易云未返回已登录资料', time: Date.now() } });
      core.onChange?.();
    }
    return core.auth;
  } catch (error) {
    if (epoch === core.authEpoch) {
      const invalid = [301,401].includes(musicErrorCode(error));
      const message = musicRequestError(error).message;
      core.auth = { ...(invalid ? { loggedIn: false } : core.auth || { loggedIn: false }), hasSession: !!core.provider.getCookie(), checking: false, checkFailed: !invalid, sessionInvalid: invalid, checkError: message };
      core.onChange?.({ diagnostic: { kind: 'music-session', type: 'auth-check-failed', code: musicErrorCode(error), level: 'warn', message: invalid ? message : '网易云登录检查未完成，已保留登录会话：' + message, time: Date.now() } });
      core.onChange?.();
    }
    throw error;
  }
}
