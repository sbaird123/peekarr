#!/bin/sh
set -e

PUID=${PUID:-1000}
PGID=${PGID:-1000}

# Align the `node` user with the requested uid/gid so files the app creates
# under /config end up owned by the host user the operator expects
# (LinuxServer.io pattern).
if [ "$(id -u node)" != "$PUID" ] || [ "$(id -g node)" != "$PGID" ]; then
  groupmod -o -g "$PGID" node
  usermod  -o -u "$PUID" -g "$PGID" node
fi

# Only /config ever gets written to — don't recursively chown /app, node_modules
# has thousands of files and on ZFS-backed storage (TrueNAS) that takes minutes.
# The app reads /app fine as an unprivileged user via default world-read perms.
# Skip the chown entirely when ownership is already right (fast restarts).
current_owner=$(stat -c '%u:%g' /config 2>/dev/null || echo '')
if [ "$current_owner" != "$PUID:$PGID" ]; then
  chown -R "$PUID:$PGID" /config 2>/dev/null || true
fi

exec su-exec node:node "$@"
