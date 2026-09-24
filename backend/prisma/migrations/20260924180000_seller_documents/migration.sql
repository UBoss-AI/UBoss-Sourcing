-- Seller invoices and packing lists, per consignment.
--
-- A marketplace seller is the supplier of what they sell, so the tax invoice
-- is theirs: their legal name, their registration, their own numbered series.
-- One order may therefore carry several invoices and several packing lists -
-- one per seller per physical consignment.
--
-- Additive only. `logistics_shipment_documents.scanState` gains GENERATED at
-- the END of its enum (MariaDB stores an enum by position). No existing row is
-- changed. `seller_offers` gains two nullable columns the seller fills in.
--
-- Foreign keys are added before the CHECK constraints, and every key here is
-- ON UPDATE RESTRICT: MariaDB 11.4 refuses a CHECK on a column a cascading key
-- may rewrite (error 1901).

-- AlterTable
ALTER TABLE `logistics_shipment_documents` MODIFY `scanState` ENUM('PENDING', 'CLEAN', 'INFECTED', 'FAILED', 'SKIPPED', 'GENERATED') NOT NULL DEFAULT 'PENDING';

-- AlterTable
ALTER TABLE `logistics_shipment_packages` ADD COLUMN `containerNumber` VARCHAR(20) NULL,
    ADD COLUMN `netWeightGrams` INTEGER NULL,
    ADD COLUMN `sealNumber` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `logistics_shipments` ADD COLUMN `packedAt` DATETIME(3) NULL,
    ADD COLUMN `splitFromShipmentId` CHAR(26) NULL;

-- AlterTable
ALTER TABLE `seller_offers` ADD COLUMN `countryOfOrigin` CHAR(2) NULL,
    ADD COLUMN `hsnCode` VARCHAR(10) NULL;

-- CreateTable
CREATE TABLE `seller_invoice_settings` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `jurisdiction` ENUM('IN_GST', 'EU_VAT', 'GENERIC') NULL,
    `invoiceSeries` VARCHAR(6) NOT NULL DEFAULT 'INV',
    `creditNoteSeries` VARCHAR(6) NOT NULL DEFAULT 'CN',
    `financialYearStartMonth` SMALLINT NOT NULL DEFAULT 4,
    `signatoryName` VARCHAR(160) NULL,
    `signatoryDesignation` VARCHAR(120) NULL,
    `lutReference` VARCHAR(64) NULL,
    `lutValidFrom` DATE NULL,
    `lutValidTo` DATE NULL,
    `footerNotes` VARCHAR(1000) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_seller_invoice_settings_seller`(`sellerAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_shipment_lines` (
    `id` CHAR(26) NOT NULL,
    `shipmentId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `orderItemId` CHAR(26) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_shipment_line_item`(`orderItemId`),
    INDEX `ix_shipment_line_seller`(`sellerAccountId`, `shipmentId`),
    UNIQUE INDEX `uq_shipment_line_item`(`shipmentId`, `orderItemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_shipment_package_lines` (
    `id` CHAR(26) NOT NULL,
    `packageId` CHAR(26) NOT NULL,
    `shipmentId` CHAR(26) NOT NULL,
    `orderItemId` CHAR(26) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `batchNumber` VARCHAR(64) NOT NULL DEFAULT '',
    `expiryDate` DATE NULL,
    `serialNumbersJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_package_line_shipment`(`shipmentId`),
    UNIQUE INDEX `uq_package_line`(`packageId`, `orderItemId`, `batchNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_invoices` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NOT NULL,
    `logisticsShipmentId` CHAR(26) NOT NULL,
    `kind` ENUM('TAX_INVOICE', 'CREDIT_NOTE') NOT NULL DEFAULT 'TAX_INVOICE',
    `status` ENUM('DRAFT', 'VALIDATION_REQUIRED', 'READY_TO_ISSUE', 'ISSUED', 'VOIDED', 'CREDIT_NOTE_REQUIRED', 'SUPERSEDED') NOT NULL DEFAULT 'DRAFT',
    `jurisdiction` ENUM('IN_GST', 'EU_VAT', 'GENERIC') NOT NULL,
    `liveKey` VARCHAR(48) NULL,
    `series` VARCHAR(6) NULL,
    `financialYear` VARCHAR(9) NULL,
    `sequenceNumber` INTEGER NULL,
    `number` VARCHAR(20) NULL,
    `creditsInvoiceId` CHAR(26) NULL,
    `templateVersion` VARCHAR(16) NOT NULL,
    `issueDate` DATE NULL,
    `issuedAt` DATETIME(3) NULL,
    `issuedByLabel` VARCHAR(160) NULL,
    `currency` CHAR(3) NOT NULL,
    `sellerJson` JSON NOT NULL,
    `buyerJson` JSON NOT NULL,
    `shipToJson` JSON NOT NULL,
    `linesJson` JSON NOT NULL,
    `taxBreakdownJson` JSON NOT NULL,
    `placeOfSupplyJson` JSON NULL,
    `validationJson` JSON NULL,
    `supplyType` VARCHAR(32) NOT NULL,
    `reverseCharge` BOOLEAN NOT NULL DEFAULT false,
    `taxableMinor` BIGINT NOT NULL DEFAULT 0,
    `discountMinor` BIGINT NOT NULL DEFAULT 0,
    `cgstMinor` BIGINT NOT NULL DEFAULT 0,
    `sgstMinor` BIGINT NOT NULL DEFAULT 0,
    `igstMinor` BIGINT NOT NULL DEFAULT 0,
    `cessMinor` BIGINT NOT NULL DEFAULT 0,
    `otherTaxMinor` BIGINT NOT NULL DEFAULT 0,
    `freightMinor` BIGINT NOT NULL DEFAULT 0,
    `totalTaxMinor` BIGINT NOT NULL DEFAULT 0,
    `grandTotalMinor` BIGINT NOT NULL DEFAULT 0,
    `amountInWords` VARCHAR(512) NULL,
    `storageKey` VARCHAR(512) NULL,
    `contentHash` CHAR(64) NULL,
    `sizeBytes` INTEGER NULL,
    `pageCount` INTEGER NULL,
    `logisticsDocumentId` CHAR(26) NULL,
    `voidedAt` DATETIME(3) NULL,
    `voidReason` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_seller_invoice_live`(`liveKey`),
    INDEX `ix_seller_invoice_seller`(`sellerAccountId`, `status`, `createdAt`),
    INDEX `ix_seller_invoice_order`(`orderId`),
    INDEX `ix_seller_invoice_shipment`(`logisticsShipmentId`),
    UNIQUE INDEX `uq_seller_invoice_number`(`sellerAccountId`, `number`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_packing_lists` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NOT NULL,
    `logisticsShipmentId` CHAR(26) NOT NULL,
    `status` ENUM('DRAFT', 'VALIDATION_REQUIRED', 'READY_TO_ISSUE', 'ISSUED', 'VOIDED', 'CREDIT_NOTE_REQUIRED', 'SUPERSEDED') NOT NULL DEFAULT 'DRAFT',
    `liveKey` VARCHAR(48) NULL,
    `number` VARCHAR(24) NULL,
    `sellerInvoiceId` CHAR(26) NULL,
    `templateVersion` VARCHAR(16) NOT NULL,
    `issuedAt` DATETIME(3) NULL,
    `issuedByLabel` VARCHAR(160) NULL,
    `snapshotJson` JSON NOT NULL,
    `validationJson` JSON NULL,
    `packageCount` INTEGER NOT NULL DEFAULT 0,
    `totalBaseUnits` INTEGER NOT NULL DEFAULT 0,
    `netWeightGrams` BIGINT NOT NULL DEFAULT 0,
    `grossWeightGrams` BIGINT NOT NULL DEFAULT 0,
    `volumeCm3` BIGINT NOT NULL DEFAULT 0,
    `vehicleRegistration` VARCHAR(32) NULL,
    `driverReference` VARCHAR(32) NULL,
    `verificationCode` CHAR(16) NULL,
    `storageKey` VARCHAR(512) NULL,
    `contentHash` CHAR(64) NULL,
    `sizeBytes` INTEGER NULL,
    `pageCount` INTEGER NULL,
    `logisticsDocumentId` CHAR(26) NULL,
    `supersededById` CHAR(26) NULL,
    `voidedAt` DATETIME(3) NULL,
    `voidReason` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_packing_list_live`(`liveKey`),
    UNIQUE INDEX `uq_packing_list_number`(`number`),
    INDEX `ix_packing_list_seller`(`sellerAccountId`, `status`, `createdAt`),
    INDEX `ix_packing_list_order`(`orderId`),
    INDEX `ix_packing_list_shipment`(`logisticsShipmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `seller_invoice_settings` ADD CONSTRAINT `fk_invoice_settings_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `logistics_shipment_lines` ADD CONSTRAINT `fk_shipment_line_shipment` FOREIGN KEY (`shipmentId`) REFERENCES `logistics_shipments`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `logistics_shipment_package_lines` ADD CONSTRAINT `fk_package_line_package` FOREIGN KEY (`packageId`) REFERENCES `logistics_shipment_packages`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_invoices` ADD CONSTRAINT `fk_seller_invoice_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_invoices` ADD CONSTRAINT `fk_seller_invoice_order` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_invoices` ADD CONSTRAINT `fk_seller_invoice_group` FOREIGN KEY (`sellerOrderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_invoices` ADD CONSTRAINT `fk_seller_invoice_shipment` FOREIGN KEY (`logisticsShipmentId`) REFERENCES `logistics_shipments`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_packing_lists` ADD CONSTRAINT `fk_packing_list_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_packing_lists` ADD CONSTRAINT `fk_packing_list_order` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_packing_lists` ADD CONSTRAINT `fk_packing_list_group` FOREIGN KEY (`sellerOrderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_packing_lists` ADD CONSTRAINT `fk_packing_list_shipment` FOREIGN KEY (`logisticsShipmentId`) REFERENCES `logistics_shipments`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;


-- CHECK constraints: the floor under the service's own validation.
ALTER TABLE `logistics_shipment_lines`
  ADD CONSTRAINT `chk_shipment_line_quantity` CHECK (`quantity` > 0);

ALTER TABLE `logistics_shipment_package_lines`
  ADD CONSTRAINT `chk_package_line_quantity` CHECK (`quantity` > 0);

ALTER TABLE `seller_invoice_settings`
  ADD CONSTRAINT `chk_invoice_settings_fy_month` CHECK (`financialYearStartMonth` BETWEEN 1 AND 12);

-- An issued document has a number; a draft does not.
ALTER TABLE `seller_invoices`
  ADD CONSTRAINT `chk_seller_invoice_number` CHECK (
    (`status` IN ('DRAFT', 'VALIDATION_REQUIRED', 'READY_TO_ISSUE') AND `number` IS NULL)
    OR (`status` NOT IN ('DRAFT', 'VALIDATION_REQUIRED', 'READY_TO_ISSUE') AND `number` IS NOT NULL)
  );

ALTER TABLE `seller_packing_lists`
  ADD CONSTRAINT `chk_packing_list_number` CHECK (
    (`status` IN ('DRAFT', 'VALIDATION_REQUIRED', 'READY_TO_ISSUE') AND `number` IS NULL)
    OR (`status` NOT IN ('DRAFT', 'VALIDATION_REQUIRED', 'READY_TO_ISSUE') AND `number` IS NOT NULL)
  );
