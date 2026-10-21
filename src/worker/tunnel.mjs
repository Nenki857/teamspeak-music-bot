import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { root } from './paths.mjs';
import { publicOrigin } from '../shared/public-url.mjs';
export class Tunnel {
  constructor(onChange) { this.onChange = onChange; this.state = { status: 'off', url: '' }; }
  async start(port) {
    this.stop(); const exe = process.env.TSMD_CLOUDFLARED || resolve(root, process.platform === 'win32' ? 'resources/cloudflared.exe' : 'resources/cloudflared');
    if (!existsSync(exe)) throw new Error('缺少公网连接组件，请运行安装脚本');
    this.state = { status: 'connecting', url: '' }; this.onChange();
    const child = spawn(exe, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', `http://127.0.0.1:${port}`, '--metrics', '127.0.0.1:0'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    return new Promise((resolveStart, reject) => {
      let settled = false; let tail = ''; let foundUrl = '';
      const timer = setTimeout(() => { if (!settled) { settled = true; this.stop(); reject(new Error('公网连接超时，请检查网络后重试')); } }, 40000);
      const finish = () => { if (settled || !foundUrl) return; settled = true; clearTimeout(timer); this.state = { status: 'online', url: foundUrl }; this.onChange(); resolveStart(this.state); };
      const data = chunk => { if (this.child !== child) return; tail = (tail + chunk.toString()).slice(-10000); const match = tail.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (match) foundUrl = match[0]; if (tail.includes('Registered tunnel connection')) finish(); };
      child.stdout.on('data', data); child.stderr.on('data', data);
      const failure = () => { clearTimeout(timer); if (this.child === child) { this.child = null; this.state = { status: 'error', url: '', error: '公网连接已断开，请重新开启并复制新链接' }; this.onChange(); } if (!settled) { settled = true; reject(new Error('公网连接失败，请检查网络后重试')); } };
      child.on('error', failure); child.on('exit', failure);
    });
  }
  stop() { const child = this.child; this.child = null; if (child) child.kill(); this.state = { status: 'off', url: '' }; this.onChange(); }
}

// A reverse proxy can publish a stable HTTPS origin without a temporary tunnel.
export class FixedPublicEndpoint {
  constructor(onChange, url) { this.onChange = onChange; this.url = publicOrigin(url); this.state = { status: 'off', url: '', kind: 'fixed' }; }
  async start() { this.state = { status: 'online', url: this.url, kind: 'fixed' }; this.onChange(); return this.state; }
  stop() { this.state = { status: 'off', url: '', kind: 'fixed' }; this.onChange(); }
}
