-- Seller commission invoices: the operator's own invoice to a seller for the
-- platform commission on one seller order, its credit notes, the issued PDFs
-- and each invoice's event history. See `CommissionInvoice` in schema.prisma.
--
-- New tables and nothing else, so it is safe on a live installation. Numbers
-- come from the existing `number_sequences` table; nothing is seeded here,
-- because every legal detail of the issuing entity is a setting its operator
-- enters before the first invoice can be issued.

-- CreateTable
CREATE TABLE `commission_invoice_settings` (
    `id` CHAR(26) NOT NULL,
    `singleton` VARCHAR(16) NOT NULL DEFAULT 'default',
    `legalEntityCode` VARCHAR(16) NOT NULL DEFAULT 'MAIN',
    `legalName` VARCHAR(255) NULL,
    `tradeName` VARCHAR(255) NULL,
    `addressLine1` VARCHAR(255) NULL,
    `addressLine2` VARCHAR(255) NULL,
    `city` VARCHAR(120) NULL,
    `region` VARCHAR(120) NULL,
    `postcode` VARCHAR(24) NULL,
    `country` CHAR(2) NULL,
    `stateCode` VARCHAR(4) NULL,
    `taxRegime` ENUM('IN_GST', 'VAT', 'OTHER', 'NONE') NOT NULL DEFAULT 'NONE',
    `taxRegistrationLabel` VARCHAR(32) NOT NULL DEFAULT 'GSTIN',
    `taxRegistrationNumber` VARCHAR(32) NULL,
    `businessIdentifierLabel` VARCHAR(32) NOT NULL DEFAULT 'PAN',
    `businessIdentifier` VARCHAR(32) NULL,
    `businessEmail` VARCHAR(320) NULL,
    `supportContact` VARCHAR(160) NULL,
    `jurisdictionNote` VARCHAR(255) NULL,
    `serviceCode` VARCHAR(16) NULL,
    `serviceCodeLabel` VARCHAR(16) NOT NULL DEFAULT 'SAC',
    `serviceDescription` VARCHAR(255) NOT NULL DEFAULT 'Marketplace platform commission for Order {orderNumber}',
    `invoicePrefix` VARCHAR(16) NOT NULL DEFAULT 'GM/COM',
    `creditNotePrefix` VARCHAR(16) NOT NULL DEFAULT 'GM/CCN',
    `sequencePadding` SMALLINT NOT NULL DEFAULT 6,
    `financialYearStartMonth` SMALLINT NOT NULL DEFAULT 4,
    `eligibleStage` ENUM('CONFIRMED', 'SHIPPED', 'DELIVERED') NOT NULL DEFAULT 'DELIVERED',
    `paymentTermsDays` SMALLINT NULL,
    `roundGrandTotal` BOOLEAN NOT NULL DEFAULT false,
    `requireSellerTaxId` BOOLEAN NOT NULL DEFAULT true,
    `exportLutReference` VARCHAR(64) NULL,
    `zeroTaxDocumentType` ENUM('TAX_INVOICE', 'INVOICE', 'BILL_OF_SUPPLY') NOT NULL DEFAULT 'INVOICE',
    `allowVoidAfterIssue` BOOLEAN NOT NULL DEFAULT false,
    `footerNote` VARCHAR(1000) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `updatedByUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_commission_settings_singleton`(`singleton`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `commission_invoices` (
    `id` CHAR(26) NOT NULL,
    `legalEntityCode` VARCHAR(16) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NOT NULL,
    `settlementId` CHAR(26) NOT NULL,
    `status` ENUM('DRAFT', 'ISSUED', 'PARTIALLY_CREDITED', 'FULLY_CREDITED', 'VOID') NOT NULL DEFAULT 'DRAFT',
    `documentType` ENUM('TAX_INVOICE', 'INVOICE', 'BILL_OF_SUPPLY') NOT NULL,
    `activeKey` VARCHAR(40) NULL,
    `idempotencyKey` VARCHAR(128) NOT NULL,
    `series` VARCHAR(16) NULL,
    `financialYear` VARCHAR(9) NULL,
    `sequenceNumber` INTEGER NULL,
    `number` VARCHAR(40) NULL,
    `issueDate` DATE NULL,
    `issuedAt` DATETIME(3) NULL,
    `dueDate` DATE NULL,
    `currency` CHAR(3) NOT NULL,
    `taxTreatment` VARCHAR(32) NOT NULL,
    `reverseCharge` BOOLEAN NOT NULL DEFAULT false,
    `placeOfSupplyJson` JSON NULL,
    `issuerJson` JSON NOT NULL,
    `sellerJson` JSON NOT NULL,
    `sourceJson` JSON NOT NULL,
    `notesJson` JSON NULL,
    `validationJson` JSON NULL,
    `snapshotHash` CHAR(64) NOT NULL,
    `subtotalMinor` BIGINT NOT NULL DEFAULT 0,
    `discountMinor` BIGINT NOT NULL DEFAULT 0,
    `taxableMinor` BIGINT NOT NULL DEFAULT 0,
    `cgstMinor` BIGINT NOT NULL DEFAULT 0,
    `sgstMinor` BIGINT NOT NULL DEFAULT 0,
    `igstMinor` BIGINT NOT NULL DEFAULT 0,
    `otherTaxMinor` BIGINT NOT NULL DEFAULT 0,
    `totalTaxMinor` BIGINT NOT NULL DEFAULT 0,
    `roundingMinor` BIGINT NOT NULL DEFAULT 0,
    `grandTotalMinor` BIGINT NOT NULL DEFAULT 0,
    `creditedMinor` BIGINT NOT NULL DEFAULT 0,
    `amountInWords` VARCHAR(512) NULL,
    `collectionStatus` ENUM('OUTSTANDING', 'PAID', 'ADJUSTED_AGAINST_SETTLEMENT') NOT NULL DEFAULT 'OUTSTANDING',
    `collectionReference` VARCHAR(128) NULL,
    `collectedAt` DATETIME(3) NULL,
    `templateVersion` VARCHAR(16) NOT NULL,
    `createdByUserId` CHAR(26) NULL,
    `issuedByUserId` CHAR(26) NULL,
    `voidedByUserId` CHAR(26) NULL,
    `voidedAt` DATETIME(3) NULL,
    `voidReason` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_commission_invoice_status`(`status`, `createdAt`),
    INDEX `ix_commission_invoice_seller`(`sellerAccountId`, `createdAt`),
    INDEX `ix_commission_invoice_order`(`orderId`),
    INDEX `ix_commission_invoice_group`(`sellerOrderGroupId`),
    INDEX `ix_commission_invoice_settlement`(`settlementId`),
    INDEX `ix_commission_invoice_issue_date`(`issueDate`),
    INDEX `ix_commission_invoice_collection`(`collectionStatus`, `status`),
    INDEX `ix_commission_invoice_currency`(`currency`, `status`),
    UNIQUE INDEX `uq_commission_invoice_active`(`activeKey`),
    UNIQUE INDEX `uq_commission_invoice_idempotency`(`idempotencyKey`),
    UNIQUE INDEX `uq_commission_invoice_number`(`number`),
    UNIQUE INDEX `uq_commission_invoice_sequence`(`legalEntityCode`, `series`, `financialYear`, `sequenceNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `commission_invoice_lines` (
    `id` CHAR(26) NOT NULL,
    `invoiceId` CHAR(26) NOT NULL,
    `position` SMALLINT NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `description` VARCHAR(512) NOT NULL,
    `detail` VARCHAR(255) NULL,
    `serviceCode` VARCHAR(16) NULL,
    `orderReference` VARCHAR(64) NOT NULL,
    `feeType` VARCHAR(24) NULL,
    `basisMinor` BIGINT NOT NULL DEFAULT 0,
    `feeRatePercent` DECIMAL(9, 6) NULL,
    `policyId` CHAR(26) NULL,
    `policyVersion` INTEGER NULL,
    `taxableMinor` BIGINT NOT NULL DEFAULT 0,
    `taxRatePercent` DECIMAL(9, 6) NOT NULL DEFAULT 0,
    `cgstMinor` BIGINT NOT NULL DEFAULT 0,
    `sgstMinor` BIGINT NOT NULL DEFAULT 0,
    `igstMinor` BIGINT NOT NULL DEFAULT 0,
    `otherTaxMinor` BIGINT NOT NULL DEFAULT 0,
    `taxMinor` BIGINT NOT NULL DEFAULT 0,
    `totalMinor` BIGINT NOT NULL DEFAULT 0,

    UNIQUE INDEX `uq_commission_line_position`(`invoiceId`, `position`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `commission_credit_notes` (
    `id` CHAR(26) NOT NULL,
    `invoiceId` CHAR(26) NOT NULL,
    `legalEntityCode` VARCHAR(16) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `idempotencyKey` VARCHAR(128) NOT NULL,
    `series` VARCHAR(16) NOT NULL,
    `financialYear` VARCHAR(9) NOT NULL,
    `sequenceNumber` INTEGER NOT NULL,
    `number` VARCHAR(40) NOT NULL,
    `issueDate` DATE NOT NULL,
    `issuedAt` DATETIME(3) NOT NULL,
    `reason` ENUM('ORDER_CANCELLED', 'FULL_REFUND', 'PARTIAL_REFUND', 'COMMISSION_REVERSAL', 'CHARGEBACK', 'SELLER_DISPUTE', 'TAX_ADJUSTMENT') NOT NULL,
    `basis` ENUM('FULL', 'PROPORTIONAL_TO_REFUND', 'CUSTOM_AMOUNT') NOT NULL,
    `note` VARCHAR(1000) NULL,
    `currency` CHAR(3) NOT NULL,
    `taxableMinor` BIGINT NOT NULL DEFAULT 0,
    `cgstMinor` BIGINT NOT NULL DEFAULT 0,
    `sgstMinor` BIGINT NOT NULL DEFAULT 0,
    `igstMinor` BIGINT NOT NULL DEFAULT 0,
    `otherTaxMinor` BIGINT NOT NULL DEFAULT 0,
    `totalTaxMinor` BIGINT NOT NULL DEFAULT 0,
    `roundingMinor` BIGINT NOT NULL DEFAULT 0,
    `grandTotalMinor` BIGINT NOT NULL DEFAULT 0,
    `amountInWords` VARCHAR(512) NOT NULL,
    `linesJson` JSON NOT NULL,
    `issuedByUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_commission_credit_invoice`(`invoiceId`, `createdAt`),
    INDEX `ix_commission_credit_seller`(`sellerAccountId`, `createdAt`),
    UNIQUE INDEX `uq_commission_credit_idempotency`(`idempotencyKey`),
    UNIQUE INDEX `uq_commission_credit_number`(`number`),
    UNIQUE INDEX `uq_commission_credit_sequence`(`legalEntityCode`, `series`, `financialYear`, `sequenceNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `commission_documents` (
    `id` CHAR(26) NOT NULL,
    `invoiceId` CHAR(26) NULL,
    `creditNoteId` CHAR(26) NULL,
    `kind` VARCHAR(16) NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `fileName` VARCHAR(160) NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `pageCount` SMALLINT NOT NULL,
    `templateVersion` VARCHAR(16) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_commission_document_invoice`(`invoiceId`),
    UNIQUE INDEX `uq_commission_document_credit`(`creditNoteId`),
    UNIQUE INDEX `uq_commission_document_storage`(`storageKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `commission_invoice_events` (
    `id` CHAR(26) NOT NULL,
    `invoiceId` CHAR(26) NOT NULL,
    `creditNoteId` CHAR(26) NULL,
    `action` VARCHAR(48) NOT NULL,
    `fromStatus` VARCHAR(24) NULL,
    `toStatus` VARCHAR(24) NULL,
    `actorUserId` CHAR(26) NULL,
    `detailJson` JSON NULL,
    `snapshotHash` CHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_commission_event_invoice`(`invoiceId`, `createdAt`),
    INDEX `ix_commission_event_actor`(`actorUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `commission_invoices` ADD CONSTRAINT `fk_commission_invoice_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `commission_invoices` ADD CONSTRAINT `fk_commission_invoice_order` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `commission_invoices` ADD CONSTRAINT `fk_commission_invoice_group` FOREIGN KEY (`sellerOrderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `commission_invoices` ADD CONSTRAINT `fk_commission_invoice_settlement` FOREIGN KEY (`settlementId`) REFERENCES `seller_order_settlements`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `commission_invoice_lines` ADD CONSTRAINT `fk_commission_line_invoice` FOREIGN KEY (`invoiceId`) REFERENCES `commission_invoices`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `commission_credit_notes` ADD CONSTRAINT `fk_commission_credit_invoice` FOREIGN KEY (`invoiceId`) REFERENCES `commission_invoices`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `commission_documents` ADD CONSTRAINT `fk_commission_document_invoice` FOREIGN KEY (`invoiceId`) REFERENCES `commission_invoices`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `commission_documents` ADD CONSTRAINT `fk_commission_document_credit` FOREIGN KEY (`creditNoteId`) REFERENCES `commission_credit_notes`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `commission_invoice_events` ADD CONSTRAINT `fk_commission_event_invoice` FOREIGN KEY (`invoiceId`) REFERENCES `commission_invoices`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

