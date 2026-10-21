export function createServerBridge(csrf, onExpired, { fetcher = fetch, Socket = WebSocket, location = window.location } = {}) {
  const subscriptions = new Set(); let socket; let timer; let disposed = false;
  async function post(path, body = {}) {
    const response = await fetcher(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TSMD-CSRF': csrf }, body: JSON.stringify(body) });
    if (response.status === 401) { dispose(); onExpired(); throw new Error('主人登录已过期，请重新登录'); }
    const data = await response.json(); if (!data.ok) throw new Error(data.error || '操作失败'); return data.result;
  }
  function connect() {
    if (disposed || !subscriptions.size || socket) return;
    socket = new Socket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/admin/events`);
    socket.onmessage = event => {
      const data = JSON.parse(event.data);
      if (data.type === 'state') for (const callback of subscriptions) callback(data.state);
      if (data.type === 'revoked') { dispose(); onExpired(); }
    };
    socket.onclose = () => { socket = null; if (!disposed && subscriptions.size) timer = setTimeout(connect, 4000); };
  }
  function dispose() { disposed = true; clearTimeout(timer); if (socket) { socket.onclose = null; socket.close(); socket = null; } subscriptions.clear(); }
  return {
    server: true,
    rpc: (method, args = {}) => post('/api/admin/rpc', { method, args, id: crypto.randomUUID() }),
    subscribe(callback) { subscriptions.add(callback); connect(); return () => { subscriptions.delete(callback); if (!subscriptions.size) { clearTimeout(timer); if (socket) { socket.onclose = null; socket.close(); socket = null; } } }; },
    resources: () => post('/api/admin/resources'),
    changePassword: value => post('/api/admin/password', value),
    copy: async text => { await navigator.clipboard.writeText(text); return true; },
    openLink: value => { const url = new URL(value, location.href); if (url.origin !== location.origin) throw new Error('仅可预览当前服务器页面'); window.open(url.href, '_blank', 'noopener'); },
    async quit() { try { await post('/api/admin/logout'); } finally { dispose(); onExpired(); } },
    dispose
  };
}
