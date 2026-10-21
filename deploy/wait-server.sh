#!/usr/bin/env bash
set -euo pipefail
for attempt in {1..30}; do
  code="$(curl --silent --output /dev/null --write-out '%{http_code}' --connect-timeout 1 --max-time 2 http://127.0.0.1:18080/api/admin/session || true)"
  if [[ "$code" == 401 ]]; then
    echo 'Music Desk owner login is ready.'
    exit 0
  fi
  if ! systemctl is-active --quiet ts-music-desk.service; then
    echo 'Music Desk service stopped before it became ready.' >&2
    echo 'Inspect: sudo journalctl -u ts-music-desk -n 60 --no-pager' >&2
    exit 1
  fi
  sleep 1
done
echo 'Music Desk did not become ready within the startup check window.' >&2
echo 'Inspect: sudo journalctl -u ts-music-desk -n 60 --no-pager' >&2
exit 1
