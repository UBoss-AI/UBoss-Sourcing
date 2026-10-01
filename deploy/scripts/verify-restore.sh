#!/usr/bin/env bash
# =============================================================================
# Prove the newest backup restores - on the server, into a scratch database.
#
#   sudo -u uboss UBOSS_RESTORE_DATABASE_URL=... UBOSS_BACKUP_PASSPHRASE=... \
#     deploy/scripts/verify-restore.sh [path/to/db-YYYYmmdd-HHMMSS.sql.gz.gpg]
#
# The server-side twin of scripts/db/verify-restore.ps1 (checklist SEC-010).
# With no argument it takes the newest db-*.sql.gz.gpg in /srv/uboss/backups.
# Run it monthly against a copy FETCHED FROM OFF-SITE (rclone copy first), so
# the fetch path is tested too - docs/DATABASE-RECOVERY.md section 2.
#
# IT NEVER TOUCHES THE LIVE DATABASE
#
#   - The target is a name this script generates: uboss_restore_check_<stamp>.
#     It takes no database name and no host from the caller.
#   - It uses its own account, UBOSS_RESTORE_DATABASE_URL, which should be
#     granted ONLY on `uboss_restore_check\_%` (docs/DATABASE-PRODUCTION.md).
#     Even a mistake in this script cannot then write to `uboss`.
#   - Before dropping the scratch database it re-checks the prefix.
#
# WHAT IT CHECKS
#
#   1. The SHA-256 beside the file matches.          (the file is what was written)
#   2. It decrypts and gunzips, and has the marker.  (it did not stop early)
#   3. It loads without error.
#   4. Tables arrived, all InnoDB, CHECK TABLE clean.
#   5. Migration history is present.                 (the schema can be upgraded)
#
# WHAT IT RECORDS
#
# One JSON line per run in $UBOSS_STATE_DIR/restore-tests.jsonl, and the date
# of the last PASS in $UBOSS_STATE_DIR/last-restore-test. monitor.sh alerts
# when that date is older than UBOSS_RESTORE_TEST_MAX_DAYS. The JSON line is
# the restore-test evidence: when, which file, how old it was (the recovery
# point), how long the restore took (the recovery time), the counts and the
# result. Attach it to the go-live record; it is not a substitute for the
# quarterly point-in-time rehearsal in docs/INCIDENT-READINESS.md.
# =============================================================================
set -Eeuo pipefail

DEST=/srv/uboss/backups
STATE_DIR="${UBOSS_STATE_DIR:-/var/lib/uboss}"
PREFIX=uboss_restore_check_

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; record FAIL "$*"; exit 1; }

STARTED=$(date +%s)
FILE="${1:-}"
TARGET="${PREFIX}$(date -u +%Y%m%d%H%M%S)"
TABLES=0
MIGRATIONS=0

record() {
  local result="$1" note="${2:-}"
  mkdir -p "$STATE_DIR" 2>/dev/null || return 0
  local now; now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local age_h=-1
  [[ -n "$FILE" && -f "$FILE" ]] && age_h=$(( ( $(date +%s) - $(stat -c %Y "$FILE") ) / 3600 ))
  printf '{"at":"%s","host":"%s","file":"%s","backupAgeHours":%s,"restoreSeconds":%s,"tables":%s,"migrations":%s,"result":"%s","note":"%s"}\n' \
    "$now" "$(hostname)" "$(basename "${FILE:-none}")" "$age_h" "$(( $(date +%s) - STARTED ))" \
    "$TABLES" "$MIGRATIONS" "$result" "${note//\"/\'}" >> "$STATE_DIR/restore-tests.jsonl"
  [[ "$result" == PASS ]] && printf '%s\n' "$now" > "$STATE_DIR/last-restore-test"
  return 0
}

: "${UBOSS_BACKUP_PASSPHRASE:?UBOSS_BACKUP_PASSPHRASE is not set}"
DB_URL="${UBOSS_RESTORE_DATABASE_URL:?UBOSS_RESTORE_DATABASE_URL is not set - a dedicated account granted only on uboss_restore_check_%}"

eval "$(DB_URL="$DB_URL" node -e '
  const u = new URL(process.env.DB_URL);
  const q = (s) => "'"'"'" + String(s).replace(/'"'"'/g, "'"'"'\\'"'"''"'"'") + "'"'"'";
  process.stdout.write(
    "DB_USER=" + q(decodeURIComponent(u.username)) + "\n" +
    "DB_PASS=" + q(u.password ? decodeURIComponent(u.password) : "") + "\n" +
    "DB_HOST=" + q(u.hostname) + "\n" +
    "DB_PORT=" + q(u.port || "3306") + "\n"
  );
')" || die "could not parse UBOSS_RESTORE_DATABASE_URL"

CLIENT="$(command -v mariadb || command -v mysql || true)"
[[ -n "$CLIENT" ]] || die "no mariadb client on this machine"
sql() { MYSQL_PWD="$DB_PASS" "$CLIENT" -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" --batch --skip-column-names "$@"; }

if [[ -z "$FILE" ]]; then
  FILE="$(find "$DEST" -maxdepth 1 -type f -name 'db-*.sql.gz.gpg' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -1 | cut -d' ' -f2- || true)"
fi
[[ -n "$FILE" && -f "$FILE" ]] || die "no backup file to verify"
log "verifying $(basename "$FILE") into $TARGET"

# 1. Checksum.
if [[ -f "$FILE.sha256" ]]; then
  ( cd "$(dirname "$FILE")" && sha256sum --check --status "$(basename "$FILE").sha256" ) || die "SHA-256 does not match - do not trust this file"
else
  die "no $FILE.sha256 beside the backup"
fi

drop_target() {
  [[ "$TARGET" == ${PREFIX}* ]] || { printf 'refusing to drop %s\n' "$TARGET" >&2; return 1; }
  sql -e "DROP DATABASE IF EXISTS \`$TARGET\`" || true
}
trap drop_target EXIT

# 2 and 3. Decrypt, decompress, load. The passphrase goes on fd 3, never argv.
sql -e "CREATE DATABASE \`$TARGET\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci" || die "could not create $TARGET (check the restore account's grants)"
TAIL_MARK="$(mktemp)"
if ! gpg --batch --quiet --decrypt --passphrase-fd 3 "$FILE" 3<<<"$UBOSS_BACKUP_PASSPHRASE" \
    | gunzip \
    | tee >(tail -c 200 > "$TAIL_MARK") \
    | sql "$TARGET"; then
  die "the dump did not load"
fi
grep -q "Dump completed" "$TAIL_MARK" || die "the dump has no completion marker - it stopped early"
rm -f "$TAIL_MARK"

# 4. Tables, engine, integrity.
TABLES=$(sql -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$TARGET'")
[[ "$TABLES" -gt 50 ]] || die "only $TABLES tables arrived"
NON_INNODB=$(sql -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA='$TARGET' AND ENGINE<>'InnoDB' AND TABLE_TYPE='BASE TABLE'")
[[ "$NON_INNODB" -eq 0 ]] || die "$NON_INNODB tables are not InnoDB"
BAD=$(sql -e "SELECT CONCAT('\`',TABLE_NAME,'\`') FROM information_schema.TABLES WHERE TABLE_SCHEMA='$TARGET' AND TABLE_TYPE='BASE TABLE'" \
  | while read -r t; do sql "$TARGET" -e "CHECK TABLE $t" | awk '$3=="status" && $4!="OK"'; done | wc -l)
[[ "$BAD" -eq 0 ]] || die "CHECK TABLE reported $BAD problems"

# 5. Migration history.
MIGRATIONS=$(sql "$TARGET" -e "SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL" 2>/dev/null || echo 0)
[[ "$MIGRATIONS" -gt 0 ]] || die "no migration history in the dump"

record PASS "tables=$TABLES migrations=$MIGRATIONS"
log "PASS: $TABLES tables, $MIGRATIONS migrations, $(( $(date +%s) - STARTED ))s"
