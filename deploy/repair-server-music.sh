#!/usr/bin/env bash
set -euo pipefail
umask 077
CHECKER="${1:?Missing checker}"
ADAPTER="${2:?Missing session adapter}"
ARCHIVE="${3:?Missing update archive}"
EXPECTED="${4:?Missing archive checksum}"
UPDATER="${5:?Missing updater}"
MODE="${7:-guest}"
SOURCE_IP="${8:-}"
[[ "$MODE" == guest || "$MODE" == web || "$MODE" == maintained || "$MODE" == maintained-ip || "$MODE" == browser ]] || exit 1
APP_DIR="$(realpath -e "$(systemctl show ts-music-desk.service -p WorkingDirectory --value)")"
case "$APP_DIR/" in "$HOME/"?*/) ;; *) echo 'Unexpected music service directory.' >&2; exit 1 ;; esac
NODE="$APP_DIR/runtime/node/bin/node"
if [[ "$MODE" == maintained-ip ]]; then
  [[ -n "$SOURCE_IP" ]] || { echo 'Missing actual server source address.' >&2; exit 1; }
  [[ "$SOURCE_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo 'Invalid server source address.' >&2; exit 1; }
"$NODE" --input-type=module - "$APP_DIR" "$SOURCE_IP" <<'SOURCE_CHECK'
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { validateNeteaseSourceIP } = await import(pathToFileURL(resolve(process.argv[2], 'src/worker/netease-library.mjs')));
validateNeteaseSourceIP(process.argv[3]);
SOURCE_CHECK
fi
[[ -x "$NODE" && -f "$CHECKER" && -f "$ADAPTER" && -f "$ARCHIVE" && -f "$UPDATER" && "$EXPECTED" =~ ^[a-f0-9]{64}$ ]] || exit 1
echo "Testing $MODE music requests before changing the installed bot."
REPORT="${6:-$HOME/tsmd-music-repair-report.json}"
CHECK_ARGS=("$APP_DIR" "$ADAPTER")
if [[ "$MODE" == maintained || "$MODE" == maintained-ip ]]; then
  LIBRARY="$APP_DIR/runtime/netease-api-4.41.1/node_modules/@neteasecloudmusicapienhanced/api/main.js"
  [[ -f "$LIBRARY" ]] || { echo 'Isolated music library has not been prepared.' >&2; exit 1; }
  CHECK_ARGS+=("$LIBRARY")
  if [[ "$MODE" == maintained-ip ]]; then CHECK_ARGS+=("$SOURCE_IP"); fi
fi
if ! "$NODE" "$CHECKER" "${CHECK_ARGS[@]}" > "$REPORT"; then
  cat "$REPORT"
  echo 'The server did not pass the music request check. No running program, login or service was changed.' >&2
  exit 21
fi
"$NODE" --input-type=module - "$REPORT" <<'NODE'
import{readFileSync}from'node:fs';
const report=JSON.parse(readFileSync(process.argv[2],'utf8'));
if(report.candidatePassed!==true)throw Error('Live repair check did not pass');
NODE
for operation in stop start; do
  sudo -n -l -- /usr/bin/systemctl "$operation" ts-music-desk.service >/dev/null
done
BACKUP="$(mktemp "$APP_DIR/runtime/music-session-environment-XXXXXX")"
cp -p "$APP_DIR/server.env" "$BACKUP"
restore() {
  trap - ERR
  cp -p "$BACKUP" "$APP_DIR/server.env"
  sudo -n /usr/bin/systemctl restart ts-music-desk.service || true
  echo 'Activation failed; the previous environment was restored. Current data was retained.' >&2
  exit 1
}
trap restore ERR
"$NODE" --input-type=module - "$APP_DIR/server.env" "$MODE" "$SOURCE_IP" <<'NODE'
import{readFileSync,writeFileSync,renameSync}from'node:fs';
const file=process.argv[2],mode=process.argv[3],sourceIP=process.argv[4];
if(!['guest','web','maintained','maintained-ip','browser'].includes(mode))throw Error('Invalid music request mode');
const text=readFileSync(file,'utf8').replace(/^TSMD_NETEASE_(?:SESSION_FIX|WEB_REQUESTS|MAINTAINED_API|SOURCE_IP|WEB_CLIENT)=.*\r?\n?/gm,'').trimEnd();
const flag={web:'TSMD_NETEASE_WEB_REQUESTS',guest:'TSMD_NETEASE_SESSION_FIX',maintained:'TSMD_NETEASE_MAINTAINED_API','maintained-ip':'TSMD_NETEASE_MAINTAINED_API',browser:'TSMD_NETEASE_WEB_CLIENT'}[mode];
const extra=mode==='maintained-ip'?'TSMD_NETEASE_SOURCE_IP='+sourceIP+'\n':'';
writeFileSync(file+'.session-new',text+'\n'+flag+'=1\n'+extra,{mode:0o600});renameSync(file+'.session-new',file);
NODE
# The updater backs up program files and starts the bot once with the new flag.
bash "$UPDATER" "$ARCHIVE" "$EXPECTED"
ready=0
for attempt in {1..20}; do
  code="$(curl --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 1 --max-time 2 http://127.0.0.1:18080/api/admin/session || true)"
  if [[ "$code" == 401 || "$code" == 200 ]] && systemctl is-active --quiet ts-music-desk.service; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]]
trap - ERR
cat "$REPORT"
echo "Music session repair enabled ($MODE). Environment backup: $BACKUP"
if [[ "$MODE" == browser ]]; then
  echo 'Web login transport is ready. Open Music account -> QR login and confirm in the official NetEase app.'
  echo 'Search and playback have NOT been verified yet; verify both after logging in.'
else
  echo 'Refresh the owner console and request a new QR code. Playlists, account data and audio backend were retained.'
fi
