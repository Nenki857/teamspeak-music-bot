export function normalizeNeteaseCookie(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 16384 || /[\x00-\x1f\x7f-\uffff]/.test(input)) throw Error('请粘贴网易云登录会话，不能包含换行或其他请求头');
  const text = input.trim();
  // DevTools copies a cookie cell's value without its name. Accept that form;
  // the independent account check still has to succeed before anything is saved.
  if (/^[A-Za-z0-9_%+/.~-]{16,}={0,2}$/.test(text)) return `MUSIC_U=${text}`;
  const fields = new Map();
  for (const part of input.trim().replace(/^Cookie:\s*/i, '').split(';')) {
    if (!part.trim()) continue;
    const index = part.indexOf('='), key = part.slice(0, index).trim(), value = part.slice(index + 1).trim();
    if (index < 1 || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key) || /[\s;,]/.test(value) || fields.has(key)) throw Error('登录信息格式无效，请复制网易云网页的完整会话字段');
    fields.set(key, value);
  }
  if (!fields.get('MUSIC_U') || fields.get('MUSIC_U').length < 8) throw Error('没有找到网易云登录会话，请先在本机网易云网页版登录');
  return [...fields].map(([key, value]) => `${key}=${value}`).join('; ');
}
