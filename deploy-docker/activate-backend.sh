#!/usr/bin/env bash
# Installed root-owned; called only after archive/checksum/path validation.
set -Eeuo pipefail
work="$1"
sha="$2"
root=/srv/gloviaa
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$work" == /var/lib/uboss-deploy/work.* ]] || exit 2
image="gloviaa-api:$sha"
previous="$work/compose.previous.yml"
cp "$root/compose.yml" "$previous"
cp "$root/Dockerfile.api" "$root/bootstrap.mjs" "$root/media-proxy.mjs" "$work/"
docker build --label "org.opencontainers.image.revision=$sha" -t "$image" -f "$work/Dockerfile.api" "$work"
printf 'services:\n  api:\n    image: %s\n' "$image" > "$work/newimage.yml"
docker compose -f "$root/compose.yml" -f "$work/newimage.yml" run --rm --no-deps api node --input-type=module -e 'await import("./dist/config/env.js"); console.log("Production configuration validated")'
bash "$root/backup.sh"
swapped=0
worker_stopped=0
rollback() {
  local status=$?
  if (( status != 0 )); then
    if (( swapped )); then
      cp "$previous" "$root/compose.yml"
      docker compose -f "$root/compose.yml" up -d --no-deps --no-build api worker media || true
      echo 'Application image reverted. Applied database migrations were not reversed.' >&2
    elif (( worker_stopped )); then
      docker compose -f "$root/compose.yml" start worker || true
    fi
  fi
  return "$status"
}
trap rollback EXIT
docker compose -f "$root/compose.yml" stop worker
worker_stopped=1
migrate_url=$(python3 -c 'import json; print(json.loads(open("/srv/gloviaa/migration.env").read().split("=",1)[1]))')
docker run --rm --network host -e DATABASE_URL="$migrate_url" "$image" npx prisma migrate deploy
unset migrate_url
root_password=$(cat "$root/db-root-password")
{ printf "SET @app_user='uboss_app'; SET @app_host='%%'; SET @maint_user='uboss_maintenance'; SET @maint_host='%%';\n"; cat "$root/post-migrate-grants.sql"; } |
  docker exec -i -e MYSQL_PWD="$root_password" gloviaa-db-1 mariadb -uroot -N -B gloviaa > "$work/grants.sql"
docker exec -i -e MYSQL_PWD="$root_password" gloviaa-db-1 mariadb -uroot gloviaa < "$work/grants.sql"
cp "$work/grants.sql" "$root/grants.sql"
unset root_password
python3 - "$root/compose.yml" "$image" <<'PY'
from pathlib import Path
import re, sys
path = Path(sys.argv[1])
text, count = re.subn(r'image: gloviaa-api:[a-zA-Z0-9_.-]+', 'image: ' + sys.argv[2], path.read_text())
if count != 3: raise SystemExit('Expected exactly three Gloviaa application images')
path.write_text(text)
PY
swapped=1
docker compose -f "$root/compose.yml" up -d --no-deps --no-build api worker media
for attempt in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:4004/health/ready >/dev/null; then
    rsync -a --delete "$work/backend/" "$root/backend/"
    trap - EXIT
    echo "API and worker ready: $sha"
    exit 0
  fi
  sleep 2
done
echo 'New API did not become ready within 120 seconds' >&2
exit 1
