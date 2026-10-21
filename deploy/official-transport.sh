#!/usr/bin/env bash
set -euo pipefail
umask 077
MODE="${1:---install}"
INSTALL_STAGE='Preflight'
trap 'printf "Official audio setup failed at: %s (line %s). Check the error above.\n" "$INSTALL_STAGE" "$LINENO" >&2' ERR
APP_DIR="$(realpath -e "$(systemctl show ts-music-desk.service -p WorkingDirectory --value)")"
case "$APP_DIR/" in "$HOME/"?*/) ;; *) echo 'Music app must be inside your home directory.' >&2; exit 1 ;; esac
[[ "$APP_DIR" != *[[:space:]%]* && -x "$APP_DIR/runtime/node/bin/node" ]] || exit 1
NODE="$APP_DIR/runtime/node/bin/node"
if [[ "$MODE" == --diagnose ]]; then
  [[ -f "${2:-}" ]] || { echo 'Diagnostic helper missing.' >&2;exit 1; }
  "$NODE" "$2" "$APP_DIR"
  exit 0
fi
grep -Fxq "TSMD_DATA_DIR=$APP_DIR/server-data" "$APP_DIR/server.env" || { echo 'Custom data paths need a manual migration; no changes made.' >&2; exit 1; }
if [[ "$MODE" == --archive ]]; then
  BACKUP="$(mktemp -d "$APP_DIR/runtime/audio-chain-archive-XXXXXX")"
  tar -czf "$BACKUP/program.tar.gz" -C "$APP_DIR" src dist/ui vendor/teamspeak-music-bot-1.13.2/src vendor/teamspeak-music-bot-1.13.2/dist package.json package-lock.json vendor/teamspeak-music-bot-1.13.2/package.json vendor/teamspeak-music-bot-1.13.2/package-lock.json
  cp -a "$APP_DIR/server.env" "$BACKUP/server.env"
  python3 - "$APP_DIR/server-data" "$BACKUP" <<'PY'
import sqlite3,sys,pathlib,shutil
source,target=map(pathlib.Path,sys.argv[1:]);(target/'data').mkdir(mode=0o700)
for name in ['app.db','core.db']:
    if not (source/name).is_file(): continue
    original=sqlite3.connect((source/name).as_uri()+'?mode=ro',uri=True);copy=sqlite3.connect(target/'data'/name);original.backup(copy);copy.close();original.close()
for name in ['server-vault.key','server-admin.json','official-transport.json']:
    if (source/name).is_file(): shutil.copy2(source/name,target/'data'/name)
PY
  (cd "$BACKUP"; sha256sum program.tar.gz > program.tar.gz.sha256)
  printf '%s\n' "$BACKUP" > "$APP_DIR/runtime/last-audio-chain-archive.path"
  echo "Current code and private data archived ON SERVER: $BACKUP"
  exit 0
fi
if [[ "$MODE" == --custom ]]; then
  if ! grep -qx 'TSMD_AUDIO_BACKEND=official' "$APP_DIR/server.env"; then echo 'Original transport is already selected. No restart needed.';exit 0;fi
  [[ -f "$APP_DIR/src/server/configure-official-transport.mjs" ]] || { echo 'Rollback helper missing; restore the archived program before stopping services.' >&2;exit 1; }
  sudo -n /usr/bin/systemctl stop ts-music-desk.service
  sudo -n /usr/bin/systemctl stop ts-music-desk-official.service || true
  "$NODE" "$APP_DIR/src/server/configure-official-transport.mjs" --custom "$APP_DIR"
  if [[ -f /etc/systemd/system/ts-music-desk.service.d/official-audio.conf ]]; then sudo -n /usr/bin/rm -- /etc/systemd/system/ts-music-desk.service.d/official-audio.conf; fi
  sudo -n /usr/bin/systemctl daemon-reload
  sudo -n /usr/bin/systemctl start ts-music-desk.service
  echo 'Original transport restored. Current playlists, accounts and fixed URL settings retained.'
  exit 0
fi
[[ "$MODE" == --install && -f "$APP_DIR/runtime/last-audio-chain-archive.path" && -f "$APP_DIR/src/server/official-core-engine.mjs" && -f "${2:-}" ]] || { echo 'Archive current server first, then apply the latest code and supply the bridge script.' >&2; exit 1; }
if ! sudo -n -l -- /usr/bin/apt-get update >/dev/null 2>&1; then echo 'Passwordless administrative installation permission required. Original audio selection retained.' >&2; exit 20; fi
BASE="$APP_DIR/runtime/sinusbot"
if [[ ! -f "$BASE/.tsmd-managed" && -n "$(ss -H -ltn 'sport = :18087')" ]]; then echo 'Private bridge port 18087 is occupied; existing services will not be changed.' >&2; exit 1; fi
INSTALL_STAGE='System dependencies'
sudo -n /usr/bin/apt-get update
sudo -n /usr/bin/apt-get install -y --no-install-recommends xvfb xauth x11-xkb-utils less libxcursor1 ca-certificates curl bzip2 libnss3 libegl1 libegl-mesa0 libasound2 libpci3 libxslt1.1 libxkbcommon0 libxkbcommon-x11-0 libxss1 libxcomposite1 libxi6 libxrender1 libxtst6 libxrandr2 libxcb-xinerama0 libglib2.0-0 libopus0 ffmpeg python3
mkdir -p "$BASE";touch "$BASE/.tsmd-managed"
if [[ ! -x "$BASE/sinusbot" ]]; then
  INSTALL_STAGE='Preparing SinusBot archive'
  if [[ -n "${3:-}" ]]; then
    [[ "${4:-}" =~ ^[a-f0-9]{64}$ && -f "$3" ]] || { echo 'Uploaded SinusBot package or SHA256 missing.' >&2;exit 1; }
    [[ "$(sha256sum "$3" | cut -d' ' -f1)" == "$4" ]] || { echo 'Uploaded SinusBot package checksum mismatch.' >&2;exit 1; }
    echo 'Using the official component uploaded from your computer; server download is skipped.'
    cp "$3" "$BASE/sinusbot.tar.bz2"
  else
    echo 'Downloading the official SinusBot Linux archive...'
    if ! curl --fail --location --retry 2 --connect-timeout 15 --max-time 600 https://www.sinusbot.com/dl/sinusbot.current.tar.bz2 -o "$BASE/sinusbot.tar.bz2.part"; then
      echo 'SinusBot download failed. Prepare the official Linux archive in your browser and rerun the Windows switch launcher. Audio selection was not changed.' >&2;exit 22
    fi
    mv "$BASE/sinusbot.tar.bz2.part" "$BASE/sinusbot.tar.bz2"
  fi
  python3 - "$BASE/sinusbot.tar.bz2" <<'PY'
import sys,tarfile,pathlib
with tarfile.open(sys.argv[1],'r:bz2') as archive:
    members=archive.getmembers(); names={m.name.removeprefix('./') for m in members}
    for member in members:
        path=pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or '\\' in member.name or not (member.isfile() or member.isdir()):
            raise SystemExit('Unsupported audio archive entry; no audio switch performed.')
    if not {'sinusbot','config.ini.dist','plugin/libsoundbot_plugin.so'} <= names:
        raise SystemExit('Not a complete official Linux SinusBot package; no audio switch performed.')
PY
  tar -xjf "$BASE/sinusbot.tar.bz2" -C "$BASE" --no-same-owner --no-same-permissions
  (cd "$BASE";sha256sum sinusbot.tar.bz2 > downloaded-binary.sha256)
fi
if [[ ! -x "$BASE/TeamSpeak3-Client-linux_amd64/ts3client_linux_amd64" ]]; then
  INSTALL_STAGE='TeamSpeak client download and interactive license'
  echo 'Compatibility trial: SinusBot 1.0.2 requires the official TS3 client 3.5.6 plugin API, not TS3 3.6.x.'
  curl --fail --location --retry 3 --connect-timeout 15 https://files.teamspeak-services.com/releases/client/3.5.6/TeamSpeak3-Client-linux_amd64-3.5.6.run -o "$BASE/teamspeak-client.run"
  echo 'The official TeamSpeak installer will show its license. Review it and accept in your own terminal if you agree.'
  (cd "$BASE"; bash teamspeak-client.run)
fi
# The upstream headless recipe disables this optional GLX integration. Keep
# the original file rather than deleting it, for an auditable local rollback.
GLX="$BASE/TeamSpeak3-Client-linux_amd64/xcbglintegrations/libqxcb-glx-integration.so"
if [[ -f "$GLX" && ! -e "$GLX.tsmd-disabled" ]]; then mv -- "$GLX" "$GLX.tsmd-disabled"; fi
mkdir -p "$BASE/TeamSpeak3-Client-linux_amd64/plugins" "$BASE/scripts"
cp "$BASE/plugin/libsoundbot_plugin.so" "$BASE/TeamSpeak3-Client-linux_amd64/plugins/"
cp "$2" "$BASE/scripts/tsmd-transport.js"
if [[ ! -f "$BASE/config.ini" ]]; then "$NODE" "$APP_DIR/src/server/configure-official-transport.mjs" --render-config "$APP_DIR"; fi
INSTALL_STAGE='Private bridge initialization'
grep -Eq '^ListenHost\s*=\s*"127\.0\.0\.1"\s*$' "$BASE/config.ini" || { echo 'Bridge must be bound to loopback. No audio switch performed.' >&2; exit 1; }
"$NODE" "$APP_DIR/src/server/configure-official-transport.mjs" --initialize "$APP_DIR"
cat > "$BASE/run.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$BASE"
printf '%s\n' \$\$ > "$APP_DIR/server-data/official.pid"
exec /usr/bin/xvfb-run -a -s '-screen 0 640x480x24 -nolisten tcp' "$BASE/sinusbot"
EOF
cat > "$BASE/service" <<EOF
[Unit]
Description=TS Music Bot official TS3 client audio bridge
After=network-online.target
Wants=network-online.target
PartOf=ts-music-desk.service
[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$BASE
ExecStart=/usr/bin/bash $BASE/run.sh
Restart=on-failure
RestartSec=5
KillMode=control-group
TimeoutStopSec=10
UMask=0077
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
EOF
sudo -n /usr/bin/install -m 644 "$BASE/service" /etc/systemd/system/ts-music-desk-official.service
INSTALL_STAGE='Private bridge startup'
sudo -n /usr/bin/systemctl daemon-reload
sudo -n /usr/bin/systemctl restart ts-music-desk-official.service
for attempt in {1..30}; do if curl --silent --fail --max-time 2 http://127.0.0.1:18087/api/v1/botId >/dev/null; then break; fi;sleep 1;done
"$NODE" "$APP_DIR/src/server/configure-official-transport.mjs" --bootstrap "$APP_DIR"
cp -a "$APP_DIR/server.env" "$BASE/before-switch.env"
restore(){ trap - ERR INT TERM;cp "$BASE/before-switch.env" "$APP_DIR/server.env";sudo -n /usr/bin/rm -f -- /etc/systemd/system/ts-music-desk.service.d/official-audio.conf || true;sudo -n /usr/bin/systemctl daemon-reload || true;sudo -n /usr/bin/systemctl stop ts-music-desk-official.service || true;sudo -n /usr/bin/systemctl restart ts-music-desk.service || true;echo 'Switch failed; previous audio selection restored.' >&2;exit 1; }
trap restore ERR INT TERM
INSTALL_STAGE='Selecting official audio backend'
"$NODE" "$APP_DIR/src/server/configure-official-transport.mjs" --official "$APP_DIR"
sudo -n /usr/bin/install -d -m 755 /etc/systemd/system/ts-music-desk.service.d
printf '[Unit]\nWants=ts-music-desk-official.service\nAfter=ts-music-desk-official.service\n' > "$BASE/drop-in"
sudo -n /usr/bin/install -m 644 "$BASE/drop-in" /etc/systemd/system/ts-music-desk.service.d/official-audio.conf
sudo -n /usr/bin/systemctl daemon-reload
sudo -n /usr/bin/systemctl restart ts-music-desk.service
bash "$APP_DIR/deploy/wait-server.sh"
trap - ERR INT TERM
echo 'Official-client backend selected. Refresh the owner console and connect/play a track for an A/B listening test.'
echo 'Pause/resume restores a saved position and may rebuffer. Client identity and permissions are separate from the old bot.'
echo 'Keep port 18087 private. No changes to your TeamSpeak server service were made.'
