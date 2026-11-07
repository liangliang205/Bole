#!/usr/bin/env bash
# Linux production host. Extra arguments are passed to `docker compose`.
set -euo pipefail
cd "$(dirname "$0")/.."
compose_args=("$@")
mkdir -p backups
exec 9>backups/.backup.lock
flock -n 9 || { printf 'Another backup is running\n' >&2; exit 1; }
archive="bole-$(date -u +%Y%m%dT%H%M%SZ)-$$.tgz"
running=$(docker compose "${compose_args[@]}" ps --status running -q bole)
restart() {
  if [[ -n "$running" ]]; then docker compose "${compose_args[@]}" start bole; fi
}
trap restart EXIT
docker compose "${compose_args[@]}" stop bole
(
  umask 077
  docker compose "${compose_args[@]}" run --rm -T --no-deps --user 0:0 --entrypoint tar \
    bole -czf - -C /app data runs > "backups/$archive.partial"
)
mv -- "backups/$archive.partial" "backups/$archive"
sha256sum "backups/$archive" > "backups/$archive.sha256"
printf 'Backup: %s\n' "$PWD/backups/$archive"
