-- ===========================================================================
-- GENERATES the grants that can only be issued once the tables exist.
--
-- This file prints SQL. It does not execute it. Run it, read what it wants to
-- do, then pipe it back in - `deploy/scripts/apply-grants.sh` does both steps
-- and verifies the result, and is what you should normally use:
--
--   sudo /srv/uboss/current/deploy/scripts/apply-grants.sh
--
-- By hand, on the VPS:
--
--   sudo mariadb -N -B uboss \
--     -e "SET @app_user='uboss_app'; SET @app_host='localhost'; SOURCE /srv/uboss/current/deploy/mariadb/post-migrate-grants.sql" \
--     | sudo mariadb uboss
--
-- RUN IT AFTER EVERY `prisma migrate deploy` THAT ADDS A TABLE. A new table
-- arrives with no table-level grant, so the runtime user cannot write to it,
-- and the symptom is a feature that works everywhere except production with
-- "command denied to user 'uboss_app'".
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS A GENERATOR AND NOT FIVE LINES OF GRANT/REVOKE
--
-- The obvious way to make the audit log append-only is:
--
--     GRANT SELECT, INSERT, UPDATE, DELETE ON uboss.* TO 'uboss_app'@'localhost';
--     REVOKE UPDATE, DELETE ON uboss.audit_logs FROM 'uboss_app'@'localhost';
--
-- That is what this repository documented for months, and IT DOES NOT WORK.
-- MariaDB answers:
--
--     ERROR 1147 (42000): There is no such grant defined for user 'uboss_app'
--                         on host 'localhost' on table 'audit_logs'
--
-- A privilege granted at DATABASE level cannot be revoked at TABLE level. The
-- database-level grant is one row in `mysql.db`; there is no per-table row to
-- take anything away from. MySQL and MariaDB have always behaved this way.
--
-- The failure is worse than "the revoke did nothing", because the statement
-- errors: a go-live script that runs these in sequence stops here, having
-- created some of the accounts and not the rest.
--
-- So the grant has to be issued per table in the first place, for every table
-- EXCEPT the ones that are meant to be read-only - and "every table" is a list
-- that changes with every migration. Hence a generator, which reads the table
-- list from the database rather than from somebody's memory.
-- ---------------------------------------------------------------------------
--
-- Set these two before sourcing this file. They default to production's
-- account if you do not:
--
--   SET @app_user = 'uboss_app';
--   SET @app_host = 'localhost';   -- '%' in the local compat container
-- ===========================================================================

SET @app_user = IFNULL(@app_user, 'uboss_app');
SET @app_host = IFNULL(@app_host, 'localhost');
SET @db       = DATABASE();

SET SESSION group_concat_max_len = 1048576;

-- --- 1. Drop the blanket database-level write grant ------------------------
--
-- SELECT and INSERT stay at database level: the application reads everything
-- and appends to everything, including the audit log. It is UPDATE and DELETE
-- that have to become per-table, because those are the two the audit log must
-- never receive.
SELECT CONCAT('REVOKE UPDATE, DELETE ON `', @db, '`.* FROM ''', @app_user, '''@''', @app_host, ''';') AS ddl;
SELECT CONCAT('GRANT SELECT, INSERT ON `', @db, '`.* TO ''', @app_user, '''@''', @app_host, ''';') AS ddl;

-- --- 2. Grant UPDATE and DELETE on every table except the protected ones ---
--
-- APPEND-ONLY, AND WHY EACH ONE:
--
--   audit_logs             Records who approved a seller, who changed a price,
--                          who exported a customer's data. A system whose audit
--                          trail can be edited by the thing being audited has
--                          no audit trail. This is a database grant rather than
--                          a code convention because a code convention is one
--                          careless service method away from not being true.
--
--   _prisma_migrations     How `migrate deploy` knows what has already run. An
--                          application that can write here can convince the
--                          next release that a migration it has never applied
--                          is done, and the failure appears hours later as a
--                          missing column. SELECT stays: the readiness probe
--                          reports the applied count.
SELECT CONCAT('GRANT UPDATE, DELETE ON `', @db, '`.`', TABLE_NAME, '` TO ''', @app_user, '''@''', @app_host, ''';') AS ddl
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = @db
   AND TABLE_TYPE = 'BASE TABLE'
   AND TABLE_NAME NOT IN ('audit_logs', '_prisma_migrations')
 ORDER BY TABLE_NAME;

SELECT 'FLUSH PRIVILEGES;' AS ddl;

-- --- 3. Prove it took ------------------------------------------------------
--
-- Piped back in, this prints one row per protected table. Two rows, naming
-- audit_logs and _prisma_migrations and NOTHING else, is what success looks
-- like. No rows means the revoke went to a differently-spelled account - check
-- the host part before assuming it worked.
SELECT CONCAT(
  'SELECT ''PROTECTED'' AS status, t.TABLE_NAME, ',
  'IF(EXISTS(SELECT 1 FROM mysql.tables_priv p WHERE p.User=''', @app_user, ''' AND p.Host=''', @app_host, ''' ',
  'AND p.Db=''', @db, ''' AND p.Table_name=t.TABLE_NAME AND FIND_IN_SET(''Update'', p.Table_priv)), ''WRITABLE - NOT PROTECTED'', ''append-only'') AS state ',
  'FROM information_schema.TABLES t WHERE t.TABLE_SCHEMA=''', @db, ''' ',
  'AND t.TABLE_NAME IN (''audit_logs'', ''_prisma_migrations'');'
) AS ddl;
