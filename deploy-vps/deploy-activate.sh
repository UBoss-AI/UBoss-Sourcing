#!/usr/bin/env bash
# =============================================================================
# deploy-activate - the ONLY program the GitHub deploy key can run.
#
# Installed by deploy-vps/setup-deploy-user.sh to /srv/uboss/bin/deploy-activate
# and named as the forced command in /home/deploy/.ssh/authorized_keys:
#
#   restrict,command="/srv/uboss/bin/deploy-activate" ssh-ed25519 AAAA... github-deploy
#
# sshd runs this for EVERY connection made with that key, whatever the client
# asked for. What the client asked for arrives in $SSH_ORIGINAL_COMMAND and is
# treated as a request, never as a shell line. Exactly three requests exist:
#
#   receive uboss-<40 hex>.tgz          upload the release (stdin -> incoming/)
#   receive uboss-<40 hex>.tgz.sha256   upload its checksum (stdin -> incoming/)
#   activate uboss-<40 hex>.tgz         verify, unpack, migrate, swap, restart
#
# Anything else - a shell, scp, sftp, an extra space - is refused. scp and sftp
# cannot work through a forced command anyway (sshd replaces them with this
# program), which is why the workflow streams the file over stdin instead.
#
# TWO STAGES, TWO USERS
#
#   stage 1  runs as `deploy`. Parses the request, writes uploads into
#            /srv/uboss/incoming, checks the sha256, then hands over with
#              sudo -n -u uboss /srv/uboss/bin/deploy-activate --stage2 <file>
#   stage 2  runs as `uboss`, the service user that already owns the releases
#            and can read shared/.env. Everything else happens here.
#
# Stage 2 needs root for exactly two things - restarting the named units and
# re-applying the database grants - and gets them through the sudoers drop-in
# that setup-deploy-user.sh writes, one exact command per line.
#
# The release steps are the same as deploy/scripts/release.sh, minus the build
# (GitHub Actions built the artifact): one-release-at-a-time lock, backup gate,
# `prisma migrate deploy` as MIGRATE_DATABASE_URL, per-table grants, atomic
# symlink swap, one API instance at a time with a /health/ready wait, worker,
# keep five releases. Added here: if anything fails AFTER the swap, `current`
# goes back to the previous release and everything is restarted on it.
#
# It never prints a value from shared/.env and never uses `set -x`.
# =============================================================================
set -Eeuo pipefail
umask 027

ROOT=/srv/uboss
INCOMING="$ROOT/incoming"
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
SHARED="$ROOT/shared"
SELF=/srv/uboss/bin/deploy-activate

# Root-owned wrapper around deploy/scripts/apply-grants.sh (see setup script).
GRANTS_WRAPPER=/usr/local/lib/uboss/apply-grants

# Must match `upstream uboss_api` in the nginx config and the enabled units.
API_PORTS=(4000 4001 4002)
HEALTH_TIMEOUT=120
KEEP_RELEASES=5

# An artifact is ~100 MB. Anything far larger is not ours.
MAX_UPLOAD_BYTES=$(( 1024 * 1024 * 1024 ))

BACKUP_MAX_AGE_HOURS=30   # a nightly job, plus slack - same as release.sh

NAME_RE='^uboss-[0-9a-f]{40}\.tgz$'
SUM_RE='^uboss-[0-9a-f]{40}\.tgz\.sha256$'

log()  { printf '==> %s\n' "$*"; logger -t uboss-deploy -- "$*" 2>/dev/null || true; }
warn() { printf '!!  %s\n' "$*" >&2; logger -t uboss-deploy -- "WARN $*" 2>/dev/null || true; }
die()  { printf 'xx  %s\n' "$*" >&2; logger -t uboss-deploy -- "FAIL $*" 2>/dev/null || true; exit 1; }

# =============================================================================
# Stage 1 - as `deploy`
# =============================================================================
receive() {
  local name="$1" tmp
  [[ -d "$INCOMING" && -w "$INCOMING" ]] || die "$INCOMING is missing or not writable - run setup-deploy-user.sh"

  tmp="$(mktemp "$INCOMING/.partial.XXXXXX")"
  # head -c caps the size; one byte over the cap means the upload was too big.
  head -c "$(( MAX_UPLOAD_BYTES + 1 ))" > "$tmp"
  if (( $(stat -c %s "$tmp") > MAX_UPLOAD_BYTES )); then
    rm -f "$tmp"
    die "upload larger than $MAX_UPLOAD_BYTES bytes - refused"
  fi
  chmod 640 "$tmp"
  mv -f "$tmp" "$INCOMING/$name"
  log "received $name ($(stat -c %s "$INCOMING/$name") bytes)"
}

verify_checksum() {
  local name="$1" expected actual
  [[ -f "$INCOMING/$name" ]]        || die "no $name in $INCOMING - upload it first"
  [[ -f "$INCOMING/$name.sha256" ]] || die "no $name.sha256 in $INCOMING - upload it first"

  # The .sha256 file is `<64 hex>  <name>`. Only the hash is trusted from it;
  # the file name in it is ignored, so it cannot point at some other file.
  expected="$(head -c 200 "$INCOMING/$name.sha256" | awk 'NR==1{print $1}')"
  [[ "$expected" =~ ^[0-9a-f]{64}$ ]] || die "$name.sha256 does not hold a sha256"
  actual="$(sha256sum "$INCOMING/$name" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || die "checksum mismatch for $name - refusing to activate"
  log "checksum ok for $name"
}

stage1() {
  local request="${SSH_ORIGINAL_COMMAND:-}"
  local verb arg extra

  [[ -n "$request" ]] || die "no command given. Allowed: 'receive <file>', 'activate <file>'"
  # Reject anything that is not plain printable ASCII before splitting it.
  [[ "$request" =~ ^[a-z]+\ [A-Za-z0-9.-]+$ ]] || die "request refused"
  read -r verb arg extra <<<"$request"
  [[ -z "${extra:-}" ]] || die "request refused"

  case "$verb" in
    receive)
      if [[ "$arg" =~ $NAME_RE || "$arg" =~ $SUM_RE ]]; then
        receive "$arg"
      else
        die "request refused"
      fi
      ;;
    activate)
      [[ "$arg" =~ $NAME_RE ]] || die "request refused"
      verify_checksum "$arg"
      # Not exec: the upload is removed afterwards by its owner, `deploy`
      # (`uboss` can read incoming/ but not delete from it).
      local rc=0
      sudo -n -u uboss "$SELF" --stage2 "$arg" || rc=$?
      if (( rc == 0 )); then
        rm -f -- "$INCOMING/$arg" "$INCOMING/$arg.sha256"
      fi
      # Leftovers of failed attempts older than a week.
      find "$INCOMING" -maxdepth 1 -type f -mtime +7 -delete 2>/dev/null || true
      exit "$rc"
      ;;
    *)
      die "request refused"
      ;;
  esac
}

# =============================================================================
# Stage 2 - as `uboss`
# =============================================================================
# Returns non-zero rather than exiting, so a failed restart reaches the
# automatic rollback below instead of ending the script on the new release.
restart_unit() {
  sudo -n /usr/bin/systemctl restart "$1" && return 0
  warn "cannot restart $1 - is /etc/sudoers.d/uboss-deploy-vps installed?"
  return 1
}

wait_ready() {
  local port="$1" deadline=$(( SECONDS + HEALTH_TIMEOUT ))
  until curl -fsS --max-time 3 "http://127.0.0.1:$port/health/ready" >/dev/null 2>&1; do
    (( SECONDS < deadline )) || return 1
    sleep 2
  done
}

rolling_restart() {
  local port
  for port in "${API_PORTS[@]}"; do
    log "restarting API on $port"
    restart_unit "uboss-api@$port" || return 1
    wait_ready "$port" || { warn "API on $port did not answer /health/ready within ${HEALTH_TIMEOUT}s"; return 1; }
    log "API on $port is ready"
  done
  log "restarting the worker"
  restart_unit uboss-worker || return 1
}

# Read ONE setting from shared/.env without exporting the file - release.sh's
# env_value(), same reason: npm ci must not see the database password.
env_value() {
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$SHARED/.env" \
    | tail -n 1 \
    | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# `prisma migrate <status|deploy>` as the schema-owning user (release.sh step 4).
# shared/.env is loaded ONLY inside this subshell, after `npm ci` has finished,
# so no install script ever sees a secret. Nothing from it is printed.
migrate_cmd() {
  local release="$1" action="$2"
  (
    cd "$release/backend" || exit 1
    set -a
    # shellcheck source=/dev/null
    . "$SHARED/.env"
    set +a
    if [[ -n "${MIGRATE_DATABASE_URL:-}" ]]; then
      DATABASE_URL="$MIGRATE_DATABASE_URL" npx --no-install prisma migrate "$action"
    else
      [[ "$action" == deploy ]] && echo "!!  MIGRATE_DATABASE_URL is not set - migrating as the application user" >&2
      npx --no-install prisma migrate "$action"
    fi
  )
}

newest_backup_age_hours() {
  local newest
  newest="$(find "$ROOT/backups" -maxdepth 1 -name 'db-*.sql.gz*' -type f -printf '%T@ %p\n' 2>/dev/null \
              | sort -rn | head -1 | cut -d' ' -f2- || true)"
  [[ -n "$newest" ]] || { echo -1; return; }
  echo $(( ( $(date +%s) - $(stat -c %Y "$newest") ) / 3600 ))
}

stage2() {
  local name="$1" sha short stamp release previous age

  [[ "$name" =~ $NAME_RE ]] || die "request refused"
  [[ "$(id -un)" == "uboss" ]] || die "stage 2 must run as uboss"
  [[ -f "$SHARED/.env" ]] || die "no $SHARED/.env"
  # sudo's environment is minimal; npm needs a HOME it can write its cache in.
  HOME="$(getent passwd uboss | cut -d: -f6)"; export HOME
  # Release files must be readable by nginx (www-data): 755 dirs, 644 files.
  umask 022

  # Same lock file as release.sh and rollback.sh, so none of the three can run
  # while another is mid-flight.
  exec 9>"$SHARED/.release.lock"
  flock -n 9 || die "another release or rollback is running (lock: $SHARED/.release.lock)"

  # The checksum again: stage 1 checked it as `deploy`, and the file could have
  # been replaced between then and now by another upload.
  verify_checksum "$name"

  # Production uploads fail closed without ClamAV - checked before anything moves.
  [[ "$(env_value MALWARE_SCANNER_DRIVER)" == "clamav" ]] || die "MALWARE_SCANNER_DRIVER must be clamav in $SHARED/.env"
  local clam; clam="$(env_value MALWARE_SCANNER_SOCKET)"; clam="${clam:-/run/clamav/clamd.ctl}"
  [[ -S "$clam" ]] || die "ClamAV socket is not ready at $clam"

  if [[ -e "$CURRENT" && ! -L "$CURRENT" ]]; then
    die "$CURRENT is a real folder, not a link to a release. Switch to the release layout first (deploy-vps/README.md, Step 1)."
  fi

  sha="${name#uboss-}"; sha="${sha%.tgz}"; short="${sha:0:12}"
  stamp="$(date -u +%Y%m%d-%H%M%S)-$short"
  release="$RELEASES/$stamp"
  previous="$(readlink -f "$CURRENT" 2>/dev/null || true)"

  # A release directory that never went live is deleted on the way out, so
  # rollback.sh ("the newest release that is not current") can never pick a
  # half-unpacked or failed one.
  # shellcheck disable=SC2034  # read by the EXIT trap below
  SWAPPED=0
  RELEASE_DIR="$release"
  trap 'rc=$?; if (( rc != 0 && SWAPPED == 0 )); then rm -rf -- "$RELEASE_DIR" "$RELEASE_DIR.unpack"; fi' EXIT

  # --- Unpack ---------------------------------------------------------------
  # The archive is checksummed, but its paths are still checked: nothing
  # absolute, nothing with `..`, nothing outside the five expected roots.
  log "unpacking $short into $release"
  if tar -tzf "$INCOMING/$name" | grep -Ev '^(backend(/|$)|apps/?$|apps/(customer-web|admin-web|logistics-web|audit-web)(/|$))' | grep -q .; then
    die "the archive holds paths outside backend/ and apps/*/ - refused"
  fi
  if tar -tzf "$INCOMING/$name" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
    die "the archive holds an absolute or .. path - refused"
  fi

  local stage="$release.unpack"
  rm -rf "$stage"; mkdir -p "$stage" "$release"
  tar -xzf "$INCOMING/$name" -C "$stage" --no-same-owner --no-same-permissions

  # Lay out the release the way nginx and systemd expect it:
  #   backend/  customer-web/  admin-web/  logistics-web/  audit-web/
  # The last two are optional: each is built only when its feature is on.
  [[ -f "$stage/backend/dist/http/server.js" ]] || die "the archive has no backend/dist/http/server.js"
  mv "$stage/backend" "$release/backend"
  local app
  for app in customer-web admin-web logistics-web audit-web; do
    if [[ -d "$stage/apps/$app/dist" ]]; then
      mv "$stage/apps/$app/dist" "$release/$app"
    elif [[ "$app" != logistics-web && "$app" != audit-web ]]; then
      die "the archive has no apps/$app/dist"
    fi
  done
  rm -rf "$stage"
  echo "$sha" > "$release/REVISION"
  date -u +%FT%TZ > "$release/RELEASED_AT"

  # --- Install --------------------------------------------------------------
  # Full `npm ci` first: the Prisma CLI that runs the migration is a
  # devDependency. Dev packages are pruned straight after the migration, so
  # the release that is served has production dependencies only.
  log "installing backend dependencies"
  ( cd "$release/backend" && npm ci --no-audit --no-fund )

  # npm 11 skips install scripts not listed in allowScripts and exits 0. Same
  # two checks as release.sh: without them a release installs cleanly and then
  # cannot hash a password or open a database connection.
  ( cd "$release/backend" && node -e "require('argon2')" >/dev/null 2>&1 ) \
    || die "argon2 has no native binding - its install script did not run ('npm install-scripts ls' in backend/)"
  ( cd "$release/backend" && npx --no-install prisma --version >/dev/null 2>&1 ) \
    || die "the Prisma engines are missing - '@prisma/engines' postinstall did not run"

  # --- Backup gate, then migrate (release.sh steps 4) -----------------------
  # Fail-safe: anything other than Prisma saying "up to date" - including the
  # status command itself failing - counts as "there are migrations", so the
  # backup is required. `migrate deploy` then runs every time (a no-op when
  # nothing is pending), exactly as release.sh does.
  local status_out pending=1
  status_out="$(migrate_cmd "$release" status 2>&1 || true)"
  if printf '%s' "$status_out" | grep -qi 'Database schema is up to date'; then
    pending=0
  fi

  if (( pending )); then
    log "this release has migrations to apply - checking the backup first"
    age="$(newest_backup_age_hours)"
    if (( age < 0 || age > BACKUP_MAX_AGE_HOURS )); then
      log "no backup newer than ${BACKUP_MAX_AGE_HOURS}h - taking one now"
      sudo -n /usr/bin/systemctl start uboss-backup.service \
        || die "the backup failed. Nothing has been changed. Check: journalctl -u uboss-backup -n 50"
      age="$(newest_backup_age_hours)"
      (( age >= 0 && age <= BACKUP_MAX_AGE_HOURS )) \
        || die "the backup ran but no fresh db-*.sql.gz* is in $ROOT/backups. Nothing has been changed."
    fi
    log "newest backup is ${age}h old - migrating"
  else
    log "no migrations pending - skipping the backup check"
  fi

  migrate_cmd "$release" deploy \
    || die "migration failed. The site is still on the previous release. Restore from the backup only if the migration half-applied."

  # A new table arrives with no UPDATE/DELETE grant for the application, so the
  # grants are re-applied after every release, migration or not (idempotent).
  log "re-applying per-table grants"
  sudo -n "$GRANTS_WRAPPER" || die "apply-grants failed. The site is still on the previous release."

  ( cd "$release/backend" && npm prune --omit=dev --no-audit --no-fund >/dev/null )

  # What this release is, byte for byte (node_modules excluded - see release.sh).
  ( cd "$release" && find . -type f ! -path './backend/node_modules/*' \
      -exec sha256sum {} + > "$release.SHA256SUMS" )
  mv "$release.SHA256SUMS" "$release/SHA256SUMS"

  # --- Swap -----------------------------------------------------------------
  # ln onto a temporary name, then mv -T: the only atomic form.
  log "pointing current at $stamp"
  ln -sfn "$release" "$CURRENT.tmp"
  mv -Tf "$CURRENT.tmp" "$CURRENT"
  SWAPPED=1

  # --- Restart, with automatic undo ------------------------------------------
  if ! rolling_restart; then
    if [[ -n "$previous" && -d "$previous" && "$previous" != "$release" ]]; then
      warn "rolling back to $(basename "$previous")"
      ln -sfn "$previous" "$CURRENT.tmp"
      mv -Tf "$CURRENT.tmp" "$CURRENT"
      # shellcheck disable=SC2034  # the failed release is no longer live; the EXIT trap deletes it
      SWAPPED=0
      rolling_restart || die "the PREVIOUS release did not come back either. Serious: check 'journalctl -u uboss-api@4000 -n 100'"
      die "the new release failed its health checks and was rolled back to $(basename "$previous"). Migrations, if any, stay applied."
    fi
    die "the new release failed its health checks and there is no previous release to go back to"
  fi

  # --- Tidy -----------------------------------------------------------------
  # Keep the newest $KEEP_RELEASES, never the one being served or the one just
  # replaced (so a manual rollback always has somewhere to go).
  local keep_cur keep_prev dir
  keep_cur="$(basename "$release")"; keep_prev="$(basename "${previous:-none}")"
  while IFS= read -r dir; do
    [[ "$dir" == "$keep_cur" || "$dir" == "$keep_prev" ]] && continue
    rm -rf -- "${RELEASES:?}/$dir"
  done < <(cd "$RELEASES" && find . -mindepth 1 -maxdepth 1 -type d ! -name '*.unpack' -printf '%T@ %f\n' \
             | sort -rn | cut -d' ' -f2- | tail -n +"$(( KEEP_RELEASES + 1 ))")
  log "released $short ($stamp)"
}

trap 'die "failed at line $LINENO"' ERR

if [[ "${1:-}" == "--stage2" ]]; then
  [[ $# -eq 2 ]] || die "request refused"
  stage2 "$2"
else
  [[ $# -eq 0 ]] || die "request refused"
  stage1
fi
