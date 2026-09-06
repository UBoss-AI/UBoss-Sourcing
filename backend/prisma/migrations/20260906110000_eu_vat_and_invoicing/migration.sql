-- EU VAT and invoicing.
--
-- Additive throughout. Every new column is nullable or carries a default, and
-- `orders.taxTreatment` defaults to FLAT_RATE - which is exactly what an
-- existing deployment was already doing, so nothing already shipped changes
-- meaning. VAT resolution only starts once a business profile has a vatCountry
-- and the rate table has rows.

-- AlterTable
ALTER TABLE `business_profile` ADD COLUMN `vatCountry` CHAR(2) NULL,
    ADD COLUMN `vatNumber` VARCHAR(32) NULL;

-- AlterTable
ALTER TABLE `countries` ADD COLUMN `isEuVat` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `customer_profiles` ADD COLUMN `vatNumber` VARCHAR(32) NULL,
    ADD COLUMN `vatNumberCheckedAt` DATETIME(3) NULL,
    ADD COLUMN `vatNumberReference` VARCHAR(64) NULL,
    ADD COLUMN `vatNumberValid` BOOLEAN NULL;

-- AlterTable
ALTER TABLE `orders` ADD COLUMN `buyerVatNumberSnapshot` VARCHAR(32) NULL,
    ADD COLUMN `sellerVatNumberSnapshot` VARCHAR(32) NULL,
    ADD COLUMN `taxCountry` CHAR(2) NULL,
    ADD COLUMN `taxTreatment` ENUM('FLAT_RATE', 'DOMESTIC', 'INTRA_EU_REVERSE_CHARGE', 'INTRA_EU_B2C', 'EXPORT') NOT NULL DEFAULT 'FLAT_RATE';

-- AlterTable
ALTER TABLE `tax_classes` ADD COLUMN `vatCategory` ENUM('STANDARD', 'REDUCED', 'SUPER_REDUCED', 'ZERO', 'EXEMPT') NULL;

-- CreateTable
CREATE TABLE `vat_rates` (
    `id` CHAR(26) NOT NULL,
    `countryCode` CHAR(2) NOT NULL,
    `category` ENUM('STANDARD', 'REDUCED', 'SUPER_REDUCED', 'ZERO', 'EXEMPT') NOT NULL,
    `ratePercent` DECIMAL(9, 6) NOT NULL,
    `label` VARCHAR(128) NULL,
    `validFrom` DATE NOT NULL,
    `validTo` DATE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_vat_rate_lookup`(`countryCode`, `category`, `validFrom`),
    UNIQUE INDEX `uq_vat_rate_period`(`countryCode`, `category`, `validFrom`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `vat_number_checks` (
    `id` CHAR(26) NOT NULL,
    `countryCode` CHAR(2) NOT NULL,
    `number` VARCHAR(32) NOT NULL,
    `isValid` BOOLEAN NOT NULL,
    `registeredName` VARCHAR(255) NULL,
    `registeredAddress` VARCHAR(512) NULL,
    `consultationNumber` VARCHAR(64) NULL,
    `unavailableReason` VARCHAR(255) NULL,
    `checkedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_vat_number_check_time`(`checkedAt`),
    UNIQUE INDEX `uq_vat_number_check`(`countryCode`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invoices` (
    `id` CHAR(26) NOT NULL,
    `number` VARCHAR(32) NOT NULL,
    `series` VARCHAR(16) NOT NULL DEFAULT 'INV',
    `orderId` CHAR(26) NOT NULL,
    `issuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `suppliedAt` DATETIME(3) NOT NULL,
    `sellerJson` JSON NOT NULL,
    `buyerJson` JSON NOT NULL,
    `sellerVatNumber` VARCHAR(32) NULL,
    `buyerVatNumber` VARCHAR(32) NULL,
    `taxTreatment` ENUM('FLAT_RATE', 'DOMESTIC', 'INTRA_EU_REVERSE_CHARGE', 'INTRA_EU_B2C', 'EXPORT') NOT NULL,
    `taxCountry` CHAR(2) NULL,
    `exemptionNote` VARCHAR(512) NULL,
    `currency` CHAR(3) NOT NULL,
    `linesJson` JSON NOT NULL,
    `vatBreakdownJson` JSON NOT NULL,
    `subtotalMinor` BIGINT NOT NULL,
    `discountMinor` BIGINT NOT NULL DEFAULT 0,
    `taxMinor` BIGINT NOT NULL DEFAULT 0,
    `shippingMinor` BIGINT NOT NULL DEFAULT 0,
    `grandTotalMinor` BIGINT NOT NULL,
    `creditsInvoiceId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_invoice_number`(`number`),
    INDEX `ix_invoice_order`(`orderId`),
    INDEX `ix_invoice_issued`(`issuedAt`),
    INDEX `ix_invoice_treatment`(`taxTreatment`, `issuedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_creditsInvoiceId_fkey` FOREIGN KEY (`creditsInvoiceId`) REFERENCES `invoices`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
