-- Widen every `correlationId` from CHAR(26) to VARCHAR(64).
--
-- WHY THIS IS A BUG AND NOT A TIDY-UP
--
-- `app.ts` accepts a client-supplied `x-correlation-id` of **up to 64
-- characters** and echoes it on the response, so that a caller can follow one
-- request through their systems and ours. Ten columns then stored it in
-- CHAR(26), which is the width of a ULID -- the length of the id we generate
-- when the client supplies none.
--
-- On MariaDB 10.4, which is what XAMPP ships and what development runs, an
-- over-long value is silently truncated and nobody notices. On MariaDB 10.11,
-- which is what Ubuntu packages and what production runs, `sql_mode` includes
-- STRICT_TRANS_TABLES and the same insert **fails**:
--
--   ERROR 1406: Data too long for column 'correlationId' at row 1
--
-- Several of these writes happen inside a transaction, where the failure does
-- not merely lose an audit row -- it rolls the business change back with it. A
-- customer whose API gateway stamps its own trace header would have had orders
-- refused, and the message would have named a logging column.
--
-- Found by running the suite against a strict `sql_mode` before trusting CI to
-- run it against a strict server.
--
-- SAFE IN ONE RELEASE. Widening a column is the expand half of expand-and-
-- contract: every existing value still fits, old code writing <= 26 characters
-- still works against the new shape, and nothing reads a length. No row is
-- rewritten -- MariaDB copies the table for these, so on a large `audit_logs`
-- expect this to take a moment and hold a lock while it does.
--
-- CHAR -> VARCHAR also drops the blank padding CHAR applies on storage. Values
-- come back the same, because MariaDB already strips trailing spaces from CHAR
-- on retrieval.

ALTER TABLE `order_status_history`        MODIFY `correlationId` VARCHAR(64) NULL;
ALTER TABLE `audit_logs`                  MODIFY `correlationId` VARCHAR(64) NULL;
ALTER TABLE `erp_inventory_sync_runs`     MODIFY `correlationId` VARCHAR(64) NOT NULL;
ALTER TABLE `integration_events`          MODIFY `correlationId` VARCHAR(64) NOT NULL;
ALTER TABLE `customer_erp_sync_events`    MODIFY `correlationId` VARCHAR(64) NOT NULL;
ALTER TABLE `customer_erp_sync_jobs`      MODIFY `correlationId` VARCHAR(64) NOT NULL;
ALTER TABLE `customer_erp_webhook_events` MODIFY `correlationId` VARCHAR(64) NOT NULL;
ALTER TABLE `customer_erp_audit_logs`     MODIFY `correlationId` VARCHAR(64) NULL;
ALTER TABLE `seller_audit_logs`           MODIFY `correlationId` VARCHAR(64) NULL;
ALTER TABLE `logistics_audit_logs`        MODIFY `correlationId` VARCHAR(64) NULL;
