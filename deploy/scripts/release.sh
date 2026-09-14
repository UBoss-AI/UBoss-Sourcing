#!/usr/bin/env bash
# =============================================================================
# Build, migrate and roll out a release.
#
#   sudo -u uboss /srv/uboss/repo/deploy/scripts/release.sh
#
# Builds into a NEW timestamped directory, points `current` at it, and restarts
# the API instances ONE AT A TIME so the site stays up throughout. If anything
# fails before the symlink moves, the running site has not been touched.
#
# THE ONE THING THIS CANNOT DO FOR YOU
#
# Migrations run BEFORE the new code starts, which means that for the length of
# the rolling restart the OLD code is running against the NEW schema. That is
# fine for anything additive - a new table, a new nullable column, a new index -
# and it is not fine for a rename or a drop, which will throw on every request
# the old instances are still serving.
#
# So: additive migrations deploy with this script. A destructive change is two
# releases - add the new shape and write to both, deploy, then remove the old
# shape in a later release once nothing reads it. There is no way to automate
# that judgement, which is why it is written here instead.
# =============================================================================
set -Eeuo pipefail

ROOT=/srv/uboss
REPO="$ROOT/repo"
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
SHARED="$ROOT/shared"

# The API ports, and they must match `upstream uboss_api` in the nginx config
# and the enabled `uboss-api@` units. A port listed here that is not enabled
# makes this script hang waiting for a health check that will never pass.
API_PORTS=(4000 4001 4002)

# How long one instance gets to come back and answer /health/ready. Generous:
# the first request after a restart pays for Prisma's connection setup and the
# assistant's catalogue warm-up.
HEALTH_TIMEOUT=60

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

# Anything that fails past this point should say where, because a release that
# stops halfway is the one case where the message matters most.
trap 'die "failed at line $LINENO"' ERR

[[ -f "$SHARED/.env" ]] || die "no $SHARED/.env - copy backend/.env.example and fill it in first"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
RELEASE="$RELEASES/$STAMP"

# -----------------------------------------------------------------------------
# 1. Fetch
# -----------------------------------------------------------------------------
log "fetching"
cd "$REPO"
git fetch --all --prune
git reset --hard "${1:-origin/main}"
REVISION="$(git rev-parse --short HEAD)"
log "building $REVISION into $RELEASE"

mkdir -p "$RELEASE"

# -----------------------------------------------------------------------------
# 2. Build
#
# Everything is built BEFORE anything is swapped. A TypeScript error, a failing
# test or a missing dependency stops the release here, with the live site still
# serving the previous one and nothing to roll back.
#
# `npm ci` rather than `npm install`: it installs exactly the lockfile and
# fails if package.json and the lock disagree, which is the difference between
# a reproducible release and one that quietly picked up a new minor version of
# something at three in the morning.
# -----------------------------------------------------------------------------
log "building the API"
cd "$REPO/backend"
npm ci
npx prisma generate
npm run build

log "building the storefront"
cd "$REPO/apps/customer-web"
npm ci
npm run build

log "building the admin panel"
cd "$REPO/apps/admin-web"
npm ci
npm run build

# -----------------------------------------------------------------------------
# 3. Assemble the release directory
#
# Copied rather than symlinked into place, so a release is a complete, frozen
# snapshot: a rollback is one `ln -sfn` away and does not depend on the repo
# still being on that commit.
# -----------------------------------------------------------------------------
log "assembling"
mkdir -p "$RELEASE/backend" "$RELEASE/customer-web" "$RELEASE/admin-web" "$RELEASE/docs"

cp -r "$REPO/backend/dist"          "$RELEASE/backend/dist"
cp -r "$REPO/backend/node_modules"  "$RELEASE/backend/node_modules"
cp -r "$REPO/backend/prisma"        "$RELEASE/backend/prisma"
cp    "$REPO/backend/package.json"  "$RELEASE/backend/package.json"

cp -r "$REPO/apps/customer-web/dist/." "$RELEASE/customer-web/"
cp -r "$REPO/apps/admin-web/dist/."    "$RELEASE/admin-web/"

cp -r "$REPO/docs/." "$RELEASE/docs/" 2>/dev/null || true

echo "$REVISION" > "$RELEASE/REVISION"
date -u +%FT%TZ  > "$RELEASE/RELEASED_AT"

# -----------------------------------------------------------------------------
# 4. Migrate
#
# `migrate deploy`, never `migrate dev`. `dev` is interactive, will happily
# offer to reset the database, and generates new migration files - none of
# which belongs within a mile of production data.
# -----------------------------------------------------------------------------
log "running migrations"
cd "$RELEASE/backend"
set -a; . "$SHARED/.env"; set +a

# The runtime user is deliberately not allowed to change the schema.
#
# RUNBOOK.md §7 asks for an application user with SELECT/INSERT/UPDATE/DELETE
# and nothing else - no CREATE, no ALTER, no DROP - and with UPDATE and DELETE
# revoked on `audit_logs`, because an append-only audit trail that the
# application itself can rewrite is not an audit trail.
#
# That user cannot run a migration, so this step and only this step uses a
# second one. Put `MIGRATE_DATABASE_URL` in shared/.env pointing at a user with
# DDL rights; it is read here, used for one command, and never reaches the
# running application - `uboss-api@.service` starts from the same file but the
# application only ever reads `DATABASE_URL`.
#
# Leave it unset and migrations run as the application user, which works if you
# granted it everything. That is the weaker arrangement, and it is the default
# only because refusing to deploy would be worse than saying so here.
if [[ -n "${MIGRATE_DATABASE_URL:-}" ]]; then
  log "migrating as the schema-owning user"
  DATABASE_URL="$MIGRATE_DATABASE_URL" npx prisma migrate deploy
else
  warn "MIGRATE_DATABASE_URL is not set - migrating as the application user (see RUNBOOK.md §7)"
  npx prisma migrate deploy
fi

# -----------------------------------------------------------------------------
# 5. Swap
#
# `ln -sfn` onto a temporary name and then `mv` is the only form of this that
# is atomic. `ln -sfn` straight onto an existing symlink-to-a-directory creates
# the link INSIDE it instead, which produces `current/20260914-.../` and a
# site that 404s everything.
# -----------------------------------------------------------------------------
log "pointing current at $STAMP"
ln -sfn "$RELEASE" "$CURRENT.tmp"
mv -Tf "$CURRENT.tmp" "$CURRENT"

# -----------------------------------------------------------------------------
# 6. Rolling restart
#
# One instance at a time, each proved healthy before the next is touched. With
# three instances the site keeps two-thirds of its capacity throughout and
# nobody sees an error - nginx's `max_fails`/`fail_timeout` takes the restarting
# one out of rotation on its first refused connection.
# -----------------------------------------------------------------------------
for port in "${API_PORTS[@]}"; do
  log "restarting API on $port"
  systemctl restart "uboss-api@$port"

  deadline=$(( SECONDS + HEALTH_TIMEOUT ))
  until curl -fsS --max-time 3 "http://127.0.0.1:$port/health/ready" >/dev/null 2>&1; do
    (( SECONDS < deadline )) || die "API on $port did not become ready in ${HEALTH_TIMEOUT}s - the previous release is still linked at $CURRENT, roll back with rollback.sh"
    sleep 1
  done

  log "API on $port is ready"
done

log "restarting the worker"
systemctl restart uboss-worker

# -----------------------------------------------------------------------------
# 7. Tidy
#
# Five releases kept. Enough to roll back past a bad one and the one before it;
# each carries its own node_modules, so keeping thirty fills the disk.
# -----------------------------------------------------------------------------
log "pruning old releases"
cd "$RELEASES"
ls -1dt */ | tail -n +6 | xargs -r rm -rf

log "released $REVISION ($STAMP)"
