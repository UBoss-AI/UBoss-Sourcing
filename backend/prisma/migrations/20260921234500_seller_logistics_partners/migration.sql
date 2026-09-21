-- Which carriers a seller may use.
--
-- The missing link between two features that were each complete on their own:
-- a seller could dispatch, and a carrier could be assigned work and put a
-- driver on it, but nothing recorded WHICH carriers a given seller was
-- entitled to hand a parcel to. The only answer available was "any of them".
--
-- PURELY ADDITIVE
--
-- One new table, two foreign keys, no existing column altered and no backfill.
-- An existing deployment gains a table that is empty, and an empty table means
-- no seller can offer work to any carrier yet - which is the correct and safe
-- starting state, not a regression. Operator-side assignment is untouched and
-- continues to work exactly as before.
--
-- ROLLBACK
--
-- `DROP TABLE seller_logistics_partners;` and nothing else. No other table
-- references it.

-- CreateTable
CREATE TABLE `seller_logistics_partners` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `logisticsPartnerId` CHAR(26) NOT NULL,
    `relationshipType` ENUM('DIRECT_CONTRACT', 'MARKETPLACE_BROKERED', 'PREFERRED') NOT NULL DEFAULT 'MARKETPLACE_BROKERED',
    `status` ENUM('REQUESTED', 'APPROVED', 'REJECTED', 'SUSPENDED', 'ENDED') NOT NULL DEFAULT 'REQUESTED',
    `requestedBySellerMemberId` CHAR(26) NULL,
    `decidedByUserId` CHAR(26) NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decidedAt` DATETIME(3) NULL,
    `effectiveFrom` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `effectiveTo` DATETIME(3) NULL,
    `serviceCountriesJson` JSON NULL,
    `approvedCapabilitiesJson` JSON NULL,
    `sellerReference` VARCHAR(64) NULL,
    `statusReason` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `archivedAt` DATETIME(3) NULL,

    INDEX `ix_seller_logistics_by_seller`(`sellerAccountId`, `status`),
    INDEX `ix_seller_logistics_by_partner`(`logisticsPartnerId`, `status`),
    INDEX `ix_seller_logistics_pending`(`status`, `requestedAt`),
    UNIQUE INDEX `uq_seller_logistics_pair`(`sellerAccountId`, `logisticsPartnerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `seller_logistics_partners` ADD CONSTRAINT `seller_logistics_partners_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_logistics_partners` ADD CONSTRAINT `seller_logistics_partners_logisticsPartnerId_fkey` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

