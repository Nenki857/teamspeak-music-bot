export function visitorName(value) {
  if (typeof value !== 'string') throw new Error('请输入点播 ID');
  const name = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  if (!name || [...name].length > 32) throw new Error('点播 ID 请填写 1–32 个字符');
  return name;
}
export function publicUserQuery(value, mode = 'nickname') {
  const query = String(value || '').trim();
  if (!query || query.length > 200) throw new Error('请输入网易云昵称、UID 或主页链接');
  if (mode === 'nickname') {
    if (/^(?:\+?86[ -]?)?1[3-9]\d{9}$/.test(query)) throw new Error('不支持手机号查找，请使用网易云昵称或 UID');
    return { query, mode };
  }
  if (mode !== 'uid') throw new Error('用户查找方式无效');
  if (/^\d{1,20}$/.test(query)) return { query, mode };
  try {
    const url = new URL(query);
    if (!['http:', 'https:'].includes(url.protocol) || !['music.163.com', 'www.music.163.com'].includes(url.hostname)) throw 0;
    const page = url.hash.startsWith('#/') ? new URL(url.hash.slice(1), url.origin) : url;
    const id = page.pathname === '/user/home' && page.searchParams.get('id');
    if (!/^\d{1,20}$/.test(id || '')) throw 0;
    return { query: id, mode };
  } catch { throw new Error('请输入网易云 UID 或完整用户主页链接'); }
}
