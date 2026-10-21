#!/usr/bin/env bash
set -euo pipefail
umask 077
ZIP="${1:?Missing browser component}"; ZIP_HASH="${2:?Missing component hash}"
UPDATE="${3:?Missing update}"; UPDATE_HASH="${4:?Missing update hash}"
UPDATER="${5:?Missing updater}"; CHECKER="${6:?Missing checker}"; ADAPTER="${7:?Missing adapter}"
[[ "$ZIP_HASH" =~ ^[a-f0-9]{64}$ && "$UPDATE_HASH" =~ ^[a-f0-9]{64}$ ]] || exit 1
[[ "$(sha256sum "$ZIP" | cut -d' ' -f1)" == "$ZIP_HASH" ]] || { echo 'Browser archive checksum mismatch.' >&2; exit 1; }
APP_DIR="$(realpath -e "$(systemctl show ts-music-desk.service -p WorkingDirectory --value)")"
case "$APP_DIR/" in "$HOME/"?*/) ;; *) echo 'Unexpected music service directory.' >&2; exit 1 ;; esac
NODE="$APP_DIR/runtime/node/bin/node"; TARGET="$APP_DIR/runtime/official-browser"
[[ -x "$NODE" && -f "$UPDATE" && -f "$UPDATER" && -f "$CHECKER" && -f "$ADAPTER" ]] || exit 1
echo 'Preparing an isolated official Chrome browser. No music API QR request is used.'
if [[ -e "$TARGET" ]]; then
  [[ ! -L "$TARGET" && -f "$TARGET/.tsmd-browser-sha256" && "$(cat "$TARGET/.tsmd-browser-sha256")" == "$ZIP_HASH" ]] || { echo 'An existing browser component differs; nothing was overwritten.' >&2; exit 1; }
else
  STAGE="$(mktemp -d "$APP_DIR/runtime/browser-component-XXXXXX")"
  python3 - "$ZIP" <<'PY'
import sys, zipfile, stat
with zipfile.ZipFile(sys.argv[1]) as archive:
    for item in archive.infolist():
        name = item.filename
        if not name.startswith('chrome-linux64/') or '\\' in name or '..' in name.split('/') or stat.S_ISLNK(item.external_attr >> 16):
            raise ValueError('Unsafe browser archive entry')
PY
  MISSING=()
  for package in unzip libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libx11-xcb1 libgtk-3-0 fonts-noto-cjk; do
    if [[ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null || true)" != 'install ok installed' ]]; then MISSING+=("$package"); fi
  done
  if [[ "${#MISSING[@]}" -gt 0 ]]; then
    echo 'Installing missing browser libraries/fonts only.'
    sudo -n apt-get update
    sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${MISSING[@]}"
  fi
  unzip -q "$ZIP" -d "$STAGE"
  [[ -x "$STAGE/chrome-linux64/chrome" ]] || chmod 700 "$STAGE/chrome-linux64/chrome"
  if ldd "$STAGE/chrome-linux64/chrome" | grep -q 'not found'; then echo 'Browser libraries are missing. The bot was not updated.' >&2; exit 1; fi
  printf '%s\n' "$ZIP_HASH" > "$STAGE/.tsmd-browser-sha256"
  mv -- "$STAGE" "$TARGET"
fi
"$TARGET/chrome-linux64/chrome" --version
echo 'Testing the actual browser and official page before updating the bot.'
"$NODE" "$CHECKER" "$APP_DIR" "$ADAPTER" > "$HOME/tsmd-official-browser-report.json" || { cat "$HOME/tsmd-official-browser-report.json"; exit 21; }
cat "$HOME/tsmd-official-browser-report.json"
bash "$UPDATER" "$UPDATE" "$UPDATE_HASH"
echo 'The real official browser is available in Music account -> Server official login.'
echo 'Open the official page, click Login, scan in the official NetEase app, then Save session.'
echo 'This installs login functionality. Search and playback must be checked after your login.'
