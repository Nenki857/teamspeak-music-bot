#!/usr/bin/env bash
set -euo pipefail
umask 077
PUBLIC_IP="${1:?Missing public IPv4}"
CADDY_ARCHIVE="${2:-}"
APP_DIR="$(realpath -e "$(systemctl show ts-music-desk.service -p WorkingDirectory --value)")"
case "$APP_DIR/" in "$HOME/"?*/) ;; *) echo 'Music service must be inside your home directory.' >&2; exit 1 ;; esac
[[ -f "$APP_DIR/src/server/fixed-endpoint-config.mjs" && -f "$APP_DIR/src/server/persistent-shares.mjs" ]] || { echo 'Apply the latest small server update first.' >&2; exit 1; }
[[ -x "$APP_DIR/runtime/node/bin/node" && -f "$APP_DIR/server.env" ]] || exit 1
systemctl is-active --quiet ts-music-desk.service || { echo 'Music backend must already be running.' >&2; exit 1; }
UNIT=/etc/systemd/system/ts-music-desk-https.service
if [[ -e "$UNIT" ]]; then
  grep -qx '# TSMD managed fixed friend endpoint' "$UNIT" || { echo 'Refusing to overwrite an unrelated HTTPS service.' >&2; exit 1; }
  [[ "$(systemctl show ts-music-desk-https.service -p WorkingDirectory --value)" == "$APP_DIR" ]] || { echo 'HTTPS service belongs to another installation.' >&2; exit 1; }
elif [[ -n "$(ss -H -ltn 'sport = :80 or sport = :443 or sport = :18081')" ]]; then
  echo 'Ports 80, 443 or 18081 are occupied. Existing websites will not be changed.' >&2; exit 1
fi
for operation in 'daemon-reload' 'enable ts-music-desk-https.service' 'restart ts-music-desk-https.service' 'restart ts-music-desk.service'; do
  # The words here are fixed commands, never user input.
  if ! sudo -n -l -- /usr/bin/systemctl $operation >/dev/null 2>&1; then echo 'Passwordless sudo is required to install this separate HTTPS service. No settings changed.' >&2; exit 20; fi
done
BASE="$APP_DIR/runtime/caddy"
if ! sudo -n -l -- /usr/bin/install -m 644 "$BASE/unit" "$UNIT" >/dev/null 2>&1; then echo 'Missing passwordless service-install permission. No settings changed.' >&2; exit 20; fi
mkdir -p "$BASE" "$APP_DIR/server-data/https" "$APP_DIR/server-data/https-config"
NODE="$APP_DIR/runtime/node/bin/node"
STAGE="$(mktemp -d "$BASE/setup-XXXXXX")"
"$NODE" "$APP_DIR/src/server/fixed-endpoint-config.mjs" "$PUBLIC_IP" "$APP_DIR" "$(id -un)" "$STAGE"
if [[ ! -x "$BASE/caddy" ]]; then
  if [[ -n "$CADDY_ARCHIVE" ]]; then
    [[ -f "$CADDY_ARCHIVE" && "$(sha256sum "$CADDY_ARCHIVE" | cut -d' ' -f1)" == 727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b ]] || { echo 'Uploaded Caddy archive checksum mismatch.' >&2; exit 1; }
    cp "$CADDY_ARCHIVE" "$STAGE/caddy.tar.gz"
  else
  echo 'Downloading Caddy 2.11.7 once; existing music runtimes are reused.'
  curl --fail --location --retry 3 --connect-timeout 15 https://api.github.com/repos/caddyserver/caddy/releases/tags/v2.11.7 -o "$STAGE/release.json"
  "$NODE" --input-type=module - "$STAGE" <<'NODE'
import{readFileSync,writeFileSync}from'node:fs';import{resolve}from'node:path';
const dir=process.argv[2],release=JSON.parse(readFileSync(resolve(dir,'release.json'))),asset=release.assets?.find(x=>x.name==='caddy_2.11.7_linux_amd64.tar.gz');
if(!asset||!/^sha256:[a-f0-9]{64}$/.test(asset.digest)||asset.browser_download_url!=='https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_linux_amd64.tar.gz'||!/^https:\/\/api\.github\.com\/repos\/caddyserver\/caddy\/releases\/assets\/\d+$/.test(asset.url))throw Error('Unexpected Caddy release metadata');
writeFileSync(resolve(dir,'url'),asset.url);writeFileSync(resolve(dir,'sha'),asset.digest.slice(7)+'  caddy.tar.gz\n');
NODE
  curl --fail --location --retry 3 --connect-timeout 15 --max-time 1800 -H 'Accept: application/octet-stream' "$(cat "$STAGE/url")" -o "$STAGE/caddy.tar.gz"
  (cd "$STAGE"; sha256sum --check --status sha)
  fi
  tar -xzf "$STAGE/caddy.tar.gz" -C "$STAGE" caddy LICENSE
  install -m 755 "$STAGE/caddy" "$BASE/caddy"
  cp "$STAGE/LICENSE" "$BASE/LICENSE"
else
  echo 'Reusing the Caddy program already installed on this server; no download is needed.'
fi
"$BASE/caddy" adapt --config "$STAGE/Caddyfile" --adapter caddyfile > "$STAGE/adapted.json"
if [[ -f "$BASE/Caddyfile" ]]; then cp -a "$BASE/Caddyfile" "$STAGE/previous-Caddyfile"; fi
cp "$STAGE/Caddyfile" "$BASE/Caddyfile"; cp "$STAGE/unit" "$BASE/unit"
sudo -n /usr/bin/install -m 644 "$BASE/unit" "$UNIT"
sudo -n /usr/bin/systemctl daemon-reload
sudo -n /usr/bin/systemctl enable ts-music-desk-https.service
sudo -n /usr/bin/systemctl restart ts-music-desk-https.service
echo 'Waiting for a publicly trusted IP certificate. Allow inbound TCP 80 and 443 in your cloud firewall.'
tls_ready=0
for attempt in {1..24}; do
  if curl --silent --output /dev/null --connect-timeout 2 --max-time 4 --resolve "$PUBLIC_IP:443:127.0.0.1" "https://$PUBLIC_IP/"; then tls_ready=1; break; fi
  sleep 2
done
if [[ "$tls_ready" != 1 ]]; then
  echo 'HTTPS is not ready yet. Existing music configuration was NOT switched away from its current entry.' >&2
  echo 'Allow TCP 80/443 in the cloud firewall, then rerun this setup. Do not bypass browser certificate warnings.' >&2
  echo 'Inspect: journalctl -u ts-music-desk-https -n 40 --no-pager' >&2
  exit 1
fi
cp -a "$APP_DIR/server.env" "$STAGE/previous-server.env"
restore() {
  trap - ERR INT TERM
  cp "$STAGE/previous-server.env" "$APP_DIR/server.env"; chmod 600 "$APP_DIR/server.env"
  sudo -n /usr/bin/systemctl restart ts-music-desk.service || true
  echo 'Music environment restored. Existing settings and data were retained.' >&2
  exit 1
}
trap restore ERR INT TERM
cp "$STAGE/environment" "$APP_DIR/server.env"; chmod 600 "$APP_DIR/server.env"
sudo -n /usr/bin/systemctl restart ts-music-desk.service
ready=0
for attempt in {1..30}; do
  if [[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 2 http://127.0.0.1:18081/ || true)" == 200 ]]; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]]
# The fixed public listener must never offer owner login endpoints.
[[ "$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 5 --resolve "$PUBLIC_IP:443:127.0.0.1" "https://$PUBLIC_IP/api/admin/session" || true)" == 404 ]]
trap - ERR INT TERM
echo "Fixed friend website is ready: https://$PUBLIC_IP/"
echo 'Copy its complete #invite= link from the owner console after the bot connects; that link survives restarts until revoked.'
echo 'Owner console remains http://127.0.0.1:18080/admin through your SSH tunnel.'
echo "Previous environment and setup files: $STAGE"
