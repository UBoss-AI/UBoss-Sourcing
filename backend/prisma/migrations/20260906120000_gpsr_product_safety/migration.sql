-- Product safety (GPSR, Regulation (EU) 2023/988).
--
-- Additive. Every new product column is nullable and `gpsrEnforced` defaults
-- to false, so an existing catalogue keeps publishing exactly as it did. The
-- checks become blocking only once a deployment turns enforcement on.

-- AlterTable
ALTER TABLE `business_profile` ADD COLUMN `gpsrEnforced` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `product_translations` ADD COLUMN `safetyInstructions` TEXT NULL,
    ADD COLUMN `safetyWarnings` TEXT NULL;

-- AlterTable
ALTER TABLE `products` ADD COLUMN `euResponsibleId` CHAR(26) NULL,
    ADD COLUMN `gtin` VARCHAR(14) NULL,
    ADD COLUMN `manufacturerId` CHAR(26) NULL,
    ADD COLUMN `modelIdentifier` VARCHAR(64) NULL,
    ADD COLUMN `safetyInstructions` TEXT NULL,
    ADD COLUMN `safetyWarnings` TEXT NULL;

-- CreateTable
CREATE TABLE `economic_operators` (
    `id` CHAR(26) NOT NULL,
    `role` ENUM('MANUFACTURER', 'EU_RESPONSIBLE_PERSON', 'IMPORTER') NOT NULL,
    `legalName` VARCHAR(255) NOT NULL,
    `tradeName` VARCHAR(255) NULL,
    `addressJson` JSON NOT NULL,
    `countryCode` CHAR(2) NOT NULL,
    `email` VARCHAR(320) NOT NULL,
    `phone` VARCHAR(32) NULL,
    `website` VARCHAR(512) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdById` CHAR(26) NULL,

    INDEX `ix_economic_operator_role`(`role`, `isActive`),
    INDEX `ix_economic_operator_name`(`legalName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ix_product_manufacturer` ON `products`(`manufacturerId`);

-- CreateIndex
CREATE INDEX `ix_product_eu_responsible` ON `products`(`euResponsibleId`);

-- CreateIndex
CREATE INDEX `ix_product_gtin` ON `products`(`gtin`);

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_manufacturerId_fkey` FOREIGN KEY (`manufacturerId`) REFERENCES `economic_operators`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_euResponsibleId_fkey` FOREIGN KEY (`euResponsibleId`) REFERENCES `economic_operators`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
