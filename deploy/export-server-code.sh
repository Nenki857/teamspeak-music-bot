#!/usr/bin/env bash
set -euo pipefail
umask 077
APP_DIR="$(realpath -e "$(systemctl show ts-music-desk.service -p WorkingDirectory --value)")"
case "$APP_DIR/" in "$HOME/"?*/) ;; *) echo 'Music application must be inside the SSH user home directory.' >&2; exit 1 ;; esac
[[ -x "$APP_DIR/runtime/node/bin/node" && -f "${1:-}" && "${2:-}" =~ ^tsmd-source-[0-9]+-[0-9]+\.tar\.gz$ ]] || exit 1
"$APP_DIR/runtime/node/bin/node" "$1" "$APP_DIR" "$2"
