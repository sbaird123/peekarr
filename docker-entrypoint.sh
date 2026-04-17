#!/bin/sh
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# Align the `node` user with the requested uid/gid so files under /config end
# up owned by the host user the operator expects (LinuxServer.io pattern).
if [ "$(id -u node)" != "$PUID" ] || [ "$(id -g node)" != "$PGID" ]; then
  groupmod -o -g "$PGID" node
  usermod  -o -u "$PUID" -g "$PGID" node
fi

chown -R node:node /config /app 2>/dev/null || true

exec su-exec node:node "$@"
