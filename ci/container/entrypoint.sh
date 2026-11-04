#!/bin/sh
set -eu
if [ "${1:-}" = node ]; then
  case "${2:-}" in
    /opt/deviceyard/dist/entry.js|/opt/deviceyard/dist/index.js)
      node /opt/deviceyard/container/validate-config.cjs
      adb start-server
      ;;
  esac
fi
exec "$@"
