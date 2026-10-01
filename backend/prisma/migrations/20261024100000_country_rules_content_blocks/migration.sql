-- Master rows 69 and 72.
--
--   * market_rules gains a value threshold: a rule with one applies only to
--     an order at or above that total in that currency. Both columns are set
--     together or not at all (chk_market_rule_threshold).
--   * content_blocks: storefront banners and category content blocks, with
--     country / language targeting, a schedule and a published flag. A block
--     may promote an existing coupon; deleting the coupon unlinks it.
--
-- content_blocks holds no userId / customerProfileId; createdByUserId and
-- updatedByUserId name staff only.

-- AlterTable
ALTER TABLE `market_rules`
    ADD COLUMN `minOrderValueMinor` BIGINT NULL,
    ADD COLUMN `thresholdCurrency` CHAR(3) NULL;

ALTER TABLE `market_rules`
    ADD CONSTRAINT `chk_market_rule_threshold` CHECK (
        (`minOrderValueMinor` IS NULL AND `thresholdCurrency` IS NULL)
        OR (`minOrderValueMinor` IS NOT NULL AND `minOrderValueMinor` > 0 AND `thresholdCurrency` IS NOT NULL)
    );

-- CreateTable
CREATE TABLE `content_blocks` (
    `id` CHAR(26) NOT NULL,
    `placement` ENUM('HOME_BANNER', 'CATEGORY_BLOCK') NOT NULL,
    `categoryId` CHAR(26) NULL,
    `title` VARCHAR(160) NOT NULL,
    `body` TEXT NULL,
    `imageUrl` VARCHAR(1024) NULL,
    `linkUrl` VARCHAR(1024) NULL,
    `couponId` CHAR(26) NULL,
    `countryCode` VARCHAR(2) NOT NULL DEFAULT '',
    `languageCode` VARCHAR(8) NOT NULL DEFAULT '',
    `startsAt` DATETIME(3) NULL,
    `endsAt` DATETIME(3) NULL,
    `isPublished` BOOLEAN NOT NULL DEFAULT false,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdByUserId` CHAR(26) NULL,
    `updatedByUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_content_block_live`(`placement`, `isPublished`, `countryCode`),
    INDEX `ix_content_block_category`(`categoryId`),
    INDEX `ix_content_block_coupon`(`couponId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chk_content_block_category` CHECK (
        (`placement` = 'HOME_BANNER' AND `categoryId` IS NULL)
        OR (`placement` = 'CATEGORY_BLOCK' AND `categoryId` IS NOT NULL)
    ),
    CONSTRAINT `chk_content_block_schedule` CHECK (
        `startsAt` IS NULL OR `endsAt` IS NULL OR `endsAt` > `startsAt`
    )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `content_blocks` ADD CONSTRAINT `fk_content_block_category` FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `content_blocks` ADD CONSTRAINT `fk_content_block_coupon` FOREIGN KEY (`couponId`) REFERENCES `coupons`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;
