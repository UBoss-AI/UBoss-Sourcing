-- Purchasing limits move from bare columns on `customer_profiles` to one row
-- per currency in `customer_limits`.
--
-- Order matters here: the table is created and the existing amounts copied into
-- it BEFORE the old columns are dropped. Prisma's own diff would drop first and
-- silently take every configured credit limit with it.

-- CreateTable
CREATE TABLE `customer_limits` (
    `customerProfileId` CHAR(26) NOT NULL,
    `currencyCode` CHAR(3) NOT NULL,
    `perOrderMinMinor` BIGINT NULL,
    `perOrderMaxMinor` BIGINT NULL,
    `monthlySpendCapMinor` BIGINT NULL,
    `approvalThresholdMinor` BIGINT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` CHAR(26) NULL,

    INDEX `ix_customer_limit_currency`(`currencyCode`),
    PRIMARY KEY (`customerProfileId`, `currencyCode`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Carry the existing limits over as the base currency's row. They were always
-- denominated in it; nothing was ever recorded about which currency they meant.
INSERT INTO `customer_limits`
  (`customerProfileId`, `currencyCode`, `perOrderMinMinor`, `perOrderMaxMinor`,
   `monthlySpendCapMinor`, `approvalThresholdMinor`, `createdAt`, `updatedAt`)
SELECT
  p.`id`,
  COALESCE(
    (SELECT c.`code` FROM `currencies` c WHERE c.`isBase` = 1 AND c.`isActive` = 1 LIMIT 1),
    (SELECT b.`currency` FROM `business_profile` b LIMIT 1),
    'INR'
  ),
  p.`perOrderMinMinor`,
  p.`perOrderMaxMinor`,
  p.`monthlySpendCapMinor`,
  p.`approvalThresholdMinor`,
  NOW(3),
  NOW(3)
FROM `customer_profiles` p
WHERE p.`perOrderMinMinor` IS NOT NULL
   OR p.`perOrderMaxMinor` IS NOT NULL
   OR p.`monthlySpendCapMinor` IS NOT NULL
   OR p.`approvalThresholdMinor` IS NOT NULL;

-- AddForeignKey
ALTER TABLE `customer_limits` ADD CONSTRAINT `customer_limits_customerProfileId_fkey` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_limits` ADD CONSTRAINT `customer_limits_currencyCode_fkey` FOREIGN KEY (`currencyCode`) REFERENCES `currencies`(`code`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Only now that the values are safely copied.
-- AlterTable
ALTER TABLE `customer_profiles` DROP COLUMN `approvalThresholdMinor`,
    DROP COLUMN `monthlySpendCapMinor`,
    DROP COLUMN `perOrderMaxMinor`,
    DROP COLUMN `perOrderMinMinor`;
