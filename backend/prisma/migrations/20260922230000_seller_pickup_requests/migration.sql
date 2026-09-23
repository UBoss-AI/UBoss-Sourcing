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
-- ROLLBACK: drop the CHECK, drop the two foreign keys, drop the five columns,
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
        ON DELETE SET NULL ON UPDATE CASCADE;

-- Exactly one arranger. Not "at least one": a collection that named both would
-- be booked twice, and the second van is the one nobody cancels.
ALTER TABLE `logistics_pickup_requests`
    ADD CONSTRAINT `chk_logistics_pickup_arranger` CHECK (
        (`logisticsPartnerId` IS NOT NULL AND `sellerCarrierConnectionId` IS NULL)
        OR (`logisticsPartnerId` IS NULL AND `sellerCarrierConnectionId` IS NOT NULL)
    );

CREATE INDEX `ix_logistics_pickup_seller` ON `logistics_pickup_requests`(`sellerAccountId`, `windowStartAt`);
