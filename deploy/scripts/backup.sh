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
# ransomware. So the off-site copy is not an optional extra at the bottom of
# this script: it is configured, it is verified, and a run that cannot do it
# EXITS NON-ZERO so the timer records a failure and somebody is told.
#
# TWO SETTINGS, BOTH REQUIRED. Put them in the systemd unit, never in this file:
#
#   UBOSS_BACKUP_PASSPHRASE   Encrypts the dump, the media archive and .env.
#                             The dump is every customer, address, order and
#                             invoice in the system; it must not sit in a
#                             directory in clear text.
#   UBOSS_OFFSITE_REMOTE      An rclone destination, e.g. `b2:uboss-backups`.
#                             It must be a DIFFERENT PROVIDER OR ACCOUNT from
#                             the one hosting this machine - a copy that the
#                             same compromised password can delete is not an
#                             off-site backup.
#
# KEEP THE PASSPHRASE SOMEWHERE THAT SURVIVES LOSING THIS MACHINE. It is not in
# the backups, deliberately. A passphrase stored beside the ciphertext protects
# nothing, and a passphrase stored only on the server protects nothing once the
# server is gone.
#
# To run without an off-site copy anyway - a staging box, a first rehearsal -
# set UBOSS_OFFSITE_OPTOUT=true. It is spelled out like that so that nobody
# reaches production having skipped it by accident.
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

[[ -n "${UBOSS_BACKUP_PASSPHRASE:-}" ]] || die \
  "UBOSS_BACKUP_PASSPHRASE is not set. The dump holds every customer, address,
   order and invoice in this system and will not be written unencrypted. Set it
   in the systemd unit and store it off this machine - see the header."

# -----------------------------------------------------------------------------
# Encrypt in place, then remove the plaintext.
#
# `--passphrase-fd 3` rather than `--passphrase`, because an argument is visible
# to every process on the box in `ps` output for as long as gpg runs. fd 3 is
# used rather than stdin so that stdin stays free.
#
# `shred` rather than `rm`: the plaintext dump existed on the disk, and on a
# machine that may later be resized, snapshotted or handed back to the provider
# the difference is worth the few seconds.
# -----------------------------------------------------------------------------
encrypt_file() {
  local plain="$1" cipher="$1.gpg"

  gpg --batch --yes --symmetric --cipher-algo AES256 \
      --passphrase-fd 3 -o "$cipher" "$plain" 3<<<"$UBOSS_BACKUP_PASSPHRASE"

  shred -u "$plain" 2>/dev/null || rm -f "$plain"

  # Written next to the file, and copied off-site with it. This is what lets a
  # restore prove the bytes it has are the bytes that were taken, rather than
  # something a half-finished transfer left behind.
  sha256sum "$cipher" > "$cipher.sha256"

  printf '%s' "$cipher"
}

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

# Encrypted only AFTER the three checks above, which have to read the plaintext.
log "encrypting the dump"
DUMP="$(encrypt_file "$DUMP")"

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
# Encrypted like the dump, and for the same reason: alongside product
# photographs this tree holds generated invoices, seller certificates and
# proof-of-delivery images, all of which name people.
if [[ -d "$MEDIA" ]]; then
  log "archiving media"
  tar -czf "$DEST/media-$STAMP.tar.gz" -C "$(dirname "$MEDIA")" "$(basename "$MEDIA")"
  log "media ok ($(numfmt --to=iec "$(stat -c%s "$DEST/media-$STAMP.tar.gz")"))"
  encrypt_file "$DEST/media-$STAMP.tar.gz" >/dev/null
fi

# -----------------------------------------------------------------------------
# The environment file
#
# Secrets, so it is encrypted rather than sitting in the backup directory in
# clear text. Without it a restore has the data and no way to start the
# application that reads it - the session and token secrets in particular
# cannot be regenerated without signing every user out.
#
# Set UBOSS_BACKUP_PASSPHRASE in the systemd unit, not here. Its absence is a
# hard failure at the top of this script, so by here it is always present.
#
# Copied first rather than encrypted in place, because encrypt_file shreds its
# input and that input would be the live environment file.
# -----------------------------------------------------------------------------
log "encrypting the environment file"
cp "$SHARED/.env" "$DEST/env-$STAMP"
encrypt_file "$DEST/env-$STAMP" >/dev/null

# -----------------------------------------------------------------------------
# Off-site
#
# Everything above protects against a mistake. Only this protects against
# losing the machine - so it is configuration rather than a comment, and a run
# that cannot complete it fails.
#
# `rclone copy` then `rclone check`: the copy can succeed quietly against a
# misconfigured remote, and a backup strategy nobody has verified is the
# failure this whole script exists to prevent. The check is one-way because the
# remote legitimately holds older runs this box has already pruned.
# -----------------------------------------------------------------------------
if [[ -n "${UBOSS_OFFSITE_REMOTE:-}" ]]; then
  command -v rclone >/dev/null || die "UBOSS_OFFSITE_REMOTE is set but rclone is not installed"

  log "copying off-site to $UBOSS_OFFSITE_REMOTE"
  rclone copy "$DEST" "$UBOSS_OFFSITE_REMOTE" --max-age 25h --checksum \
    || die "off-site copy FAILED - the only copy of tonight's backup is on this machine"

  rclone check "$DEST" "$UBOSS_OFFSITE_REMOTE" --one-way --max-age 25h \
    || die "off-site VERIFY failed - rclone reported a copy but the files are not there"

  log "off-site copy verified"
  OFFSITE_OK=1
elif [[ "${UBOSS_OFFSITE_OPTOUT:-false}" == "true" ]]; then
  log "UBOSS_OFFSITE_OPTOUT=true - keeping backups on this machine only"
  OFFSITE_OK=1
else
  # Not `die`: the local backup above is good and the prune below should still
  # run. But the script must not report success, or the timer looks healthy
  # while the only copy of the data sits on the disk it is meant to survive.
  printf '\033[1;31mxx\033[0m %s\n' \
    "NO OFF-SITE BACKUP. Set UBOSS_OFFSITE_REMOTE (an rclone destination on a
     different provider or account), or UBOSS_OFFSITE_OPTOUT=true to accept
     that losing this machine loses the data. See docs/DEPLOYMENT.md section 17." >&2
  OFFSITE_OK=0
fi

# -----------------------------------------------------------------------------
# Prune
#
# Last, and only after everything above succeeded - `set -e` and the checks
# mean a failed dump exits before reaching this, so a run of bad nights never
# deletes the last good copy.
# -----------------------------------------------------------------------------
log "pruning backups older than $KEEP_DAYS days"
find "$DEST" -maxdepth 1 -type f -name 'db-*.sql.gz.gpg'       -mtime "+$KEEP_DAYS" -delete
find "$DEST" -maxdepth 1 -type f -name 'db-*.sql.gz.gpg.sha256' -mtime "+$KEEP_DAYS" -delete
find "$DEST" -maxdepth 1 -type f -name 'media-*.tar.gz.gpg'    -mtime "+$KEEP_DAYS" -delete
find "$DEST" -maxdepth 1 -type f -name 'media-*.tar.gz.gpg.sha256' -mtime "+$KEEP_DAYS" -delete
find "$DEST" -maxdepth 1 -type f -name 'env-*.gpg'             -mtime "+$KEEP_DAYS" -delete
find "$DEST" -maxdepth 1 -type f -name 'env-*.gpg.sha256'      -mtime "+$KEEP_DAYS" -delete

# Leftovers from a run that died between writing a plaintext file and encrypting
# it. Narrow patterns: this must never match the encrypted copies above.
find "$DEST" -maxdepth 1 -type f -name 'db-*.sql.gz'    -delete
find "$DEST" -maxdepth 1 -type f -name 'media-*.tar.gz' -delete

if (( OFFSITE_OK == 0 )); then
  die "backup $STAMP is on this machine ONLY - see the message above"
fi

log "backup $STAMP complete"
