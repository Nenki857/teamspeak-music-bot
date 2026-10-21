#!/usr/bin/env bash
set -euo pipefail
umask 077
APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
if [[ $(id -u) == 0 ]]; then echo '请用具备免密 sudo 权限的 ubuntu 用户运行，不要 sudo bash。' >&2; exit 1; fi
if [[ $(uname -m) != x86_64 || "$APP_DIR" != "$HOME/"* || "$APP_DIR" == *[[:space:]%]* ]]; then echo '请将发行包解压到自己家目录内、无空格的路径；仅支持 x86_64。' >&2; exit 1; fi
if systemctl is-active --quiet ts-music-desk.service; then echo '已有音乐服务在运行，请先按照升级文档停止该服务；不会改动 TS 服务。' >&2; exit 1; fi
if ! sudo -n -l -- /usr/bin/apt-get update >/dev/null 2>&1; then
  echo '缺少免密 sudo 权限，安装已停止。SSH 密钥不能代替 sudo 密码，请联系服务器管理员。' >&2
  exit 20
fi
sudo -n /usr/bin/apt-get update
sudo -n /usr/bin/apt-get install -y ca-certificates curl xz-utils ffmpeg build-essential python3 pkg-config
mkdir -p "$APP_DIR/runtime/node" "$APP_DIR/resources" "$APP_DIR/server-data"
chmod 700 "$APP_DIR/server-data"
if [[ ! -x "$APP_DIR/runtime/node/bin/node" ]]; then
  NODE_BASE='https://nodejs.org/dist/latest-v22.x'
  curl --fail --location --retry 3 "$NODE_BASE/SHASUMS256.txt" -o "$APP_DIR/runtime/SHASUMS256.txt"
  NODE_ARCHIVE="$(awk '$2 ~ /^node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$/ {print $2}' "$APP_DIR/runtime/SHASUMS256.txt")"
  if [[ ! "$NODE_ARCHIVE" =~ ^node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$ ]]; then echo 'Node 下载清单异常' >&2; exit 1; fi
  curl --fail --location --retry 3 "$NODE_BASE/$NODE_ARCHIVE" -o "$APP_DIR/runtime/$NODE_ARCHIVE"
  (cd "$APP_DIR/runtime"; awk -v name="$NODE_ARCHIVE" '$2 == name' SHASUMS256.txt | sha256sum --check --status)
  tar --extract --xz --file "$APP_DIR/runtime/$NODE_ARCHIVE" --directory "$APP_DIR/runtime/node" --strip-components=1
fi
export PATH="$APP_DIR/runtime/node/bin:/usr/local/bin:/usr/bin:/bin"
export npm_config_jobs=1 MAKEFLAGS=-j1 npm_config_nodedir="$APP_DIR/runtime/node"
node -e 'if(process.versions.node.split(".")[0]!=="22")process.exit(1)'
if [[ ! -x "$APP_DIR/resources/cloudflared" ]]; then
  curl --fail --location --retry 3 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest' -o "$APP_DIR/runtime/cloudflared-release.json"
  node --input-type=module -e 'import{readFileSync,writeFileSync}from"node:fs";const a=JSON.parse(readFileSync(process.argv[1])).assets.find(x=>x.name==="cloudflared-linux-amd64");if(!a||!/^sha256:[a-f0-9]{64}$/.test(a.digest)||!a.browser_download_url.startsWith("https://github.com/cloudflare/cloudflared/releases/download/"))throw Error("下载清单异常");writeFileSync(process.argv[2],a.browser_download_url);writeFileSync(process.argv[3],a.digest.slice(7)+"  cloudflared\n")' "$APP_DIR/runtime/cloudflared-release.json" "$APP_DIR/runtime/cloudflared-url.txt" "$APP_DIR/resources/cloudflared.sha256"
  curl --fail --location --retry 3 "$(cat "$APP_DIR/runtime/cloudflared-url.txt")" -o "$APP_DIR/resources/cloudflared"
  (cd "$APP_DIR/resources"; sha256sum --check --status cloudflared.sha256)
  chmod 755 "$APP_DIR/resources/cloudflared"
fi
(cd "$APP_DIR"; npm ci --omit=dev --no-audit --no-fund)
# FFmpeg comes from Ubuntu. Skip ffmpeg-static's redundant binary download,
# then explicitly install the two audio/database native modules for Linux.
(cd "$APP_DIR/vendor/teamspeak-music-bot-1.13.2"; npm ci --omit=dev --ignore-scripts --no-audit --no-fund; npm rebuild @discordjs/opus better-sqlite3 --foreground-scripts)
if [[ ! -f "$APP_DIR/server-data/server-admin.json" ]]; then
  TSMD_DATA_DIR="$APP_DIR/server-data" node "$APP_DIR/src/server/entry.mjs" --init
fi
if [[ ! -f "$APP_DIR/server.env" ]]; then
  cat > "$APP_DIR/server.env" <<EOF
TSMD_DATA_DIR=$APP_DIR/server-data
TSMD_HOST=127.0.0.1
TSMD_PORT=18080
TSMD_AUTOSTART=1
TSMD_NETEASE_WEB_CLIENT=1
EOF
fi
chmod 600 "$APP_DIR/server.env"
SERVICE_FILE="$APP_DIR/runtime/ts-music-desk.service"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=TS Music Bot server (existing TS3 audio core)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PATH=$APP_DIR/runtime/node/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=$APP_DIR/server.env
ExecStart=$APP_DIR/runtime/node/bin/node $APP_DIR/src/server/entry.mjs
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=10
UMask=0077
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
sudo -n /usr/bin/install -m 644 "$SERVICE_FILE" /etc/systemd/system/ts-music-desk.service
sudo -n /usr/bin/systemctl daemon-reload
sudo -n /usr/bin/systemctl enable --now ts-music-desk.service
bash "$APP_DIR/deploy/wait-server.sh"
echo '音乐后台已安装。不会改动或重启你的 TS 服务。'
echo '在自己电脑建立 SSH 转发后访问 http://127.0.0.1:18080/admin。首次需填写 TS 预设并扫码登录。'
