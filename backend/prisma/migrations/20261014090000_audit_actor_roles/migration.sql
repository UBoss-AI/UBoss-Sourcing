-- The role an audit entry's actor held when they acted.
--
-- Stored on the row, at write time, rather than joined from `user_roles` when
-- the trail is read. A join answers "what is this person allowed to do today",
-- which is the wrong question about an entry from last year: a Finance
-- Approver who approved a refund and was later made Business Owner would
-- appear to have approved it as the owner.
--
-- Comma-separated role keys (e.g. `finance_approver`), NULL where there was no
-- signed-in actor, and NULL on every row written before this migration - those
-- rows never recorded a role, and inventing one from today's grants would be
-- the misleading answer this column exists to avoid.
--
-- Not personal data and not a pseudonymisation column: the audit maintenance
-- account's UPDATE grant stays on actorEmail, ipAddress and userAgent only.

-- AlterTable
ALTER TABLE `audit_logs` ADD COLUMN `actorRoles` VARCHAR(255) NULL AFTER `actorEmail`;
