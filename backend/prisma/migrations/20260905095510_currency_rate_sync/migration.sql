-- NOTE: this migration used to rename two foreign keys on
-- `admin_notification_reads`, a table that 20260905120000 creates AFTER this
-- runs. It was generated against a database where that table already existed,
-- so the chain applied there and failed on every fresh install with
-- "Table 'admin_notification_reads' doesn't exist". The constraint names it
-- was reaching for are now written directly by the migration that creates the
-- table, which is where they belong.

-- DropForeignKey
ALTER TABLE `category_translations` DROP FOREIGN KEY `fk_category_translation_category`;

-- DropForeignKey
ALTER TABLE `product_translations` DROP FOREIGN KEY `fk_product_translation_product`;

-- DropIndex
DROP INDEX `ix_category_path` ON `categories`;

-- AlterTable
ALTER TABLE `product_prices` ADD COLUMN `isAutoConverted` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `currency_rate_sync` (
    `id` CHAR(26) NOT NULL,
    `isEnabled` BOOLEAN NOT NULL DEFAULT false,
    `marginPercent` DECIMAL(5, 2) NOT NULL DEFAULT 0.00,
    `rounding` VARCHAR(8) NOT NULL DEFAULT 'charm',
    `maxDriftPercent` DECIMAL(5, 2) NOT NULL DEFAULT 15.00,
    `lastRunAt` DATETIME(3) NULL,
    `lastRunStatus` VARCHAR(16) NULL,
    `lastRunMessage` VARCHAR(512) NULL,
    `lastRunUpdated` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` CHAR(26) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ix_category_path` ON `categories`(`path`);

-- AddForeignKey
ALTER TABLE `product_translations` ADD CONSTRAINT `product_translations_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `category_translations` ADD CONSTRAINT `category_translations_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
