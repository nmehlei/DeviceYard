#!/bin/sh
set -eu
if [ "${1:-}" = node ] && [ "${2:-}" = /opt/deviceyard/dist/entry.js ]; then
  node /opt/deviceyard/container/validate-config.cjs
  adb start-server
fi
exec "$@"
