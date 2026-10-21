#!/usr/bin/env bash
set -euo pipefail
ARCHIVE="${1:?Missing update archive}"
EXPECTED="${2:?Missing SHA256}"
[[ "$EXPECTED" =~ ^[a-f0-9]{64}$ ]] || exit 1
[[ "$(sha256sum "$ARCHIVE" | cut -d' ' -f1)" == "$EXPECTED" ]] || { echo 'Update archive checksum mismatch' >&2; exit 1; }
APP_DIR="$(systemctl show ts-music-desk.service -p WorkingDirectory --value)"
APP_DIR="$(realpath -e "$APP_DIR")"
case "$APP_DIR/" in "$HOME/"?*/) ;; *) echo 'Existing music service directory must be inside your home directory.' >&2; exit 1 ;; esac
[[ -x "$APP_DIR/runtime/node/bin/node" && -f "$APP_DIR/server-data/server-admin.json" ]] || { echo 'Finish the initial installation first.' >&2; exit 1; }
systemctl is-active --quiet ts-music-desk.service || { echo 'Music service is not running. Finish installation or resolve startup errors first.' >&2; exit 1; }
# Check the exact service operations, rather than `sudo -v`: a server may
# allow these commands without allowing a general sudo authentication refresh.
for operation in stop start; do
  if ! sudo -n -l -- /usr/bin/systemctl "$operation" ts-music-desk.service >/dev/null 2>&1; then
    echo 'Update stopped: ubuntu cannot manage the music service without a sudo password.' >&2
    echo 'No running program files were changed and the bot was not stopped.' >&2
    echo 'SSH keys authenticate SSH only. Ask the server administrator to enable passwordless sudo for:' >&2
    echo '  /usr/bin/systemctl stop ts-music-desk.service' >&2
    echo '  /usr/bin/systemctl start ts-music-desk.service' >&2
    echo 'Alternatively, an administrator can perform the update. Do not rerun the full installer.' >&2
    exit 20
  fi
done
STAGE="$(mktemp -d "$APP_DIR/runtime/code-update-XXXXXX")"
tar -tzf "$ARCHIVE" > "$STAGE/archive-list.txt"
while IFS= read -r name; do
  case "$name" in .|./|./src/|./dist/|./update-manifest.json|./src/server/|./src/server/*|./src/worker/|./src/worker/*|./src/shared/|./src/shared/*|./dist/ui/|./dist/ui/*|./vendor/|./vendor/teamspeak-music-bot-1.13.2/|./vendor/teamspeak-music-bot-1.13.2/dist/|./vendor/teamspeak-music-bot-1.13.2/dist/*) ;; *) echo 'Unexpected archive path' >&2; exit 1 ;; esac
  case "$name" in *../*|*\\*) echo 'Unsafe archive path' >&2; exit 1 ;; esac
done < "$STAGE/archive-list.txt"
if tar -tvzf "$ARCHIVE" | awk 'substr($0,1,1)!="-" && substr($0,1,1)!="d" {bad=1} END {exit !bad}'; then echo 'Archive links or special files are not allowed.' >&2; exit 1; fi
tar -xzf "$ARCHIVE" -C "$STAGE" --no-same-owner --no-same-permissions
"$APP_DIR/runtime/node/bin/node" --input-type=module - "$APP_DIR" "$STAGE" <<'NODE'
import{readFileSync,readdirSync,lstatSync}from'node:fs';import{resolve}from'node:path';import{createHash}from'node:crypto';
const[app,stage]=process.argv.slice(2),m=JSON.parse(readFileSync(resolve(stage,'update-manifest.json'))),hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
if(m.kind!=='tsmd-code-update')throw Error('Invalid update manifest');
for(const name of ['package-lock.json','vendor/teamspeak-music-bot-1.13.2/package-lock.json']){const actual=hash(resolve(app,name)),legacy=m.compatibleDependencies?.[name];const compatible=name==='package-lock.json'&&Array.isArray(legacy)&&legacy.every(value=>/^[a-f0-9]{64}$/.test(value))&&legacy.includes(actual);if(actual!==m.dependencies[name]&&!compatible)throw Error('Dependencies differ: use a full upgrade instead. No running files were changed.');}
for(const[name,digest]of Object.entries(m.files)){if(!/^(src\/(server|worker|shared)|dist\/ui|vendor\/teamspeak-music-bot-1\.13\.2\/dist)\//.test(name)||name.split('/').includes('..'))throw Error('Invalid manifest path');if(hash(resolve(stage,name))!==digest)throw Error('File checksum mismatch');}
for(const name of ['src/server/entry.mjs','src/server/admin-auth.mjs','src/worker/share-server.mjs','dist/ui/index.html'])if(!m.files[name])throw Error('Incomplete update');
function walk(dir,prefix){for(const entry of readdirSync(dir,{withFileTypes:true})){const name=prefix+'/'+entry.name,path=resolve(dir,entry.name);if(lstatSync(path).isSymbolicLink())throw Error('Links forbidden');if(entry.isDirectory())walk(path,name);else if(!m.files[name])throw Error('Unlisted update file');}}
for(const tree of ['src/server','src/worker','src/shared','dist/ui','vendor/teamspeak-music-bot-1.13.2/dist'])walk(resolve(stage,tree),tree);
NODE
BACKUP="$(mktemp -d "$APP_DIR/runtime/code-backup-XXXXXX")"
for tree in src/server src/worker src/shared dist/ui vendor/teamspeak-music-bot-1.13.2/dist; do mkdir -p "$BACKUP/$(dirname "$tree")"; cp -a "$APP_DIR/$tree" "$BACKUP/$tree"; done
rollback() {
  trap - ERR INT TERM
  echo 'Update failed; restoring previous program files.' >&2
  # Never overwrite live program files if the stop operation itself fails.
  if ! sudo -n /usr/bin/systemctl stop ts-music-desk.service; then
    echo "Cannot stop music service for recovery. Backup retained: $BACKUP" >&2
    exit 1
  fi
  for tree in src/server src/worker src/shared dist/ui vendor/teamspeak-music-bot-1.13.2/dist; do rm -rf -- "$APP_DIR/$tree"; cp -a "$BACKUP/$tree" "$APP_DIR/$tree"; done
  sudo -n /usr/bin/systemctl start ts-music-desk.service || true
  echo "Backup retained: $BACKUP" >&2
  exit 1
}
sudo -n /usr/bin/systemctl stop ts-music-desk.service
trap rollback ERR INT TERM
for tree in src/server src/worker src/shared dist/ui vendor/teamspeak-music-bot-1.13.2/dist; do rm -rf -- "$APP_DIR/$tree"; cp -a "$STAGE/$tree" "$APP_DIR/$tree"; done
sudo -n /usr/bin/systemctl start ts-music-desk.service
ready=0
for attempt in {1..30}; do
  code="$(curl --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 1 --max-time 2 http://127.0.0.1:18080/api/admin/session || true)"
  if [[ "$code" == 401 ]] && systemctl is-active --quiet ts-music-desk.service; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]]
trap - ERR INT TERM
echo "Update complete. Program backup: $BACKUP"
echo 'Refresh the console and sign in again. Config, playlists, password and music account were retained.'
echo 'The music bot was restarted; existing TeamSpeak server services were not changed.'
