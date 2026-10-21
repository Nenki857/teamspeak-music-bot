#!/usr/bin/env bash
set -euo pipefail
if [[ $(uname -m) != x86_64 || $(id -u) == 0 ]]; then
  echo 'Deployment requires an unprivileged x86_64 Linux user with sudo access.' >&2
  exit 1
fi
command -v systemctl >/dev/null
command -v sudo >/dev/null
command -v ss >/dev/null
if ! sudo -n -l -- /usr/bin/apt-get update >/dev/null 2>&1; then
  echo 'Installation requires existing passwordless sudo. SSH key login does not grant sudo.' >&2
  echo 'No installation was started. Ask the server administrator to install or configure sudo access.' >&2
  exit 20
fi
if systemctl is-active --quiet ts-music-desk.service; then
  echo 'An existing Music Desk service is active. Stop here and follow the upgrade guide.' >&2
  exit 1
fi
if [[ -n $(ss -H -ltn 'sport = :18080') ]]; then
  echo 'TCP port 18080 is already in use. No installation has been performed.' >&2
  exit 1
fi
echo '--- Read-only deployment checks ---'
id
uname -m
free -h
df -h "$HOME"
echo '--- Listening ports (existing TS services stay untouched) ---'
ss -lntu
echo 'Read-only checks passed.'
