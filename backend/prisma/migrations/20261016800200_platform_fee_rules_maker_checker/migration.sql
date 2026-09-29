-- Fee rules beyond the versioned platform-fee policy (value band, volume
-- tier, seller tier, promotion) and maker-checker on publishing both.
--
-- A policy or rule now goes DRAFT -> PENDING_APPROVAL -> PUBLISHED, and the
-- approver may not be the person who created, last edited or submitted it.

-- AlterTable
ALTER TABLE `platform_fee_policies`
    MODIFY `status` ENUM('DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'RETIRED') NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN `lastEditedByUserId` CHAR(26) NULL,
    ADD COLUMN `submittedByUserId` CHAR(26) NULL,
    ADD COLUMN `submittedAt` DATETIME(3) NULL,
    ADD COLUMN `rejectedByUserId` CHAR(26) NULL,
    ADD COLUMN `rejectedAt` DATETIME(3) NULL,
    ADD COLUMN `rejectionReason` VARCHAR(1000) NULL;

-- AlterTable
ALTER TABLE `seller_accounts` ADD COLUMN `feeTier` VARCHAR(32) NULL;

-- CreateTable
CREATE TABLE `platform_fee_rules` (
    `id` CHAR(26) NOT NULL,
    `kind` ENUM('VALUE_BAND', 'VOLUME_TIER', 'SELLER_TIER', 'PROMOTION') NOT NULL,
    `scope` ENUM('GLOBAL', 'MARKET', 'CATEGORY', 'SELLER') NOT NULL,
    `scopeKey` VARCHAR(64) NOT NULL,
    `sellerAccountId` CHAR(26) NULL,
    `categoryId` CHAR(26) NULL,
    `marketCountry` CHAR(2) NULL,
    `status` ENUM('DRAFT', 'PENDING_APPROVAL', 'PUBLISHED', 'RETIRED') NOT NULL DEFAULT 'DRAFT',
    `name` VARCHAR(160) NOT NULL,
    `currency` CHAR(3) NULL,
    `minValueMinor` BIGINT NULL,
    `maxValueMinor` BIGINT NULL,
    `volumeThresholdMinor` BIGINT NULL,
    `volumeWindowDays` SMALLINT NULL,
    `sellerTier` VARCHAR(32) NULL,
    `percentRate` DECIMAL(9, 6) NULL,
    `discountPercent` DECIMAL(9, 6) NULL,
    `effectiveFrom` DATETIME(3) NOT NULL,
    `effectiveTo` DATETIME(3) NULL,
    `notes` VARCHAR(1024) NULL,
    `supersedesRuleId` CHAR(26) NULL,
    `createdByUserId` CHAR(26) NULL,
    `lastEditedByUserId` CHAR(26) NULL,
    `submittedByUserId` CHAR(26) NULL,
    `submittedAt` DATETIME(3) NULL,
    `publishedByUserId` CHAR(26) NULL,
    `publishedAt` DATETIME(3) NULL,
    `rejectedByUserId` CHAR(26) NULL,
    `rejectedAt` DATETIME(3) NULL,
    `rejectionReason` VARCHAR(1000) NULL,
    `retiredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_platform_fee_rule_status`(`status`, `kind`),
    INDEX `ix_platform_fee_rule_scope`(`scopeKey`, `status`),
    PRIMARY KEY (`id`),
    -- The amounts a rule is made of are never negative, rates are percentages,
    -- and a band or a date range ends after it starts.
    CONSTRAINT `chk_fee_rule_amounts` CHECK (
        (`minValueMinor` IS NULL OR `minValueMinor` >= 0)
        AND (`maxValueMinor` IS NULL OR `maxValueMinor` >= 0)
        AND (`volumeThresholdMinor` IS NULL OR `volumeThresholdMinor` >= 0)
        AND (`volumeWindowDays` IS NULL OR (`volumeWindowDays` >= 1 AND `volumeWindowDays` <= 3660))
        AND (`percentRate` IS NULL OR (`percentRate` >= 0 AND `percentRate` <= 100))
        AND (`discountPercent` IS NULL OR (`discountPercent` > 0 AND `discountPercent` <= 100))
        AND (`minValueMinor` IS NULL OR `maxValueMinor` IS NULL OR `maxValueMinor` > `minValueMinor`)
        AND (`effectiveTo` IS NULL OR `effectiveTo` > `effectiveFrom`)
    )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_fee_rule_applications` (
    `id` CHAR(26) NOT NULL,
    `settlementId` CHAR(26) NOT NULL,
    `ruleId` CHAR(26) NOT NULL,
    `kind` ENUM('VALUE_BAND', 'VOLUME_TIER', 'SELLER_TIER', 'PROMOTION') NOT NULL,
    `effectMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_fee_rule_app`(`settlementId`, `ruleId`),
    INDEX `ix_fee_rule_app_rule`(`ruleId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `platform_fee_rule_applications` ADD CONSTRAINT `fk_fee_rule_app_settlement` FOREIGN KEY (`settlementId`) REFERENCES `seller_order_settlements`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `platform_fee_rule_applications` ADD CONSTRAINT `fk_fee_rule_app_rule` FOREIGN KEY (`ruleId`) REFERENCES `platform_fee_rules`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
