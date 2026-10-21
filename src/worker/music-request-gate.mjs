const RESTRICTED = new Set([-462, -460, 429]);
const PLAYBACK = new Set(['song_url_v1', 'song_detail']);
export const musicErrorCode = error => {
  for (const value of [error?.neteaseCode, error?.body?.code, error?.response?.data?.code, error?.status, error?.response?.status]) {
    if (value !== undefined && value !== null && Number.isFinite(Number(value))) return Number(value);
  }
};
export const isMusicRestriction = error => RESTRICTED.has(musicErrorCode(error));
const failure = (message, code, status = 400) => Object.assign(new Error(message), { neteaseCode: code, status });
export function createMusicRequestGate({ now = Date.now, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), spacingMs = 500, cooldownMs = 60000, maxPending = 24, log = () => {} } = {}) {
  const queue = []; let active = false, nextStart = 0, blockedUntil = 0, blockedCode;
  const emit = entry => { try { log(entry); } catch {} };
  const blocked = () => Object.assign(failure('网易云请求暂时受限，请稍后再试', blockedCode), { localCooldown: true, retryAfterMs: Math.max(0, blockedUntil - now()) });
  async function drain() {
    if (active) return; active = true;
    try {
      while (queue.length) {
        if (blockedUntil > now()) { for (const item of queue.splice(0)) item.reject(blocked()); break; }
        if (nextStart > now()) await wait(nextStart - now());
        const priority = queue.findIndex(item => PLAYBACK.has(item.method));
        const item = queue.splice(priority < 0 ? 0 : priority, 1)[0];
        if (now() >= item.deadline) { emit({ type: 'queue-expired', method: item.method }); item.reject(new Error('音乐请求排队超时，请稍后重试')); continue; }
        const started = now(); nextStart = started + spacingMs;
        emit({ type: 'request-start', method: item.method, pending: queue.length });
        try {
          const result = await item.run();
          emit({ type: 'request-ok', method: item.method, code: Number(result?.body?.code), elapsedMs: now() - started }); item.accept(result);
        } catch (error) {
          const code = musicErrorCode(error);
          emit({ type: 'request-failed', method: item.method, code, httpStatus: Number(error?.status || error?.response?.status), elapsedMs: now() - started });
          if (RESTRICTED.has(code)) { blockedCode = code; blockedUntil = now() + cooldownMs; emit({ type: 'cooldown-start', method: item.method, code, retryAfterMs: cooldownMs }); }
          item.reject(error);
        }
      }
    } finally { active = false; }
  }
  return {
    run(method, run, { deadline = now() + 20000 } = {}) {
      if (blockedUntil > now()) { emit({ type: 'cooldown-blocked', method, code: blockedCode, retryAfterMs: Math.max(0, blockedUntil - now()) }); return Promise.reject(blocked()); }
      if (queue.length >= maxPending) return Promise.reject(new Error('音乐请求较多，请稍后重试'));
      const promise = new Promise((accept, reject) => queue.push({ method, run, deadline, accept, reject }));
      void drain(); return promise;
    },
    state: () => ({ pending: queue.length, active, retryAfterMs: Math.max(0, blockedUntil - now()) })
  };
}
