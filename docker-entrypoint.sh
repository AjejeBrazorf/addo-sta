#!/bin/sh
# Fly volumes mount root-owned on first boot: hand /app/data to node, then drop root for good.
# chown only touches metadata (cheap even for a big DB) and is skipped once node owns the volume.
set -e
if [ "$(id -u)" = 0 ]; then
  [ "$(stat -c %u /app/data)" = "$(id -u node)" ] || chown -R node:node /app/data
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
