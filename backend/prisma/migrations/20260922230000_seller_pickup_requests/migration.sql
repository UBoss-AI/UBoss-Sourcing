-- A seller booking a van, through their own carrier account.
--
-- `logistics_pickup_requests` already modelled a collection, and modelled it
-- well - one van call collects several consignments, and a consignment can
-- survive a failed collection and be taken the next day, neither of which a
-- column on the shipment expresses. What it assumed was that the collection is
-- always arranged with a delivery company this platform knows about.
--
-- That is no longer the only case. A seller who connected their own DHL
-- account books the van with DHL, under their own contract, and there is no
-- `logistics_partners` row anywhere in it - nor should there be, because DHL is
-- not a tenant of this marketplace and inventing a row for it would put a
-- company in the partner directory that nobody here has any relationship with.
--
-- So a collection is now arranged by EXACTLY ONE of two parties, and the
-- CHECK below says so rather than leaving it to every query to remember:
--
--   `logisticsPartnerId`        a delivery company inside the platform - the
--                               seller's own operation, or a courier that
--                               works for them
--   `sellerCarrierConnectionId` the seller's own account with an external
--                               carrier
--
-- `carrierPickupId` and `carrierConfirmationNumber` are what the carrier gave
-- back. The confirmation number is the one a seller reads out on the telephone
-- when the van has not arrived, which is the entire reason it is stored rather
-- than derived.
--
-- SAFE ON A LIVE DEPLOYMENT. `logisticsPartnerId` becomes NULLABLE, which
-- widens what the column accepts and invalidates no existing row; everything
-- else is a new nullable column. No backfill.
--
-- ROLLBACK: drop the CHECK, drop the two new foreign keys, restore
-- `logistics_pickup_requests_logisticsPartnerId_fkey` to ON UPDATE CASCADE
-- (see the note beside it below), drop the five columns,
-- then MODIFY `logisticsPartnerId` back to NOT NULL. That last step fails if
-- any collection has been booked through a seller's own carrier account, which
-- is correct - those rows have no partner to name and must be dealt with
-- deliberately rather than defaulted.

ALTER TABLE `logistics_pickup_requests`
    MODIFY `logisticsPartnerId` CHAR(26) NULL;

ALTER TABLE `logistics_pickup_requests`
    ADD COLUMN `sellerAccountId` CHAR(26) NULL AFTER `logisticsPartnerId`,
    ADD COLUMN `sellerCarrierConnectionId` CHAR(26) NULL AFTER `sellerAccountId`,
    ADD COLUMN `carrierPickupId` VARCHAR(128) NULL AFTER `sellerCarrierConnectionId`,
    ADD COLUMN `carrierConfirmationNumber` VARCHAR(64) NULL AFTER `carrierPickupId`,
    ADD COLUMN `cancelledAt` DATETIME(3) NULL AFTER `failedAt`;

ALTER TABLE `logistics_pickup_requests`
    ADD CONSTRAINT `logistics_pickup_requests_sellerAccountId_fkey`
        FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`)
        ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `logistics_pickup_requests_sellerConnectionId_fkey`
        FOREIGN KEY (`sellerCarrierConnectionId`) REFERENCES `seller_carrier_connections`(`id`)
        ON DELETE RESTRICT ON UPDATE RESTRICT;

-- WHY BOTH KEYS SAY RESTRICT, AND WHY THIS ONE IS REBUILT
--
-- From MariaDB 10.5 onwards, a CHECK constraint may not reference a column
-- that a foreign key can REWRITE. Two actions rewrite one: ON UPDATE CASCADE,
-- which copies a changed parent key down, and ON DELETE SET NULL, which writes
-- a NULL. Both would leave a checked row holding a value the check never saw.
-- ON DELETE CASCADE and RESTRICT are both still allowed, because they remove
-- the row or refuse the parent's change rather than editing this column.
--
-- 10.4, which development runs, allows all of it - so this applied cleanly on
-- every machine here and failed on the first fresh 11.4 it met.
--
-- For `sellerCarrierConnectionId` the refusal is pointing at a real conflict,
-- not a technicality. SET NULL would have emptied the column when a seller
-- deleted their carrier account, and the CHECK below says a collection must
-- name exactly one arranger - so SET NULL would have produced a row that
-- names NEITHER and breaks the invariant it sits next to. RESTRICT is the
-- honest answer: a carrier account with collections booked against it cannot
-- be deleted out from under them. Nothing in this codebase hard-deletes one;
-- disconnecting is a state change.
--
-- For `logisticsPartnerId` the CASCADE on update never had anything to do: a
-- `logistics_partners` id is a ULID generated once at insert. Prisma emits
-- ON UPDATE CASCADE on every relation by default, which is the only reason it
-- was there. It is dropped and re-added rather than edited in the migration
-- that created it, because that one has been applied and rewriting applied
-- history is how two databases end up disagreeing about what ran.
ALTER TABLE `logistics_pickup_requests`
    DROP FOREIGN KEY `logistics_pickup_requests_logisticsPartnerId_fkey`;

ALTER TABLE `logistics_pickup_requests`
    ADD CONSTRAINT `logistics_pickup_requests_logisticsPartnerId_fkey`
        FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`)
        ON DELETE CASCADE ON UPDATE RESTRICT;

-- Exactly one arranger. Not "at least one": a collection that named both would
-- be booked twice, and the second van is the one nobody cancels.
ALTER TABLE `logistics_pickup_requests`
    ADD CONSTRAINT `chk_logistics_pickup_arranger` CHECK (
        (`logisticsPartnerId` IS NOT NULL AND `sellerCarrierConnectionId` IS NULL)
        OR (`logisticsPartnerId` IS NULL AND `sellerCarrierConnectionId` IS NOT NULL)
    );

CREATE INDEX `ix_logistics_pickup_seller` ON `logistics_pickup_requests`(`sellerAccountId`, `windowStartAt`);
