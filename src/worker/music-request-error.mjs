// The upstream API uses negative body codes for restricted requests. Its HTTP-like
// status is often only 400, so keep the body code when choosing a safe message.
export function musicRequestError(error, { publicOnly = false } = {}) {
  const numeric = value => value !== undefined && value !== null && Number.isFinite(Number(value)) ? Number(value) : undefined;
  const status = numeric(error?.status) ?? numeric(error?.response?.status);
  const code = numeric(error?.neteaseCode) ?? numeric(error?.body?.code) ?? numeric(error?.response?.data?.code) ?? status;
  const localCooldown = error?.localCooldown === true && Number.isFinite(error?.retryAfterMs) && error.retryAfterMs > 0;
  const retryAfterMs = localCooldown ? Math.min(60000, Math.ceil(error.retryAfterMs)) : undefined;
  let message;
  if (localCooldown) message = `请求仍在本地冷却中，约 ${Math.ceil(retryAfterMs / 1000)} 秒后再试；本次未向网易云发送请求（上次限制代码 ${code}）`;
  else if (code === -462 || code === -460) message = `网易云暂时限制了此请求（${code}），请稍后再试；反复刷新可能仍会失败`;
  else if (code === 301 || code === 401) message = publicOnly ? '公开资料暂时无法读取，请确认歌单公开设置或稍后重试' : '登录已失效，请重新扫码';
  else if (code === 429) message = '网易云请求过于频繁，请稍后再试';
  else if (code === 403) message = '音乐服务拒绝了请求，请稍后重试';
  else {
    const text = [error?.code, error?.cause?.code, error?.message, error?.body?.msg].filter(value => typeof value === 'string').join(' ');
    if (/\b(?:ETIMEDOUT|ECONNABORTED|UND_ERR_CONNECT_TIMEOUT)\b|音乐服务响应超时/i.test(text)) message = '服务器访问网易云超时，请稍后重试';
    else if (/\b(?:ENOTFOUND|EAI_AGAIN)\b/.test(text)) message = '服务器无法解析网易云地址，请检查服务器 DNS';
    else if (/\b(?:ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b/.test(text)) message = '服务器连接网易云失败，请稍后重试';
    else if (publicOnly) message = '公开资料暂时无法读取，请确认 UID、歌单公开设置或稍后重试';
    else if (code !== undefined && Number.isInteger(code) && Math.abs(code) < 1000000) message = `网易云请求失败（代码 ${code}），请稍后重试`;
    else message = '音乐请求失败，请检查网络或稍后重试';
  }
  return { message, status, code, ...(localCooldown ? { localCooldown: true, retryAfterMs } : {}) };
}
