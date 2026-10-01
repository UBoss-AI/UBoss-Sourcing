-- A member of staff's written override of a seller order's pre-dispatch
-- compliance hold (JOURNEY-049): a prohibited match, a missing or unaccepted
-- document, or an unverified HS code. One row per seller order; the keys it
-- covers are the holds that existed when it was granted, so a new cause holds
-- the goods again. A new table only, so it is safe on a live installation.

-- CreateTable
CREATE TABLE `trade_compliance_overrides` (
    `id` CHAR(26) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `reason` VARCHAR(1000) NOT NULL,
    `holdKeysJson` JSON NOT NULL,
    `grantedByStaffId` CHAR(26) NOT NULL,
    `grantedByLabel` VARCHAR(160) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `revokedByStaffId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_trade_override_group`(`sellerOrderGroupId`),
    INDEX `ix_trade_override_order`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `trade_compliance_overrides` ADD CONSTRAINT `trade_compliance_overrides_sellerOrderGroupId_fkey` FOREIGN KEY (`sellerOrderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
