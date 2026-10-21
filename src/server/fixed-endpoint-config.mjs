import { isIP } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function fixedEndpointConfig({ ip, app, user, environment }) {
  if (isIP(ip) !== 4) throw new Error('请填写有效的公网 IPv4 地址');
  const [a,b]=ip.split('.').map(Number);
  if (a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)) throw new Error('固定入口需要公网 IPv4 地址');
  if (!/^\/[A-Za-z0-9_./-]+$/.test(app) || app.split('/').includes('..') || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) throw new Error('安装目录或用户名称无效');
  const settings = Object.fromEntries(environment.split(/\r?\n/).filter(line=>line&&!line.startsWith('#')).map(line=>{const at=line.indexOf('=');return[line.slice(0,at),line.slice(at+1)];}));
  if ((settings.TSMD_HOST && settings.TSMD_HOST!=='127.0.0.1') || (settings.TSMD_PORT && settings.TSMD_PORT!=='18080')) throw new Error('固定入口要求主人后台仅监听 127.0.0.1:18080');
  const kept = environment.split(/\r?\n/).filter(line=>!/^TSMD_(PUBLIC_URL|PERSISTENT_SHARES|FRIEND_PORT)=/.test(line));
  const env = kept.join('\n').trimEnd()+`\nTSMD_PUBLIC_URL=https://${ip}\nTSMD_PERSISTENT_SHARES=1\nTSMD_FRIEND_PORT=18081\n`;
  const caddy = `{
  admin off
  auto_https disable_redirects
  default_sni ${ip}
  skip_install_trust
}
https://${ip} {
  tls {
    issuer acme {
      dir https://acme-v02.api.letsencrypt.org/directory
      profile shortlived
      disable_tlsalpn_challenge
    }
  }
  reverse_proxy 127.0.0.1:18081
}
`;
  const unit = `# TSMD managed fixed friend endpoint
[Unit]
Description=TS Music Desk fixed HTTPS friend endpoint
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${app}
Environment=XDG_DATA_HOME=${app}/server-data/https
Environment=XDG_CONFIG_HOME=${app}/server-data/https-config
ExecStart=${app}/runtime/caddy/caddy run --config ${app}/runtime/caddy/Caddyfile --adapter caddyfile
Restart=on-failure
RestartSec=5
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
UMask=0077
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
  return { environment: env, caddy, unit };
}
export function writeFixedEndpointFiles(input, output) {
  const result = fixedEndpointConfig(input);
  // The downloaded archive also contains a binary named "caddy".
  // Keep its name separate from the generated text configuration.
  for (const [name, value] of Object.entries(result)) {
    writeFileSync(resolve(output, name === 'caddy' ? 'Caddyfile' : name), value, { mode: 0o600 });
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [ip,app,user,output] = process.argv.slice(2);
  writeFixedEndpointFiles({ip,app,user,environment:readFileSync(resolve(app,'server.env'),'utf8')},output);
}
