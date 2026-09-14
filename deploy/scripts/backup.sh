#!/usr/bin/env bash
# =============================================================================
# Nightly backup: the database, the uploaded media, and the environment file.
#
# Install as a timer rather than a cron line, so a missed run while the machine
# was off is caught up rather than skipped:
#
#   sudo cp deploy/systemd/uboss-backup.service deploy/systemd/uboss-backup.timer /etc/systemd/system/
#   sudo systemctl enable --now uboss-backup.timer
#
# A BACKUP YOU HAVE NOT RESTORED IS NOT A BACKUP
#
# This script verifies that each dump is readable gzip and non-trivial in size,
# which catches the two failures that otherwise go unnoticed for months - a
# dump that errored halfway and a dump of an empty database. It cannot tell you
# the data is *correct*. Restore one into a scratch database every few months;
# `docs/DEPLOYMENT.md` has the command.
#
# AND IT MUST LEAVE THE MACHINE
#
# A backup on the same disk as the database protects against a bad UPDATE and
# against nothing else - not a failed volume, not a deleted VPS, not
# ransomware. The off-site step at the bottom is commented out because only the
# operator knows where it should go, and it is the most important line here.
# =============================================================================
set -Eeuo pipefail

ROOT=/srv/uboss
SHARED="$ROOT/shared"
DEST="$ROOT/backups"
MEDIA="$ROOT/media"

# How many nightly copies to keep on the box. Fourteen is two weeks, which is
# long enough to notice "that product's price has been wrong since last Tuesday"
# and still have the Monday before it.
KEEP_DAYS=14

# A dump smaller than this is treated as a failure. A real dump of this schema
# with a seeded catalogue is several megabytes; 100 kB means it stopped early.
MIN_BYTES=102400

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

trap 'die "failed at line $LINENO"' ERR

[[ -f "$SHARED/.env" ]] || die "no $SHARED/.env"

set -a; . "$SHARED/.env"; set +a

STAMP="$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"

# The credentials come from DATABASE_URL rather than a second copy in this
# file. One place for them, and rotating the password does not mean remembering
# to edit the backup script too.
#
# PARSED BY NODE, NOT BY THE SHELL, and that is worth the extra process.
#
# The obvious shell version - strip to the first `@`, split on `:` - is wrong
# for two inputs that turn up in real deployments. A generated password
# containing an `@` is percent-encoded in a URL, so `%40` has to be decoded
# again before it reaches MariaDB, and splitting on the FIRST `@` cuts the URL
# in the wrong place anyway. `URL` plus `decodeURIComponent` is exactly what
# `src/infra/prisma.ts` uses, so this reads the value the same way the
# application does rather than a way that usually agrees with it.
DB_URL="${DATABASE_URL:?DATABASE_URL is not set}"

eval "$(DB_URL="$DB_URL" node -e '
  const u = new URL(process.env.DB_URL);
  const q = (s) => "'"'"'" + String(s).replace(/'"'"'/g, "'"'"'\\'"'"''"'"'") + "'"'"'";
  const name = u.pathname.replace(/^\//, "").split("?")[0];
  if (!name) { console.error("DATABASE_URL has no database name"); process.exit(1); }
  process.stdout.write(
    "DB_USER=" + q(decodeURIComponent(u.username)) + "\n" +
    "DB_PASS=" + q(u.password ? decodeURIComponent(u.password) : "") + "\n" +
    "DB_HOST=" + q(u.hostname) + "\n" +
    "DB_PORT=" + q(u.port || "3306") + "\n" +
    "DB_NAME=" + q(name) + "\n"
  );
')" || die "could not parse DATABASE_URL"

# -----------------------------------------------------------------------------
# The database
#
# `--single-transaction` takes the dump inside one consistent snapshot without
# locking the tables, so the shop keeps taking orders while this runs. It only
# works because every table here is InnoDB.
#
# `--routines --triggers --events` because the schema has CHECK constraints and
# generated pieces that a bare dump silently omits - and a restore missing
# `chk_schedule_frequency_field_present` accepts inserts the real database
# refuses, which is a far worse outcome than a failed restore.
# -----------------------------------------------------------------------------
log "dumping $DB_NAME"
DUMP="$DEST/db-$STAMP.sql.gz"

MYSQL_PWD="$DB_PASS" mysqldump \
  --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" \
  --single-transaction \
  --quick \
  --routines --triggers --events \
  --hex-blob \
  --default-character-set=utf8mb4 \
  --databases "$DB_NAME" \
  | gzip -6 > "$DUMP"

# --- Verify ------------------------------------------------------------------
size=$(stat -c%s "$DUMP")
(( size >= MIN_BYTES )) || die "dump is only ${size} bytes - treating as a failed backup, not deleting anything"

gzip -t "$DUMP" || die "dump is not readable gzip"

# The last line of a complete mysqldump names the finish time. Its absence
# means the dump was truncated, which gzip alone will not tell you.
zcat "$DUMP" | tail -5 | grep -q "Dump completed" || die "dump has no completion marker - it was truncated"

log "database ok ($(numfmt --to=iec "$size"))"

# --- What this script deliberately does NOT check -----------------------------
#
# The three checks above prove the FILE is complete. They do not prove the dump
# is CONSISTENT - that no order item was captured without its order because the
# two tables were read at different moments. The test for that is in RUNBOOK.md
# section 2: restore into a scratch database and count orphaned order items,
# which must be zero.
#
# It is not automated here, and that is a decision rather than an omission.
# Restoring the whole dump needs CREATE DATABASE and DROP DATABASE, and the
# backup user is deliberately limited to SELECT, LOCK TABLES and SHOW VIEW
# (RUNBOOK.md section 7). Handing a nightly unattended job the rights to drop a
# database, so that it can check a backup, trades a larger risk for a smaller
# one.
#
# The project already answers this a better way: restore drills are a quarterly
# item in SOP section 16, performed by a person who can read the result. Do
# them. `--single-transaction` is what makes the dump consistent in the first
# place, and it is above.

# -----------------------------------------------------------------------------
# Uploaded media
#
# Product images and generated invoices. Not in the database, not in git, and
# not recoverable from anywhere else - a restore without these leaves a
# catalogue of broken images.
# -----------------------------------------------------------------------------
if [[ -d "$MEDIA" ]]; then
  log "archiving media"
  tar -czf "$DEST/media-$STAMP.tar.gz" -C "$(dirname "$MEDIA")" "$(basename "$MEDIA")"
  log "media ok ($(numfmt --to=iec "$(stat -c%s "$DEST/media-$STAMP.tar.gz")"))"
fi

# -----------------------------------------------------------------------------
# The environment file
#
# Secrets, so it is encrypted rather than sitting in the backup directory in
# clear text. Without it a restore has the data and no way to start the
# application that reads it - the session and token secrets in particular
# cannot be regenerated without signing every user out.
#
# Set UBOSS_BACKUP_PASSPHRASE in the systemd unit, not here.
# -----------------------------------------------------------------------------
if [[ -n "${UBOSS_BACKUP_PASSPHRASE:-}" ]]; then
  log "encrypting the environment file"
  gpg --batch --yes --symmetric --cipher-algo AES256 \
      --passphrase "$UBOSS_BACKUP_PASSPHRASE" \
      -o "$DEST/env-$STAMP.gpg" "$SHARED/.env"
else
  log "UBOSS_BACKUP_PASSPHRASE is not set - skipping the environment file (see docs/DEPLOYMENT.md)"
fi

# -----------------------------------------------------------------------------
# Off-site
#
# UNCOMMENT ONE OF THESE. Everything above protects against a mistake; only
# this protects against losing the machine.
# -----------------------------------------------------------------------------
# rclone copy "$DEST" remote:uboss-backups/ --max-age 25h
# aws s3 sync "$DEST" s3://your-bucket/uboss/ --exclude '*' --include "*-$STAMP.*"
# rsync -az --delete "$DEST/" backup-host:/srv/uboss-backups/

# -----------------------------------------------------------------------------
# Prune
#
# Last, and only after everything above succeeded - `set -e` and the checks
# mean a failed dump exits before reaching this, so a run of bad nights never
# deletes the last good copy.
# -----------------------------------------------------------------------------
log "pruning backups older than $KEEP_DAYS days"
find "$DEST" -maxdepth 1 -type f -name 'db-*.sql.gz'     -mtime "+$KEEP_DAYS" -delete
find "$DEST" -maxdepth 1 -type f -name 'media-*.tar.gz'  -mtime "+$KEEP_DAYS" -delete
find "$DEST" -maxdepth 1 -type f -name 'env-*.gpg'       -mtime "+$KEEP_DAYS" -delete

log "backup $STAMP complete"
