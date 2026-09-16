#!/usr/bin/env bash
# =============================================================================
# The checks this machine can make about itself, every five minutes.
#
#   sudo systemctl enable --now uboss-monitor.timer
#
# WHAT THIS IS AND, MORE IMPORTANTLY, WHAT IT IS NOT
#
# This is not monitoring. It runs ON the box it is watching, so it goes quiet at
# exactly the moment that matters most - the machine being gone is the one thing
# it can never report. An external uptime check from outside this network is not
# optional and this script is not a substitute for it (docs/DEPLOYMENT.md §18).
#
# What it IS: the half that an external check cannot see. A worker that has
# stopped taking jobs, a queue backing up, a backup that did not run, a disk
# filling with old releases - the site answers 200 through all of them, and
# without this nobody finds out until a customer asks why their card was never
# charged.
#
# HOW IT TELLS YOU
#
# Two ways, and you want both:
#
#   1. It exits non-zero, so `uboss-monitor.service` shows as failed in
#      `systemctl --failed` and in any check that watches unit state.
#   2. It runs UBOSS_ALERT_COMMAND, if set, once per failing check, with the
#      message as the single argument. That is deliberately a command rather
#      than an email address or a webhook URL: whoever runs this installation
#      already has somewhere alerts go, and this should not care which one.
#
#        UBOSS_ALERT_COMMAND='/usr/local/bin/uboss-alert'
#
#      Anything executable. A one-line curl to a chat webhook, `mail -s`, a
#      script that pages. It is passed one argument and its own exit code is
#      ignored - an alerting channel that is down must not stop the checks.
#
# Thresholds are the recommendations in docs/DEPLOYMENT.md §18.2 and are all
# overridable from the environment, because "too slow" depends on the size of
# the shop.
# =============================================================================
set -Eeuo pipefail

ROOT=/srv/uboss
SHARED="$ROOT/shared"
DEST="$ROOT/backups"

API_PORTS=(4000 4001 4002)

# --- Thresholds --------------------------------------------------------------
DISK_PCT_WARN=${UBOSS_DISK_PCT_WARN:-85}
INODE_PCT_WARN=${UBOSS_INODE_PCT_WARN:-85}
QUEUE_DEPTH_WARN=${UBOSS_QUEUE_DEPTH_WARN:-5000}
QUEUE_AGE_MIN_WARN=${UBOSS_QUEUE_AGE_MIN_WARN:-30}
BACKUP_AGE_HOURS_WARN=${UBOSS_BACKUP_AGE_HOURS_WARN:-50}
BINLOG_AGE_MIN_WARN=${UBOSS_BINLOG_AGE_MIN_WARN:-60}
TLS_DAYS_WARN=${UBOSS_TLS_DAYS_WARN:-21}

problems=0

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()  { printf '   ok   %s\n' "$*"; }

# Every failure goes through here, so there is exactly one place that decides
# what "telling somebody" means.
fail() {
  local message="$1"
  problems=$(( problems + 1 ))
  printf '\033[1;31mxx\033[0m %s\n' "$message" >&2

  if [[ -n "${UBOSS_ALERT_COMMAND:-}" ]]; then
    # `|| true`: a broken alert channel must not abort the remaining checks.
    "$UBOSS_ALERT_COMMAND" "UBOSS: $message" >/dev/null 2>&1 || true
  fi
}

# Deliberately NOT `trap ... ERR` with a die. Every check below is written to
# swallow its own errors and report them as findings, because a monitor that
# stops at the first problem never reaches the second one - and the second one
# is usually the one that explains the first.

# -----------------------------------------------------------------------------
# The API instances
#
# /health/ready rather than /health/live: alive means the process exists, ready
# means it can reach the database and the queue. An instance that is up and
# cannot see MariaDB is worse than one that is down, because nginx keeps sending
# it traffic.
# -----------------------------------------------------------------------------
for port in "${API_PORTS[@]}"; do
  if curl -fsS --max-time 5 "http://127.0.0.1:$port/health/ready" >/dev/null 2>&1; then
    ok "API $port ready"
  else
    fail "API on port $port is not ready (journalctl -u uboss-api@$port -n 50)"
  fi
done

# -----------------------------------------------------------------------------
# The worker
#
# `is-active` is necessary and nowhere near sufficient. A worker process that is
# running and has stopped claiming jobs looks perfectly healthy to systemd, and
# the jobs it is not claiming include the card charges for every scheduled
# order. The queue check below is the one that would catch that.
# -----------------------------------------------------------------------------
if systemctl is-active --quiet uboss-worker; then
  ok "worker is running"
else
  fail "uboss-worker is NOT running - scheduled charges, emails and ERP pushes are all stopped"
fi

# -----------------------------------------------------------------------------
# The queue
#
# Read directly, because the worker is what would otherwise report on itself.
# Read-only SELECTs as the application user, which is all it takes.
# -----------------------------------------------------------------------------
if [[ -f "$SHARED/.env" ]] && command -v node >/dev/null; then
  DB_URL="$(sed -n 's/^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*//p' "$SHARED/.env" \
    | tail -n 1 | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/")"

  if [[ -n "$DB_URL" ]]; then
    CLIENT_BIN="$(command -v mariadb || command -v mysql || true)"

    if [[ -n "$CLIENT_BIN" ]]; then
      eval "$(DB_URL="$DB_URL" node -e '
        const u = new URL(process.env.DB_URL);
        const q = (s) => "'"'"'" + String(s).replace(/'"'"'/g, "'"'"'\\'"'"''"'"'") + "'"'"'";
        process.stdout.write(
          "DB_USER=" + q(decodeURIComponent(u.username)) + "\n" +
          "DB_PASS=" + q(u.password ? decodeURIComponent(u.password) : "") + "\n" +
          "DB_HOST=" + q(u.hostname) + "\n" +
          "DB_PORT=" + q(u.port || "3306") + "\n" +
          "DB_NAME=" + q(u.pathname.replace(/^\//, "").split("?")[0]) + "\n"
        );
      ')" 2>/dev/null || true

      if [[ -n "${DB_NAME:-}" ]]; then
        qq() {
          MYSQL_PWD="$DB_PASS" "$CLIENT_BIN" --host="$DB_HOST" --port="$DB_PORT" \
            --user="$DB_USER" --batch --skip-column-names --connect-timeout=5 \
            "$DB_NAME" -e "$1" 2>/dev/null
        }

        pending="$(qq "SELECT COUNT(*) FROM job_queue WHERE status = 'PENDING';" || true)"
        if [[ "$pending" =~ ^[0-9]+$ ]]; then
          if (( pending > QUEUE_DEPTH_WARN )); then
            fail "job queue has $pending pending jobs (threshold $QUEUE_DEPTH_WARN)"
          else
            ok "queue depth $pending"
          fi
        else
          fail "could not read the job queue - the database is unreachable or the credentials are wrong"
        fi

        # The sharper signal. Depth can be high because the shop is busy; a job
        # that was due half an hour ago and has not been claimed means nothing
        # is claiming, whatever `systemctl` believes.
        oldest="$(qq "SELECT COALESCE(TIMESTAMPDIFF(MINUTE, MIN(runAt), UTC_TIMESTAMP(3)), 0) FROM job_queue WHERE status = 'PENDING' AND runAt <= UTC_TIMESTAMP(3);" || true)"
        if [[ "$oldest" =~ ^[0-9]+$ ]]; then
          if (( oldest > QUEUE_AGE_MIN_WARN )); then
            fail "the oldest due job has been waiting ${oldest} minutes - the worker is not claiming (scheduled card charges are in this queue)"
          else
            ok "oldest due job ${oldest}m"
          fi
        fi

        # DEAD means every retry is spent. Each one is a customer who was not
        # emailed, an order that was not pushed to an ERP, or a charge that did
        # not happen, and nothing will pick it up again on its own.
        dead="$(qq "SELECT COUNT(*) FROM job_queue WHERE status = 'DEAD' AND updatedAt > UTC_TIMESTAMP(3) - INTERVAL 1 DAY;" || true)"
        if [[ "$dead" =~ ^[0-9]+$ ]] && (( dead > 0 )); then
          fail "$dead job(s) died in the last 24 hours - read job_queue.lastError"
        fi
      fi
    fi
  fi
fi

# -----------------------------------------------------------------------------
# Backups
#
# The age of the newest encrypted dump. 50 hours rather than 26 so that a single
# missed night is a warning in the journal rather than a page at 03:00, while
# two in a row - which is the point at which somebody genuinely has to look -
# always fires.
# -----------------------------------------------------------------------------
newest_backup="$(find "$DEST" -maxdepth 1 -type f -name 'db-*.sql.gz.gpg' -printf '%T@\n' 2>/dev/null | sort -rn | head -1 || true)"
if [[ -z "$newest_backup" ]]; then
  fail "there is no database backup in $DEST at all"
else
  age_h=$(( ( $(date +%s) - ${newest_backup%.*} ) / 3600 ))
  if (( age_h > BACKUP_AGE_HOURS_WARN )); then
    fail "the newest database backup is ${age_h} hours old (threshold ${BACKUP_AGE_HOURS_WARN}h)"
  else
    ok "newest backup ${age_h}h old"
  fi
fi

# Binary logs, only if point-in-time recovery has been set up at all. An
# installation that has accepted a 24-hour recovery point should not be nagged
# about it every five minutes; one that has set it up should hear immediately
# when it stops, because it stops silently.
if [[ -d "$DEST/binlog" ]] && compgen -G "$DEST/binlog/*.gpg" >/dev/null; then
  newest_binlog="$(find "$DEST/binlog" -maxdepth 1 -type f -name '*.gpg' -printf '%T@\n' | sort -rn | head -1)"
  age_m=$(( ( $(date +%s) - ${newest_binlog%.*} ) / 60 ))
  if (( age_m > BINLOG_AGE_MIN_WARN )); then
    fail "binary logs have not been shipped for ${age_m} minutes - the recovery point is drifting back towards the nightly dump"
  else
    ok "binary logs shipped ${age_m}m ago"
  fi
fi

# -----------------------------------------------------------------------------
# Disk and inodes
#
# Both, because they run out independently. Five releases each carrying their
# own node_modules is tens of thousands of small files, and a filesystem can
# have plenty of gigabytes free and no inodes left to write them with - which
# presents as "no space left on device" on a disk that is half empty.
# -----------------------------------------------------------------------------
disk_pct="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
if (( disk_pct > DISK_PCT_WARN )); then
  fail "the root filesystem is ${disk_pct}% full (threshold ${DISK_PCT_WARN}%)"
else
  ok "disk ${disk_pct}%"
fi

inode_pct="$(df --output=ipcent / | tail -1 | tr -dc '0-9')"
if [[ "$inode_pct" =~ ^[0-9]+$ ]] && (( inode_pct > INODE_PCT_WARN )); then
  fail "the root filesystem is at ${inode_pct}% of its inodes (threshold ${INODE_PCT_WARN}%)"
fi

# -----------------------------------------------------------------------------
# Certificates
#
# An expired certificate takes the whole site down for every visitor at once,
# and it does it on a schedule that was known 90 days in advance. Three weeks of
# warning is enough to notice that the renewal timer has been failing quietly.
# -----------------------------------------------------------------------------
if compgen -G '/etc/letsencrypt/live/*/cert.pem' >/dev/null; then
  for cert in /etc/letsencrypt/live/*/cert.pem; do
    end="$(openssl x509 -enddate -noout -in "$cert" 2>/dev/null | cut -d= -f2 || true)"
    [[ -n "$end" ]] || continue
    end_epoch="$(date -d "$end" +%s 2>/dev/null || echo 0)"
    [[ "$end_epoch" != 0 ]] || continue
    days=$(( ( end_epoch - $(date +%s) ) / 86400 ))
    name="$(basename "$(dirname "$cert")")"
    if (( days < TLS_DAYS_WARN )); then
      fail "the certificate for $name expires in $days days (check 'systemctl list-timers certbot')"
    else
      ok "certificate $name valid $days more days"
    fi
  done
fi

# -----------------------------------------------------------------------------
# Pending reboot
#
# Automatic security updates are on and automatic reboots are deliberately off,
# so a kernel or libc update waits for a person. This is that person being told.
# Not a failure - it is a decision to schedule, not an incident.
# -----------------------------------------------------------------------------
if [[ -f /var/run/reboot-required ]]; then
  log "a security update needs a reboot - schedule one (this is not an outage yet)"
fi

if (( problems > 0 )); then
  printf '\033[1;31mxx\033[0m %s\n' "$problems check(s) failed" >&2
  exit 1
fi

log "all checks passed"
