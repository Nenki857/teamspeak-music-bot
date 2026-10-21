import { createHash } from 'node:crypto';

const ORIGIN = 'https://music.163.com';
const WEB_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const METHODS = ['cloudsearch', 'search', 'personalized', 'playlist_detail', 'playlist_track_all', 'album',
  'song_detail', 'song_url_v1', 'lyric', 'artist_detail', 'artist_songs', 'artist_album', 'user_playlist', 'user_detail',
  'login_qr_key', 'login_qr_create', 'login_qr_check', 'login_status', 'personal_fm', 'recommend_songs'];
const OK = new Set([200, 201, 800, 801, 802, 803]);

function pair(text) {
  const at = text.indexOf('=');
  if (at < 1) return null;
  const name = text.slice(0, at).trim(), value = text.slice(at + 1).trim();
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name) && !/[\x00-\x20\x7f-\uffff;]/.test(value) ? [name, value] : null;
}

export function browserCookieJar(initial = '', now = Date.now) {
  if (typeof initial !== 'string' || initial.length > 65536 || /[\r\n]/.test(initial)) throw Error('Invalid web session');
  const values = new Map();
  for (const field of initial.split(';')) { const item = pair(field); if (item) values.set(item[0] + '\n/', { name: item[0], value: item[1], path: '/', expires: Infinity }); }
  return {
    receive(headers) {
      for (const header of headers || []) {
        if (typeof header !== 'string' || header.length > 8192 || /[\r\n]/.test(header)) continue;
        const [first, ...parts] = header.split(';'), item = pair(first); if (!item) continue;
        const attributes = new Map(parts.map(part => { const at = part.indexOf('='); return [part.slice(0, at < 0 ? part.length : at).trim().toLowerCase(), at < 0 ? '' : part.slice(at + 1).trim()]; }));
        const domain = attributes.get('domain')?.replace(/^\./, '').toLowerCase();
        if (domain && domain !== 'music.163.com') continue;
        const path = attributes.get('path') || '/'; if (!path.startsWith('/') || path.includes('\n')) continue;
        const age = attributes.get('max-age');
        const expires = age !== undefined && /^-?\d+$/.test(age) ? now() + Number(age) * 1000 : attributes.has('expires') ? Date.parse(attributes.get('expires')) : Infinity;
        const key = item[0] + '\n' + path;
        if (expires <= now()) values.delete(key);
        else if (values.size < 128 || values.has(key)) values.set(key, { name: item[0], value: item[1], path, expires: Number.isNaN(expires) ? Infinity : expires });
      }
    },
    header(path = '/') {
      const selected = [...values.values()].filter(item => item.expires > now() && (path === item.path || path.startsWith(item.path.endsWith('/') ? item.path : item.path + '/'))).sort((a, b) => b.path.length - a.path.length);
      return selected.map(item => `${item.name}=${item.value}`).join('; ');
    },
    csrf(path) {
      const field = this.header(path).split('; ').find(value => value.startsWith('__csrf='));
      try { return field ? decodeURIComponent(field.slice(7)) : ''; } catch { return ''; }
    }
  };
}

async function responseText(response) {
  if (!response.body?.getReader) return response.text();
  const reader = response.body.getReader(); let length = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length; if (length > 8 * 1024 * 1024) throw Error('Music response too large');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

// Use the existing API modules only as payload builders. HTTP is a regular web
// session: fixed official origin, returned cookies and CSRF, no app identities,
// IP headers, anonymous registration, challenge automation or automatic retries.
export function createNeteaseBrowserApi({ requireLibrary, fetchImpl = fetch, now = Date.now, requestGate }) {
  const encrypt = requireLibrary('./util/crypto.js').weapi;
  const modules = new Map(METHODS.map(name => [name, requireLibrary(`./module/${name}.js`)]));
  const sessions = new Map();
  function session(cookie = '') {
    const key = createHash('sha256').update(cookie).digest('hex');
    if (!sessions.has(key)) {
      if (sessions.size >= 4) sessions.delete(sessions.keys().next().value);
      sessions.set(key, { jar: browserCookieJar(cookie, now), initialized: false, tail: Promise.resolve(), artistCache: new Map() });
    }
    return sessions.get(key);
  }
  async function exchange(state, path, data, method, deadline, plain = false) {
    const perform = async () => {
      const headers = { 'User-Agent': WEB_UA, Accept: 'application/json', Referer: ORIGIN + '/', Origin: ORIGIN };
      const cookie = state.jar.header(path); if (cookie) headers.Cookie = cookie;
      const options = { method: data ? 'POST' : 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - now()))) };
      if (data) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; const payload = { ...data, csrf_token: state.jar.csrf(path) }; options.body = new URLSearchParams(plain ? payload : encrypt(payload)).toString(); }
      const response = await fetchImpl(ORIGIN + path, options);
      const text = await responseText(response);
      if (!response.ok) {
        let body; try { body = JSON.parse(text); } catch { body = { code: response.status }; }
        throw { status: response.status, body };
      }
      state.jar.receive(response.headers.getSetCookie());
      if (!data) return;
      let body;
      try { body = JSON.parse(text); } catch { throw Error('Invalid music web response'); }
      const code = Number(body?.code);
      if (!OK.has(code)) throw { status: 400, body };
      return { status: 200, body, cookie: response.headers.getSetCookie() };
    };
    return requestGate ? requestGate.run(method, perform, { deadline }) : perform();
  }
  async function invoke(method, args = {}) {
    const state = session(args.cookie || '');
    const deadline = now() + 20000;
    if (method === 'login_qr_create') return modules.get(method)(args);
    const work = async () => {
      // Sorting and pagination reuse the same artist metadata. Keep successful
      // results per login session; failed/restricted responses are never cached.
      const cacheKey = method === 'artist_detail' ? JSON.stringify([method, String(args.id)])
        : method === 'artist_songs' ? JSON.stringify([method, String(args.id), args.order || 'hot', args.offset || 0, args.limit || 30]) : null;
      const cached = cacheKey && state.artistCache.get(cacheKey);
      if (cached && cached.expires > now()) return structuredClone(cached.result);
      if (!state.initialized) { await exchange(state, '/', null, method, deadline); state.initialized = true; }
      const request = async (uri, data) => {
        if (!/^\/api\/[A-Za-z0-9/_-]{1,160}$/.test(uri)) throw Error('Invalid music web route');
        // Use the public web artist metadata route instead of the app head-info route.
        if (uri === '/api/artist/head/info/get') { if (!/^\d{1,20}$/.test(String(args.id))) throw Error('Invalid artist ID'); uri = '/api/v1/artist/' + args.id; data = {}; }
        if (uri === '/api/cloudsearch/pc') uri = '/api/cloudsearch/get/web';
        if (uri === '/api/login/qrcode/unikey' || uri === '/api/login/qrcode/client/login') data = { ...data, type: 1 };
        // This upstream route uses plain API form parameters. Converting it to
        // /weapi/ changes its semantics and can return unrelated artist songs.
        if (method === 'artist_songs' && uri === '/api/v1/artist/songs') {
          if (!/^\d{1,20}$/.test(String(args.id))) throw Error('Invalid artist ID');
          return exchange(state, uri, data, method, deadline, true);
        }
        return exchange(state, uri.replace(/^\/api\//, '/weapi/'), data, method, deadline);
      };
      if (method === 'login_qr_check') {
        const result = await request('/api/login/qrcode/client/login', { key: args.key, type: 1 });
        const cookie = state.jar.header('/');
        if (Number(result.body.code) === 803 && !/(?:^|; )MUSIC_U=\S+/.test(cookie)) throw Error('Web login did not return a session');
        return { ...result, body: { ...result.body, ...(Number(result.body.code) === 803 ? { cookie } : {}) } };
      }
      // Modules may mutate query.cookie; those synthetic app fields are not sent.
      const result = await modules.get(method)({ ...args, cookie: {} }, request);
      if (cacheKey) {
        state.artistCache.delete(cacheKey);
        state.artistCache.set(cacheKey, { result: structuredClone(result), expires: now() + (method === 'artist_detail' ? 600000 : 30000) });
        if (state.artistCache.size > 16) state.artistCache.delete(state.artistCache.keys().next().value);
      }
      return result;
    };
    const result = state.tail.then(work);
    state.tail = result.catch(() => {});
    return result;
  }
  return Object.fromEntries(METHODS.map(method => [method, args => invoke(method, args)]));
}
