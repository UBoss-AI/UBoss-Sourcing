#!/bin/bash
# =============================================================================
# Runs ONCE, when the compat container initialises an empty volume.
#
# It creates the same databases and the same three non-root accounts that
# `deploy/scripts/bootstrap.sh` creates on the production VPS, with the same
# grants. That symmetry is the point: a permission this application needs and
# the runtime user has not got should fail here, on a laptop, and not during
# the first checkout after go-live.
#
# A SHELL SCRIPT RATHER THAN A .sql FILE, AND THAT IS NOT A STYLE CHOICE.
# The MariaDB entrypoint pipes .sql files straight into the client, which does
# no variable expansion at all - a `${MARIADB_APP_PASSWORD}` in a .sql file
# would be taken literally and become the password. Only .sh files in this
# directory see the environment.
#
# The passwords come from deploy/compat/.env, which is gitignored. Nothing in
# this file is a secret, and nothing in it is echoed.
# =============================================================================
set -Eeuo pipefail

die() { printf 'xx %s\n' "$*" >&2; exit 1; }

for required in MARIADB_APP_PASSWORD MARIADB_MIGRATE_PASSWORD MARIADB_BACKUP_PASSWORD; do
  [[ -n "${!required:-}" ]] || die "$required is not set - see deploy/compat/.env.database.example"
done

# The binary log lives in the data directory itself (see mariadb-compat.cnf).

# `mariadb`, not `mysql`: the 11.4 image no longer ships the mysql-named
# symlinks at all. This is the same trap that `deploy/scripts/backup.sh` hits,
# and the reason that script now detects its dump binary rather than naming it.
mariadb --protocol=socket -uroot -p"${MARIADB_ROOT_PASSWORD}" <<SQL
-- --- Databases -----------------------------------------------------------
--
-- COLLATE is spelled out on every one. MariaDB 11.4 defaults a new database to
-- utf8mb4_uca1400_ai_ci; every table this schema's migrations create is
-- utf8mb4_unicode_ci. Letting the two meet produces "Illegal mix of collations"
-- on a join - at runtime, in whichever query happens to touch both first.
CREATE DATABASE IF NOT EXISTS \`uboss\`             CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS \`uboss_test\`        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The shadow databases. \`prisma migrate diff\` and \`migrate dev\` build a scratch
-- copy of the schema to compare against; naming them here means the migration
-- user never needs CREATE DATABASE at the server level.
CREATE DATABASE IF NOT EXISTS \`uboss_shadow\`      CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE DATABASE IF NOT EXISTS \`uboss_test_shadow\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Where a backup is restored during a rehearsal, so that a restore never lands
-- on top of the database the rehearsal is comparing it against.
CREATE DATABASE IF NOT EXISTS \`uboss_restore\`     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- --- The application runtime user ----------------------------------------
--
-- Four verbs, database-scoped. No CREATE, no ALTER, no DROP, no INDEX, and
-- nothing at all at the server level. The API does not change its own schema;
-- \`prisma migrate deploy\` does, as a different user, during a release.
--
-- If a feature ever fails with "command denied to user 'uboss_app'", that is
-- this grant working. The answer is to find out why a runtime path is issuing
-- DDL, not to widen the grant.
CREATE USER IF NOT EXISTS 'uboss_app'@'%' IDENTIFIED BY '${MARIADB_APP_PASSWORD}';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`uboss\`.*      TO 'uboss_app'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON \`uboss_test\`.* TO 'uboss_app'@'%';

-- NOTE THE THING THAT IS NOT HERE: the REVOKE that makes \`audit_logs\`
-- append-only. It cannot run at this point and this is where finding that out
-- was cheap.
--
-- MariaDB refuses a table-level REVOKE against a table that does not exist -
-- "ERROR 1147: There is no such grant defined ... on table 'audit_logs'" - and
-- at container-init time no migration has run, so no table does. The revoke
-- belongs after \`prisma migrate deploy\`, and it lives in
-- deploy/mariadb/post-migrate-grants.sql, which both this environment and the
-- production VPS apply at the same point in the sequence.

-- --- The migration user ---------------------------------------------------
--
-- Database-level DDL, and only on these databases. It is handed to
-- \`prisma migrate deploy\` during a release and to nothing else. It is NOT the
-- user in the application's DATABASE_URL.
CREATE USER IF NOT EXISTS 'uboss_migrate'@'%' IDENTIFIED BY '${MARIADB_MIGRATE_PASSWORD}';
GRANT ALL PRIVILEGES ON \`uboss\`.*             TO 'uboss_migrate'@'%';
GRANT ALL PRIVILEGES ON \`uboss_test\`.*        TO 'uboss_migrate'@'%';
GRANT ALL PRIVILEGES ON \`uboss_shadow\`.*      TO 'uboss_migrate'@'%';
GRANT ALL PRIVILEGES ON \`uboss_test_shadow\`.* TO 'uboss_migrate'@'%';
GRANT ALL PRIVILEGES ON \`uboss_restore\`.*     TO 'uboss_migrate'@'%';

-- --- The backup user ------------------------------------------------------
--
-- Database-scoped, and NOTHING at the server level. That is not an oversight
-- and it was checked rather than assumed: with exactly these five privileges,
-- \`mariadb-dump --single-transaction --quick --routines --triggers --events
-- --hex-blob --no-tablespaces\` completes with no warnings and a proper
-- "Dump completed" marker.
--
-- The two that are commonly granted here and are NOT needed:
--   PROCESS   would be required to dump tablespace definitions - which is why
--             backup.sh passes --no-tablespaces. PROCESS also lets the holder
--             read every other connection's running query in SHOW PROCESSLIST,
--             which on this schema means other people's data.
--   RELOAD    is for --flush-logs, and BINLOG MONITOR for --master-data.
--             Neither flag is used: those belong to a replication setup this
--             does not have. Binary logs are shipped separately by
--             uboss_binlog, which has no SELECT on any table.
CREATE USER IF NOT EXISTS 'uboss_backup'@'%' IDENTIFIED BY '${MARIADB_BACKUP_PASSWORD}';
GRANT SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER ON \`uboss\`.*         TO 'uboss_backup'@'%';
GRANT SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER ON \`uboss_restore\`.* TO 'uboss_backup'@'%';

-- --- Hygiene --------------------------------------------------------------
--
-- What \`mariadb-secure-installation\` does. The official image already does
-- most of it; these are here so the compat database and the production
-- database answer the same audit query the same way.
DELETE FROM mysql.global_priv WHERE User = '';
DROP DATABASE IF EXISTS test;

FLUSH PRIVILEGES;
SQL

echo "[uboss-compat] databases and least-privilege accounts created"
