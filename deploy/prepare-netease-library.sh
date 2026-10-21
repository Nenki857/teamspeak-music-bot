#!/usr/bin/env bash
set -euo pipefail
umask 077
ARCHIVE="${1:?Missing library archive}"
EXPECTED="${2:?Missing library checksum}"
REPAIR="${3:?Missing repair script}"
CHECKER="${4:?Missing checker}"
ADAPTER="${5:?Missing request adapter}"
UPDATE="${6:?Missing program archive}"
UPDATE_HASH="${7:?Missing program checksum}"
UPDATER="${8:?Missing updater}"
SOURCE_IP="${9:-}"
[[ "$EXPECTED" =~ ^[a-f0-9]{64}$ && "$(sha256sum "$ARCHIVE" | cut -d' ' -f1)" == "$EXPECTED" ]] || { echo 'Library archive checksum mismatch.' >&2; exit 1; }
APP_DIR="$(realpath -e "$(systemctl show ts-music-desk.service -p WorkingDirectory --value)")"
case "$APP_DIR/" in "$HOME/"?*/) ;; *) echo 'Unexpected music service directory.' >&2; exit 1 ;; esac
NODE="$APP_DIR/runtime/node/bin/node"
if [[ -n "$SOURCE_IP" ]]; then
  [[ "$SOURCE_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || { echo 'Invalid server source address.' >&2; exit 1; }
"$NODE" --input-type=module - "$APP_DIR" "$SOURCE_IP" <<'SOURCE_CHECK'
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { validateNeteaseSourceIP } = await import(pathToFileURL(resolve(process.argv[2], 'src/worker/netease-library.mjs')));
validateNeteaseSourceIP(process.argv[3]);
SOURCE_CHECK
fi
TARGET="$APP_DIR/runtime/netease-api-4.41.1"
if [[ -e "$TARGET" ]]; then
  [[ ! -L "$TARGET" ]] || { echo 'Library target must not be a symbolic link.' >&2; exit 1; }
  [[ -f "$TARGET/.tsmd-archive-sha256" && "$(cat "$TARGET/.tsmd-archive-sha256")" == "$EXPECTED" ]] || { echo 'Existing library directory differs. Nothing was replaced.' >&2; exit 1; }
else
  STAGE="$(mktemp -d "$APP_DIR/runtime/music-api-check-XXXXXX")"
  tar -tzf "$ARCHIVE" > "$STAGE/archive-list.txt"
  while IFS= read -r name; do
    case "$name" in .|./|./node_modules/|./node_modules/*|./package.json|./package-lock.json) ;; *) echo 'Unexpected library archive path.' >&2; exit 1 ;; esac
    case "$name" in *../*|*/..|..|*\\*) echo 'Unsafe library archive path.' >&2; exit 1 ;; esac
  done < "$STAGE/archive-list.txt"
  if tar -tvzf "$ARCHIVE" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {bad=1} END {exit !bad}'; then echo 'Archive links and special files are forbidden.' >&2; exit 1; fi
  tar -xzf "$ARCHIVE" -C "$STAGE" --no-same-owner --no-same-permissions
  "$NODE" --input-type=module - "$STAGE" <<'NODE'
import{readFileSync}from'node:fs';import{resolve}from'node:path';
const directory=process.argv[2],pkg=JSON.parse(readFileSync(resolve(directory,'node_modules/@neteasecloudmusicapienhanced/api/package.json')));
if(pkg.name!=='@neteasecloudmusicapienhanced/api'||pkg.version!=='4.41.1')throw Error('Unexpected library version');
NODE
  printf '%s\n' "$EXPECTED" > "$STAGE/.tsmd-archive-sha256"
  mv -- "$STAGE" "$TARGET"
fi
echo 'Maintained API 4.41.1 is staged separately; the original API library remains intact.'
MODE=maintained
if [[ -n "$SOURCE_IP" ]]; then MODE=maintained-ip; fi
exec bash "$REPAIR" "$CHECKER" "$ADAPTER" "$UPDATE" "$UPDATE_HASH" "$UPDATER" "$HOME/tsmd-music-repair-report.json" "$MODE" "$SOURCE_IP"
