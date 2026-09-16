#!/usr/bin/env bash
# =============================================================================
# Go back to the previous release.
#
#   sudo -u uboss /srv/uboss/repo/deploy/scripts/rollback.sh            # previous
#   sudo -u uboss /srv/uboss/repo/deploy/scripts/rollback.sh 20260914-101500
#
# WHAT THIS DOES AND DOES NOT UNDO
#
# It repoints `current` at older code and restarts. It does **not** roll the
# database back, and it must not: migrations have run, and reversing them would
# discard rows written since. Prisma has no down-migrations here for exactly
# this reason.
#
# So this is the right tool when the new code is wrong, and the wrong tool when
# the new MIGRATION is wrong. If an additive migration shipped, old code simply
# ignores the new column and this works perfectly. If a destructive one did,
# rolling the code back puts code that needs the old shape on top of a schema
# that no longer has it - and the fix is forward, with a new migration, not
# backward. See the note at the top of release.sh about splitting destructive
# changes across two releases; this script is why that rule earns its keep.
# =============================================================================
set -Eeuo pipefail

ROOT=/srv/uboss
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
SHARED="$ROOT/shared"

API_PORTS=(4000 4001 4002)
HEALTH_TIMEOUT=60

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

trap 'die "failed at line $LINENO"' ERR

# The same lock release.sh takes, and for a sharper reason: a rollback that runs
# while a release is mid-flight repoints `current` at old code which the release
# then overwrites a second later, so the site ends up on the build somebody was
# rolling back FROM. If a release is running, stop it first and then roll back.
exec 9>"$SHARED/.release.lock"
flock -n 9 || die "a release is running right now (lock: $SHARED/.release.lock) - let it finish or stop it, then roll back"

# See release.sh for why this is not a bare `systemctl`: this runs as the uboss
# service user, which is deliberately not allowed to drive the machine except
# through the named units in /etc/sudoers.d/uboss-release.
restart_unit() {
  local unit="$1"

  if [[ $EUID -eq 0 ]]; then
    systemctl restart "$unit"
  else
    sudo -n systemctl restart "$unit" \
      || die "cannot restart $unit as $(id -un). Install the sudoers rule that bootstrap.sh writes to /etc/sudoers.d/uboss-release."
  fi
}

TARGET="${1:-}"

if [[ -z "$TARGET" ]]; then
  # The newest release that is not the one currently linked.
  CURRENT_NAME="$(basename "$(readlink -f "$CURRENT")")"
  TARGET="$(cd "$RELEASES" && ls -1dt */ | sed 's#/##' | grep -v "^${CURRENT_NAME}$" | head -1 || true)"
  [[ -n "$TARGET" ]] || die "no earlier release to roll back to"
fi

[[ -d "$RELEASES/$TARGET" ]] || die "no such release: $TARGET"

log "rolling back to $TARGET ($(cat "$RELEASES/$TARGET/REVISION" 2>/dev/null || echo 'unknown revision'))"

ln -sfn "$RELEASES/$TARGET" "$CURRENT.tmp"
mv -Tf "$CURRENT.tmp" "$CURRENT"

for port in "${API_PORTS[@]}"; do
  log "restarting API on $port"
  restart_unit "uboss-api@$port"

  deadline=$(( SECONDS + HEALTH_TIMEOUT ))
  until curl -fsS --max-time 3 "http://127.0.0.1:$port/health/ready" >/dev/null 2>&1; do
    (( SECONDS < deadline )) || die "API on $port did not become ready after rollback - this is now the serious case: check 'journalctl -u uboss-api@$port -n 100'"
    sleep 1
  done
done

restart_unit uboss-worker

log "rolled back to $TARGET"
