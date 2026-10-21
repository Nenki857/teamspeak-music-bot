#!/usr/bin/env bash
set -euo pipefail
umask 077
APP_DIR="$(realpath -e "$(systemctl show ts-music-desk.service -p WorkingDirectory --value)")"
case "$APP_DIR/" in "$HOME/"?*/) ;; *) echo 'Unexpected music service directory.' >&2; exit 1 ;; esac
[[ -x "$APP_DIR/runtime/node/bin/node" && -f "${1:-}" ]] || exit 1
exec "$APP_DIR/runtime/node/bin/node" "$1" "$APP_DIR"
