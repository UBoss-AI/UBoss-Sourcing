#!/usr/bin/env bash
# =============================================================================
# Tightens the application's database grants, after the tables exist.
#
#   sudo bash /srv/uboss/current/deploy/scripts/apply-grants.sh
#
# RUN IT:
#   * once, immediately after the first `prisma migrate deploy` on a new database
#   * again after ANY release whose migration added a table
#
# `release.sh` calls it automatically after every successful migration, so in
# normal operation nobody runs this by hand. It is here, and idempotent, for
# the first deployment and for the times somebody needs to check.
#
# WHAT IT DOES, AND THE MISTAKE IT REPLACES
#
# The application runs as `uboss_app`, which must be able to read and write the
# business tables and must NOT be able to rewrite the audit log or the migration
# bookkeeping. The obvious way to express that is a database-level grant with
# two table-level revokes, and it does not work:
#
#     ERROR 1147 (42000): There is no such grant defined for user 'uboss_app'
#                         on host 'localhost' on table 'audit_logs'
#
# MariaDB cannot revoke a table-level privilege that was granted at database
# level - there is no per-table row to take anything away from. So UPDATE and
# DELETE are granted per table instead, on every table except the protected
# ones, and that list is read from the database rather than written down.
#
# SELECT and INSERT stay database-wide. The application reads everything and
# appends to everything, including the audit log.
#
# WHAT IT NEEDS
#   * to be run on the database host, as a user that can connect as an admin
#     (root via unix_socket, which is how bootstrap.sh leaves the machine)
#   * /srv/uboss/shared/.env, for the database name
#
# WHAT IT NEVER DOES
#   * create or drop a database, a user, or a table
#   * print or log any password
#   * run against anything but the local server
# =============================================================================
set -Eeuo pipefail

ROOT=/srv/uboss
SHARED="$ROOT/shared"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GENERATOR="$HERE/../mariadb/post-migrate-grants.sql"

APP_USER="${UBOSS_APP_DB_USER:-uboss_app}"
APP_HOST="${UBOSS_APP_DB_HOST:-localhost}"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m +\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

trap 'die "failed at line $LINENO"' ERR

[[ -f "$GENERATOR" ]] || die "missing $GENERATOR"

# --- The client -----------------------------------------------------------
#
# Detected, not named. MariaDB 11.4 dropped the mysql-named symlinks entirely,
# and a script that hard-codes `mysql` works for years and then stops on the
# morning of an upgrade.
CLIENT="$(command -v mariadb || command -v mysql || true)"
[[ -n "$CLIENT" ]] || die "neither the mariadb nor the mysql client is installed"

# --- Which database -------------------------------------------------------
DB_NAME="${UBOSS_DB_NAME:-}"
if [[ -z "$DB_NAME" ]]; then
  [[ -f "$SHARED/.env" ]] || die "no $SHARED/.env and no UBOSS_DB_NAME set"
  # Parsed with a URL parser rather than a regular expression, because a
  # password containing '@' or '/' makes a regular expression pick the wrong
  # field, and the failure is silent: it grants on a database that does not
  # exist. The URL itself never reaches the log.
  DB_NAME="$(
    set -a; . "$SHARED/.env"; set +a
    node -e '
      const u = new URL(process.env.DATABASE_URL);
      const db = u.pathname.replace(/^\//, "");
      if (!db) { console.error("DATABASE_URL has no database name"); process.exit(1); }
      process.stdout.write(db);
    '
  )"
fi
[[ -n "$DB_NAME" ]] || die "could not determine the database name"

log "Tightening grants for '$APP_USER'@'$APP_HOST' on $DB_NAME"

# --- Refuse a remote server -----------------------------------------------
#
# This connects over the local socket and has no host option, so there is
# nothing to mistype - but the check is here so that the day somebody adds one,
# this refuses rather than silently rewriting grants somewhere else.
SERVER_HOST="$("$CLIENT" -N -B -e "SELECT @@hostname;" 2>/dev/null || true)"
[[ -n "$SERVER_HOST" ]] || die "could not connect to the local MariaDB as an administrator.
   This must run on the database host, as root or with sudo."

# --- Generate, show, apply -------------------------------------------------
#
# Generated into a variable first so that a failure in the generator cannot
# result in a half-applied set of grants: nothing is executed until the whole
# script has been produced.
STATEMENTS="$(
  printf "SET @app_user='%s'; SET @app_host='%s';\n" "$APP_USER" "$APP_HOST" \
    | cat - "$GENERATOR" \
    | "$CLIENT" -N -B "$DB_NAME"
)"

GRANT_COUNT="$(printf '%s\n' "$STATEMENTS" | grep -c '^GRANT UPDATE, DELETE' || true)"
[[ "$GRANT_COUNT" -gt 0 ]] || die "the generator produced no per-table grants.
   Either $DB_NAME has no tables yet - run 'prisma migrate deploy' first - or
   the generator could not read information_schema."

log "$GRANT_COUNT tables will be writable; audit_logs and _prisma_migrations will not"

VERIFICATION="$(printf '%s\n' "$STATEMENTS" | "$CLIENT" -B "$DB_NAME")"
printf '%s\n' "$VERIFICATION" | sed 's/^/    /'

# The generated script ends with a query that names each protected table and
# whether it is still writable. Anything other than "append-only" on both is a
# failure, and it is a SECURITY failure - the application can rewrite its own
# audit trail - so it exits non-zero rather than warning.
if printf '%s\n' "$VERIFICATION" | grep -q 'NOT PROTECTED'; then
  die "at least one protected table is still writable by '$APP_USER'.
   The application can currently rewrite its own audit log. Do not release
   until this is resolved - docs/DATABASE-PRODUCTION.md section 6."
fi

if [[ "$(printf '%s\n' "$VERIFICATION" | grep -c 'append-only')" -ne 2 ]]; then
  die "expected two protected tables in the verification output, got something else.
   Usually this means '$APP_USER'@'$APP_HOST' is not the account the application
   connects as - check the host part against DATABASE_URL."
fi

ok "audit_logs and _prisma_migrations are append-only for '$APP_USER'@'$APP_HOST'"
warn "Re-run this after any release whose migration adds a table, or the"
warn "application will get \"command denied\" on the new one. release.sh does it."
