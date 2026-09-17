#!/usr/bin/env bash
# =============================================================================
# Ship the binary logs off the machine, every fifteen minutes.
#
#   sudo systemctl enable --now uboss-binlog.timer
#
# WHAT THIS IS FOR
#
# The nightly dump in backup.sh means that losing this machine at 23:00 loses
# every order taken since 02:30 - twenty hours of payments, on a system that
# takes cards. That is a recovery point objective of 24 hours, and nobody who
# has had to explain it to a customer accepts it twice.
#
# Binary logging is already on (`log_bin` in deploy/mariadb/uboss.cnf), so every
# change is written down as it happens. The only thing missing is that those
# files never leave the disk they are protecting against losing. This script
# closes the current log, copies the completed ones off-site, and turns a
# 24-hour recovery point into about fifteen minutes.
#
# To restore to a point in time: restore last night's dump, then replay these
# logs with `mariadb-binlog --stop-datetime='...'`. The runbook has the full
# sequence; the thing to know here is that it does NOT work without both halves,
# and the dump alone is the half most people have.
#
# HOW IT READS THE LOGS, AND WHY NOT SIMPLY `cp`
#
# The logs live in /var/log/mysql, owned by mysql and readable by nobody else.
# Copying them would mean running this as root - and this script lives in a
# directory the `uboss` service user can write to, so a root timer executing it
# would hand anything that compromised the application a clean path to root.
#
# So it fetches them over the MySQL protocol instead, as an unprivileged user,
# exactly as a replica would. No filesystem access, no root, and the same bytes.
#
# THREE SETTINGS, in /etc/uboss/backup.env with the backup's own:
#
#   UBOSS_BINLOG_URL          mysql://uboss_binlog:<pass>@127.0.0.1:3306/
#                             A user that may read the logs and nothing else:
#
#                               CREATE USER 'uboss_binlog'@'localhost'
#                                 IDENTIFIED BY '<long random>';
#                               GRANT REPLICATION SLAVE, REPLICATION CLIENT,
#                                     RELOAD ON *.* TO 'uboss_binlog'@'localhost';
#
#                             No SELECT on any table: it never reads the
#                             database, only the log of changes to it.
#   UBOSS_BACKUP_PASSPHRASE   The same passphrase backup.sh uses. These logs are
#                             every INSERT and UPDATE the system made, which is
#                             every customer, address, order and card reference
#                             in it. They are encrypted before they leave.
#   UBOSS_OFFSITE_REMOTE      The same rclone destination. Without it this
#                             script does nothing useful and says so.
# =============================================================================
set -Eeuo pipefail

ROOT=/srv/uboss
DEST="$ROOT/backups/binlog"

# Seven days, matching `expire_logs_days` in deploy/mariadb/uboss.cnf. Keeping
# local copies longer than the server keeps the originals is pointless; keeping
# them for less would mean a log could be pruned here before the off-site copy
# is a day old.
KEEP_DAYS=7

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

trap 'die "failed at line $LINENO"' ERR

# One shipper at a time. The timer fires every fifteen minutes and a large log
# on a slow uplink can take longer than that; two runs would fetch the same file
# into the same directory at the same time.
mkdir -p "$DEST"
exec 9>"$DEST/.ship.lock"
flock -n 9 || { log "a previous run is still shipping - skipping this tick"; exit 0; }

[[ -n "${UBOSS_BINLOG_URL:-}" ]] || die \
  "UBOSS_BINLOG_URL is not set. Point-in-time recovery is off, and the recovery
   point is therefore the nightly dump - up to 24 hours. See the header of this
   file for the user to create, and docs/DEPLOYMENT.md section 17."

[[ -n "${UBOSS_BACKUP_PASSPHRASE:-}" ]] || die \
  "UBOSS_BACKUP_PASSPHRASE is not set. These logs hold every change made to the
   database and will not be written or shipped unencrypted."

[[ -n "${UBOSS_OFFSITE_REMOTE:-}" ]] || die \
  "UBOSS_OFFSITE_REMOTE is not set. Copying the binary logs to the same disk as
   the database protects against nothing this is meant to protect against."

command -v rclone >/dev/null || die "rclone is not installed"

# The client binaries are `mariadb-binlog` on MariaDB 11.4 - which ships ONLY
# the mariadb-named tools - and `mysqlbinlog` on older packages and on XAMPP.
# Whichever is here. This detection is why this script survived the version
# change and `backup.sh`, which hard-coded `mysqldump`, did not.
BINLOG_BIN="$(command -v mariadb-binlog || command -v mysqlbinlog || true)"
[[ -n "$BINLOG_BIN" ]] || die "neither mariadb-binlog nor mysqlbinlog is installed"
CLIENT_BIN="$(command -v mariadb || command -v mysql || true)"
[[ -n "$CLIENT_BIN" ]] || die "neither the mariadb nor the mysql client is installed"

# Parsed by node rather than by the shell, for the same reason backup.sh does
# it: a generated password containing an `@` is percent-encoded in a URL, and
# splitting on the first `@` cuts the string in the wrong place.
eval "$(DB_URL="$UBOSS_BINLOG_URL" node -e '
  const u = new URL(process.env.DB_URL);
  const q = (s) => "'"'"'" + String(s).replace(/'"'"'/g, "'"'"'\\'"'"''"'"'") + "'"'"'";
  process.stdout.write(
    "DB_USER=" + q(decodeURIComponent(u.username)) + "\n" +
    "DB_PASS=" + q(u.password ? decodeURIComponent(u.password) : "") + "\n" +
    "DB_HOST=" + q(u.hostname) + "\n" +
    "DB_PORT=" + q(u.port || "3306") + "\n"
  );
')" || die "could not parse UBOSS_BINLOG_URL"

# MYSQL_PWD rather than --password=, which is visible in `ps` to every process
# on the machine for as long as the client runs.
export MYSQL_PWD="$DB_PASS"

db() { "$CLIENT_BIN" --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --batch --skip-column-names "$@"; }

# -----------------------------------------------------------------------------
# Close the current log
#
# A log that is still being written is not safe to ship: half a transaction is
# worse than none, because a replay stops there and nobody notices the rest is
# missing. FLUSH closes it and starts a new one, so everything up to this moment
# is in a file that will never change again.
# -----------------------------------------------------------------------------
db -e "FLUSH BINARY LOGS;" >/dev/null

# Every log the server still has, oldest first, with its size. The LAST one is
# the one now being written - it is excluded below.
mapfile -t ROWS < <(db -e "SHOW BINARY LOGS;")
(( ${#ROWS[@]} > 0 )) || die "SHOW BINARY LOGS returned nothing - is log_bin on?"

shipped=0
for (( i = 0; i < ${#ROWS[@]} - 1; i++ )); do
  name="$(awk '{print $1}' <<<"${ROWS[$i]}")"
  size="$(awk '{print $2}' <<<"${ROWS[$i]}")"

  [[ -n "$name" ]] || continue
  # Already done on an earlier tick. Encryption is not deterministic, so the
  # local ciphertext is the record of what has been shipped - re-encrypting
  # would produce different bytes and upload the same log again every quarter
  # of an hour.
  [[ -f "$DEST/$name.gpg" ]] && continue

  log "fetching $name ($size bytes)"
  "$BINLOG_BIN" --read-from-remote-server \
    --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" \
    --raw --result-file="$DEST/" "$name"

  [[ -f "$DEST/$name" ]] || die "$BINLOG_BIN reported success but wrote no $DEST/$name"

  # The server told us how large the completed log is. A short file here means
  # the transfer was cut, and a truncated binary log replays cleanly right up to
  # the point where it silently stops - the one failure mode that looks like a
  # successful restore.
  got="$(stat -c%s "$DEST/$name")"
  if [[ "$size" =~ ^[0-9]+$ ]] && (( got != size )); then
    rm -f "$DEST/$name"
    die "$name is $got bytes locally but $size on the server - refusing to ship a truncated log"
  fi

  # Encrypted before it leaves, like the dump and the media archive. See
  # backup.sh for why the passphrase goes in on fd 3 and not as an argument.
  gpg --batch --yes --symmetric --cipher-algo AES256 \
      --passphrase-fd 3 -o "$DEST/$name.gpg" "$DEST/$name" 3<<<"$UBOSS_BACKUP_PASSPHRASE"
  shred -u "$DEST/$name" 2>/dev/null || rm -f "$DEST/$name"
  sha256sum "$DEST/$name.gpg" > "$DEST/$name.gpg.sha256"

  shipped=$(( shipped + 1 ))
done

if (( shipped == 0 )); then
  log "nothing new to ship"
else
  log "$shipped log(s) prepared"
fi

# -----------------------------------------------------------------------------
# Off-site, and verified
#
# `copy` then `check`, exactly as backup.sh does: an rclone copy can succeed
# quietly against a misconfigured remote, and a recovery point nobody has
# verified is not a recovery point. One-way, because the remote holds older logs
# this box has already pruned.
# -----------------------------------------------------------------------------
log "copying to $UBOSS_OFFSITE_REMOTE/binlogs/"
rclone copy "$DEST" "$UBOSS_OFFSITE_REMOTE/binlogs/" --checksum --exclude '.ship.lock' \
  || die "off-site copy FAILED - the only copy of these logs is on this machine"

rclone check "$DEST" "$UBOSS_OFFSITE_REMOTE/binlogs/" --one-way --checksum --exclude '.ship.lock' \
  || die "off-site VERIFY failed - rclone reported a copy but the files are not there"

# Local copies only. The remote keeps its own retention, and that is the copy
# that matters; these are pruned in step with the server's own expire_logs_days
# so the backup directory does not grow without limit.
find "$DEST" -maxdepth 1 -type f -name '*.gpg'        -mtime "+$KEEP_DAYS" -delete
find "$DEST" -maxdepth 1 -type f -name '*.gpg.sha256' -mtime "+$KEEP_DAYS" -delete

log "binary logs are off-site"
