-- Seller notifications gain a resolved state, and a dedupe key that is a
-- constraint rather than a query.
--
-- WHY THE COLUMN ORDER BELOW IS NOT NEGOTIABLE
--
-- `dedupeKey` is NOT NULL and carries a UNIQUE index with it. Adding both in
-- one statement - which is what `prisma migrate diff` generates - fills every
-- existing row with '' and then tries to build a unique index over
-- (sellerAccountId, kind, ''), which collides for any seller that already has
-- two notifications of the same kind. On the development database at the time
-- of writing that was 40 rows and 5 colliding groups, so this is not a
-- theoretical concern.
--
-- So it goes in NULLABLE, is backfilled with each row's own id - unique by
-- construction, and honest: an old row announced itself and nothing else - and
-- only then becomes NOT NULL with the index on top.
--
-- SAFE TO RUN ON A LIVE DEPLOYMENT
--
--   * Every other added column is nullable or carries a default.
--   * `class` defaults to INFORMATION and `status` to ACTIVE, so every
--     existing notification keeps behaving exactly as it did: news, cleared by
--     being read.
--   * The `kind` enum gains four members and loses none.
--
-- ROLLBACK
--
-- Drop the three indexes, then the seven columns, then restore the previous
-- `kind` enum. No existing column changes meaning and no data is destroyed.

-- 1. The state columns. All defaulted, so existing rows are unaffected.
ALTER TABLE `seller_notifications`
    ADD COLUMN `class` ENUM('INFORMATION', 'ALERT') NOT NULL DEFAULT 'INFORMATION',
    ADD COLUMN `status` ENUM('ACTIVE', 'RESOLVED', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN `resolutionKey` VARCHAR(120) NULL,
    ADD COLUMN `resolvedAt` DATETIME(3) NULL,
    ADD COLUMN `resolutionSource` ENUM('DOMAIN_EVENT', 'MANUAL', 'SYSTEM_SWEEP', 'SUPERSEDED') NULL,
    ADD COLUMN `resolutionNote` VARCHAR(512) NULL;

-- 2. The dedupe key, nullable for now.
ALTER TABLE `seller_notifications` ADD COLUMN `dedupeKey` VARCHAR(120) NULL;

-- 3. Backfill. A row's own id is unique by construction, and says the honest
--    thing about a notification written before keys existed: it announced
--    itself, and nothing can be deduplicated against it.
UPDATE `seller_notifications` SET `dedupeKey` = `id` WHERE `dedupeKey` IS NULL;

-- 4. Now it can be required.
ALTER TABLE `seller_notifications` MODIFY `dedupeKey` VARCHAR(120) NOT NULL;

-- 5. The four new kinds. Additive; nothing is removed or renamed.
ALTER TABLE `seller_notifications` MODIFY `kind` ENUM(
    'APPLICATION_STATUS', 'LISTING_DECISION', 'NEW_ORDER', 'DISPATCH_SLA_WARNING',
    'LOW_STOCK', 'ERP_SYNC_FAILURE', 'DOCUMENT_EXPIRING', 'PAYOUT_RESULT',
    'RETURN_OR_DISPUTE', 'SECURITY_EVENT', 'BRAND_REQUEST_DECISION',
    'CARRIER_ARRANGEMENT_DECISION', 'CARRIER_ACCEPTED', 'CARRIER_REJECTED',
    'CARRIER_OFFER_EXPIRED'
) NOT NULL;

-- 6. Indexes last, once the data they cover is in a state they accept.
CREATE UNIQUE INDEX `uq_seller_notification_dedupe` ON `seller_notifications`(`sellerAccountId`, `kind`, `dedupeKey`);
CREATE INDEX `ix_seller_notification_active` ON `seller_notifications`(`sellerAccountId`, `status`, `class`);
CREATE INDEX `ix_seller_notification_resolution` ON `seller_notifications`(`resolutionKey`, `status`);
