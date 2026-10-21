export function publicOrigin(value) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('公网地址需要填写 HTTPS 网站根地址');
  return url.origin;
}
export function allowedShareUrl(value, configured = process.env.TSMD_PUBLIC_URL) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== '/' || url.search || !/^#invite=[A-Za-z0-9_-]{43}$/.test(url.hash)) return false;
    return /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url.origin) || Boolean(configured && url.origin === publicOrigin(configured));
  } catch { return false; }
}
