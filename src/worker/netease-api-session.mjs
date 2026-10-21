// Opt-in server repair: use the upstream library's normal anonymous session API.
// Owner cookies are never replaced or mixed with the anonymous cookie.
export function createNeteaseApiSession(api, { enabled = false, now = Date.now, timeoutMs = 12000 } = {}) {
  let cookie = '', expiresAt = 0, pending, failedUntil = 0, lastFailure;
  async function invoke(method, args) {
    if (typeof api[method] !== 'function') throw Error('音乐接口不可用');
    let timer;
    try { return await Promise.race([Promise.resolve().then(() => api[method](args)), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('音乐服务响应超时'), { code: 'ETIMEDOUT' })), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  async function anonymousCookie() {
    if (cookie && expiresAt > now()) return cookie;
    if (pending) return pending;
    if (failedUntil > now()) throw lastFailure;
    pending = (async () => {
      try {
        const result = await invoke('register_anonimous', {});
        if (result?.status !== 200 || result?.body?.code !== 200) throw result;
        const value = result.body.cookie || (Array.isArray(result.cookie) ? result.cookie.join(';') : '');
        if (typeof value !== 'string' || !/(?:^|;\s*)MUSIC_A=([^;\s]+)/.test(value) || value.length > 65536) throw Error('网易云游客会话初始化失败');
        cookie = value; expiresAt = now() + 6 * 60 * 60 * 1000;
        return cookie;
      } catch (error) { lastFailure = error; failedUntil = now() + 60000; throw error; }
      finally { pending = null; }
    })();
    return pending;
  }
  return {
    async call(method, args = {}) {
      if (!enabled) {
        if (typeof api[method] !== 'function') throw Error('音乐接口不可用');
        return api[method](args);
      }
      if (args.cookie || method === 'register_anonimous' || method === 'login_qr_create') return invoke(method, args);
      return invoke(method, { ...args, cookie: await anonymousCookie() });
    }
  };
}
