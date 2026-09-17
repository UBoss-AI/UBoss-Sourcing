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

# -----------------------------------------------------------------------------
# One release at a time
#
# Two of these running together is not a slow deploy, it is a broken one: one
# swaps the `current` symlink while the other is still migrating, so the code
# being served and the schema underneath it come from different commits. A
# pushed hotfix on top of a release already in flight is exactly how that
# happens, and neither operator sees anything wrong until the site does.
#
# `flock -n` rather than a wait: the second release is redundant anyway - the
# first one is deploying the same branch - so failing fast and saying so is
# better than queueing a build nobody is watching.
#
# fd 9 stays open for the life of the script, so the lock is released by the
# kernel when this process ends, however it ends. A lock file holding a PID
# would survive a kill -9 and block every later deploy.
# -----------------------------------------------------------------------------
exec 9>"$SHARED/.release.lock"
flock -n 9 || die "another release is already running (lock: $SHARED/.release.lock)"

# -----------------------------------------------------------------------------
# Restarting a unit as the `uboss` user
#
# This script runs as `uboss`, which is a --system account with no shell and no
# business owning the machine. It cannot call `systemctl restart`; without the
# sudoers rule that bootstrap.sh installs, every release builds perfectly and
# then fails at the restart, having already moved the symlink.
#
# `sudo -n` - never prompt. There is no terminal here to answer a password
# prompt, so a missing rule must fail immediately with a message that names the
# file to create rather than hanging until the deploy times out.
#
# The rule lists each unit by name. `systemctl *` would let the service user
# stop, mask or start anything on the box, which is a large privilege to hand
# over for the sake of three restarts.
# -----------------------------------------------------------------------------
restart_unit() {
  local unit="$1"

  if [[ $EUID -eq 0 ]]; then
    systemctl restart "$unit"
  else
    sudo -n systemctl restart "$unit" \
      || die "cannot restart $unit as $(id -un). Install the sudoers rule - bootstrap.sh writes /etc/sudoers.d/uboss-release, and docs/DEPLOYMENT.md section 14.4 has it verbatim."
  fi
}

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

# -----------------------------------------------------------------------------
# Did the install actually build what it needed to?
#
# npm 11 - which is what Node 24 ships, and what bootstrap.sh installs - DOES
# NOT RUN A DEPENDENCY'S INSTALL SCRIPT UNLESS IT IS LISTED IN `allowScripts`
# in package.json. It skips it, prints a warning among a hundred other lines,
# and exits 0.
#
# Two of this project's dependencies are useless without theirs:
#
#   argon2           a native addon. No `node-gyp rebuild`, no binding, and
#                    every password hash and every sign-in throws.
#   @prisma/engines  downloads the query engine. Without it Prisma cannot
#                    open a connection.
#
# So a release can install cleanly, build cleanly, swap the symlink, and give
# you an API that cannot answer a single request. The two checks below cost a
# second and turn that into a release that stops before it touches anything.
#
# If one of these fails after a dependency bump, the approval lapsed: the keys
# in `allowScripts` name an exact version, deliberately, so a new version is
# reviewed rather than inherited. `npm install-scripts ls` lists what is
# waiting, and `approve <pkg>` records the decision.
# -----------------------------------------------------------------------------
node -e "require('argon2')" 2>/dev/null \
  || die "argon2 has no native binding - 'npm ci' skipped its build script. Run 'npm install-scripts ls' in backend/ and approve it, then release again."

npx prisma --version >/dev/null 2>&1 \
  || die "the Prisma engines are missing - 'npm ci' skipped @prisma/engines' postinstall. Same fix: 'npm install-scripts ls' in backend/."

npx prisma generate
npm run build

# -----------------------------------------------------------------------------
# The frontends, and the one setting that decides whether any of this works
#
# `VITE_API_BASE_URL` is BAKED INTO THE BUNDLE AT BUILD TIME. It is not read at
# runtime and it cannot be changed by editing .env afterwards - a wrong value
# means rebuilding.
#
# The repository commits `apps/*/.env` holding `http://localhost:4000/api/v1`,
# which is right for a developer and catastrophic here: this script builds from
# a fresh checkout, so without an override every visitor's browser is told to
# call the API on THEIR OWN machine. The site loads perfectly and nothing works.
#
# A shell variable wins over the committed .env file - that is Vite's own
# precedence, not a trick - so exporting it here is the whole fix. The values
# come from shared/.env, which is also where the API reads the origins it will
# accept through CORS, so the two cannot drift apart.
# -----------------------------------------------------------------------------
# Read ONE setting out of shared/.env, without exporting the whole file.
#
# `set -a; . .env` would put DATABASE_URL, the payment secrets and the ERP
# encryption key into the environment of `npm ci` and every install script it
# runs. A frontend build has no business seeing the database password, and a
# compromised dependency is exactly how that becomes somebody else's.
env_value() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$SHARED/.env" \
    | tail -n 1 \
    | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

build_frontend() {
  local name="$1" dir="$2" base="$3"

  [[ -n "$base" ]] || die "cannot build $name: its public URL is not set in $SHARED/.env"

  log "building $name against ${base%/}/api/v1"
  cd "$REPO/apps/$dir"
  npm ci
  VITE_API_BASE_URL="${base%/}/api/v1" npm run build

  # Source maps are generated deliberately (vite.config.ts) and are worth
  # uploading to an error tracker, but they must not be SERVED: they are the
  # complete TypeScript source of the admin console and the carrier portal,
  # including every route and permission name. Deleted after the build, before
  # the dist is copied into the release.
  #
  # The trailing `sourceMappingURL` comment goes too. Left behind it points at
  # a file that is no longer there, which costs a 404 in every developer
  # console that opens the site and tells a reader the maps exist somewhere.
  find dist -name '*.map' -delete
  find dist -name '*.js' -exec sed -i 's|^//# sourceMappingURL=.*$||' {} +
}

build_frontend "the storefront"  customer-web "$(env_value CUSTOMER_WEB_PUBLIC_URL)"
build_frontend "the admin panel" admin-web    "$(env_value ADMIN_WEB_PUBLIC_URL)"

# The carrier portal is optional - an installation with no third-party couriers
# never turns it on - so it is built only when it is switched on, and its
# absence from the release is then correct rather than an oversight.
if [[ "$(env_value FEATURE_LOGISTICS_PORTAL)" == "true" ]]; then
  build_frontend "the logistics portal" logistics-web "$(env_value LOGISTICS_WEB_PUBLIC_URL)"
else
  log "logistics portal is off (FEATURE_LOGISTICS_PORTAL) - not building it"
  rm -rf "$REPO/apps/logistics-web/dist"
fi

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

# NOT optional, and the reason is not obvious.
#
# Prisma 7 removed `url` from the schema's `datasource` block: the connection
# string is supplied by prisma.config.ts instead. Without this file the
# migration step below fails with "The datasource.url property is required in
# your Prisma config file", whatever DATABASE_URL is set to - so a release that
# builds perfectly dies at step 4, every time.
cp    "$REPO/backend/prisma.config.ts" "$RELEASE/backend/prisma.config.ts"

cp -r "$REPO/apps/customer-web/dist/." "$RELEASE/customer-web/"
cp -r "$REPO/apps/admin-web/dist/."    "$RELEASE/admin-web/"

if [[ -d "$REPO/apps/logistics-web/dist" ]]; then
  mkdir -p "$RELEASE/logistics-web"
  cp -r "$REPO/apps/logistics-web/dist/." "$RELEASE/logistics-web/"
fi

cp -r "$REPO/docs/." "$RELEASE/docs/" 2>/dev/null || true

echo "$REVISION" > "$RELEASE/REVISION"
date -u +%FT%TZ  > "$RELEASE/RELEASED_AT"

# -----------------------------------------------------------------------------
# What this release is, byte for byte
#
# Written before the symlink moves, so it describes the artifact as assembled
# rather than as it stands after somebody edited a file in `current/` to get
# through an incident. That is the question it answers months later: is what is
# being served still what was released?
#
#   cd /srv/uboss/current && sha256sum -c SHA256SUMS --quiet
#
# `node_modules` is excluded. It is ~40,000 files, it would take longer to hash
# than the rest of the release takes to build, and `npm ci` already guarantees
# it from the lockfile - which is itself in the manifest.
# -----------------------------------------------------------------------------
log "writing SHA256SUMS"
( cd "$RELEASE" && find . -type f \
    ! -path './backend/node_modules/*' \
    ! -name 'SHA256SUMS' \
    -exec sha256sum {} + > SHA256SUMS )

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

# -----------------------------------------------------------------------------
# NOTHING MIGRATES WITHOUT A RECENT BACKUP.
#
# A migration is the one step of a release that cannot be rolled back by
# swapping a symlink. `rollback.sh` restores the previous code; it does not and
# must not reverse a migration. So the only way back from a migration that
# turns out to be wrong is a restore, and a restore needs a backup that is
# newer than the mistake.
#
# Checked here rather than trusted, because the failure mode of a backup timer
# that stopped three weeks ago is total silence. `uboss-backup.timer` running
# and `a backup existing` are different facts.
#
# The check is skipped when there is nothing to migrate: a code-only release
# does not need one.
# -----------------------------------------------------------------------------
BACKUP_MAX_AGE_HOURS="${UBOSS_BACKUP_MAX_AGE_HOURS:-30}"   # a nightly job, plus slack
PENDING="$(DATABASE_URL="${MIGRATE_DATABASE_URL:-$DATABASE_URL}" \
             npx prisma migrate status 2>&1 || true)"

if printf '%s' "$PENDING" | grep -qi 'not yet been applied\|following migration'; then
  log "this release has migrations to apply - checking the backup first"

  NEWEST="$(find "$ROOT/backups" -maxdepth 1 -name 'db-*.sql.gz*' -type f -printf '%T@ %p\n' 2>/dev/null \
              | sort -rn | head -1 | cut -d' ' -f2- || true)"

  if [[ -z "$NEWEST" ]]; then
    die "there are migrations to apply and NO database backup exists in $ROOT/backups.
   A migration cannot be rolled back by rollback.sh - only restored from. Run:
       sudo systemctl start uboss-backup.service
   and check it succeeded before releasing. To release anyway, knowing that a
   bad migration would be unrecoverable:  UBOSS_SKIP_BACKUP_CHECK=1"
  fi

  AGE_HOURS=$(( ( $(date +%s) - $(stat -c %Y "$NEWEST") ) / 3600 ))
  if (( AGE_HOURS > BACKUP_MAX_AGE_HOURS )); then
    if [[ "${UBOSS_SKIP_BACKUP_CHECK:-}" == "1" ]]; then
      warn "the newest backup is ${AGE_HOURS}h old and UBOSS_SKIP_BACKUP_CHECK=1 was set - continuing"
    else
      die "the newest database backup is ${AGE_HOURS} hours old ($(basename "$NEWEST")),
   and this release has migrations to apply. The backup timer has probably
   stopped - check 'systemctl status uboss-backup.timer' and its last run.
   Take one now:  sudo systemctl start uboss-backup.service
   To release anyway:  UBOSS_SKIP_BACKUP_CHECK=1"
    fi
  else
    log "newest backup is ${AGE_HOURS}h old ($(basename "$NEWEST")) - proceeding"
  fi
else
  log "no migrations pending - skipping the backup check"
fi

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

# A NEW TABLE ARRIVES WITH NO GRANT ON IT.
#
# The application's UPDATE and DELETE rights are held per table, because that
# is the only way MariaDB will let `audit_logs` be excluded from them - a
# privilege granted at database level cannot be revoked at table level. The
# consequence is that a migration which creates a table leaves the application
# unable to write to it, and the symptom is a feature that works in CI and in
# the compatibility container and fails in production with
#
#   ERROR 1142 (42000): UPDATE command denied to user 'uboss_app'@'localhost'
#
# So this runs after every migration, not only the ones that added a table. It
# is idempotent, it takes under a second, and it prints which tables it left
# append-only.
# Invoked through `bash` rather than executed directly: every script in
# deploy/scripts/ is committed mode 644, because the repository is developed on
# Windows where git does not track the executable bit. Running it as
# `./apply-grants.sh` would work on a machine where somebody had chmod'd it and
# fail on a fresh checkout, which is the worst of both.
if [[ -f "$RELEASE/deploy/scripts/apply-grants.sh" ]]; then
  log "re-applying per-table grants"
  bash "$RELEASE/deploy/scripts/apply-grants.sh"
else
  warn "deploy/scripts/apply-grants.sh is missing from this release - a migration that
   added a table has left the application unable to write to it, and audit_logs
   may not be append-only. See docs/DATABASE-PRODUCTION.md section 6."
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
  restart_unit "uboss-api@$port"

  deadline=$(( SECONDS + HEALTH_TIMEOUT ))
  until curl -fsS --max-time 3 "http://127.0.0.1:$port/health/ready" >/dev/null 2>&1; do
    (( SECONDS < deadline )) || die "API on $port did not become ready in ${HEALTH_TIMEOUT}s - the previous release is still linked at $CURRENT, roll back with rollback.sh"
    sleep 1
  done

  log "API on $port is ready"
done

log "restarting the worker"
restart_unit uboss-worker

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
