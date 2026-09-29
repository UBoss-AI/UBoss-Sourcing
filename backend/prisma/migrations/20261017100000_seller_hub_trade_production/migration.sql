-- Seller Hub gaps: a marketplace BLOCKED listing state, market eligibility and
-- production capacity on offers, HS code review, bulk import idempotency,
-- production milestones and buyer updates, the order trade-document vault,
-- destination/category trade rules, booking terms and the operator's lanes.
-- See "SELLER HUB: PRODUCTION, EXPORT DOCUMENTS, TRADE RULES AND BOOKING
-- TERMS" in schema.prisma.
--
-- New tables, a new enum member and nullable/defaulted columns only, so it is
-- safe on a live installation.

-- AlterTable
ALTER TABLE `seller_offers` MODIFY `status` ENUM('INACTIVE', 'ACTIVE', 'PAUSED', 'NEEDS_CHANGES', 'ARCHIVED', 'BLOCKED') NOT NULL DEFAULT 'INACTIVE',
    ADD COLUMN `hsVerificationState` ENUM('DECLARED', 'VERIFIED', 'REJECTED') NOT NULL DEFAULT 'DECLARED',
    ADD COLUMN `hsVerifiedCode` VARCHAR(10) NULL,
    ADD COLUMN `hsVerificationNote` VARCHAR(1000) NULL,
    ADD COLUMN `hsVerifiedAt` DATETIME(3) NULL,
    ADD COLUMN `hsVerifiedByUserId` CHAR(26) NULL,
    ADD COLUMN `blockedReason` VARCHAR(1000) NULL,
    ADD COLUMN `blockedAt` DATETIME(3) NULL,
    ADD COLUMN `blockedByUserId` CHAR(26) NULL,
    ADD COLUMN `statusBeforeBlock` ENUM('INACTIVE', 'ACTIVE', 'PAUSED', 'NEEDS_CHANGES', 'ARCHIVED', 'BLOCKED') NULL,
    ADD COLUMN `capacityUnitsPerWeek` INTEGER NULL,
    ADD COLUMN `capacityLeadTimeDays` SMALLINT NULL;

-- AlterTable
ALTER TABLE `seller_bulk_import_jobs` ADD COLUMN `fileSha256` CHAR(64) NULL,
    ADD COLUMN `sourceJobId` CHAR(26) NULL,
    ADD COLUMN `fileFormat` VARCHAR(8) NOT NULL DEFAULT 'CSV';

-- CreateIndex
CREATE UNIQUE INDEX `uq_seller_import_source` ON `seller_bulk_import_jobs`(`sourceJobId`);

-- CreateTable
CREATE TABLE `seller_production_milestones` (
    `id` CHAR(26) NOT NULL,
    `orderGroupId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `stage` ENUM('RAW_MATERIAL', 'IN_PRODUCTION', 'QUALITY_CHECKED', 'READY') NOT NULL,
    `plannedFor` DATE NULL,
    `completedAt` DATETIME(3) NULL,
    `completedByLabel` VARCHAR(160) NULL,
    `internalNote` VARCHAR(2000) NULL,
    `buyerNote` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_production_milestone_stage`(`orderGroupId`, `stage`),
    INDEX `ix_production_milestone_seller`(`sellerAccountId`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_production_delays` (
    `id` CHAR(26) NOT NULL,
    `orderGroupId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `stage` ENUM('RAW_MATERIAL', 'IN_PRODUCTION', 'QUALITY_CHECKED', 'READY') NOT NULL,
    `reason` ENUM('RAW_MATERIAL_SHORTAGE', 'MACHINE_BREAKDOWN', 'LABOUR_SHORTAGE', 'QUALITY_REWORK', 'SUPPLIER_DELAY', 'TESTING_OR_CERTIFICATION', 'BUYER_CHANGE_REQUEST', 'LOGISTICS', 'OTHER') NOT NULL,
    `detail` VARCHAR(2000) NULL,
    `buyerMessage` VARCHAR(1000) NULL,
    `revisedDate` DATE NOT NULL,
    `raisedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `raisedByLabel` VARCHAR(160) NOT NULL,
    `resolvedAt` DATETIME(3) NULL,
    `resolvedByLabel` VARCHAR(160) NULL,
    `resolutionNote` VARCHAR(1000) NULL,

    INDEX `ix_production_delay_group`(`orderGroupId`, `raisedAt`),
    INDEX `ix_production_delay_seller`(`sellerAccountId`, `resolvedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_order_buyer_updates` (
    `id` CHAR(26) NOT NULL,
    `orderGroupId` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `stage` ENUM('RAW_MATERIAL', 'IN_PRODUCTION', 'QUALITY_CHECKED', 'READY') NOT NULL,
    `reason` ENUM('RAW_MATERIAL_SHORTAGE', 'MACHINE_BREAKDOWN', 'LABOUR_SHORTAGE', 'QUALITY_REWORK', 'SUPPLIER_DELAY', 'TESTING_OR_CERTIFICATION', 'BUYER_CHANGE_REQUEST', 'LOGISTICS', 'OTHER') NULL,
    `expectedDate` DATE NULL,
    `message` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_buyer_update_order`(`orderId`, `createdAt`),
    INDEX `ix_buyer_update_group`(`orderGroupId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_trade_documents` (
    `id` CHAR(26) NOT NULL,
    `orderGroupId` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `shipmentKey` VARCHAR(26) NOT NULL DEFAULT '',
    `kind` VARCHAR(64) NOT NULL,
    `title` VARCHAR(160) NOT NULL,
    `buyerVisibility` VARCHAR(8) NULL,
    `currentVersion` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_trade_document_slot`(`orderGroupId`, `shipmentKey`, `kind`),
    INDEX `ix_trade_document_order`(`orderId`),
    INDEX `ix_trade_document_seller`(`sellerAccountId`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_trade_document_versions` (
    `id` CHAR(26) NOT NULL,
    `documentId` CHAR(26) NOT NULL,
    `version` INTEGER NOT NULL,
    `source` ENUM('GENERATED', 'UPLOADED', 'REFERENCE') NOT NULL,
    `referenceNumber` VARCHAR(64) NULL,
    `issuerName` VARCHAR(200) NOT NULL,
    `issuedOn` DATE NULL,
    `expiresOn` DATE NULL,
    `storageKey` VARCHAR(512) NULL,
    `fileName` VARCHAR(255) NULL,
    `contentType` VARCHAR(100) NULL,
    `sizeBytes` INTEGER NULL,
    `sha256` CHAR(64) NULL,
    `scanState` VARCHAR(24) NULL,
    `validation` ENUM('PENDING_REVIEW', 'VALID', 'REJECTED') NOT NULL DEFAULT 'PENDING_REVIEW',
    `validatedAt` DATETIME(3) NULL,
    `validatedByUserId` CHAR(26) NULL,
    `validationNote` VARCHAR(1000) NULL,
    `supersededAt` DATETIME(3) NULL,
    `createdByLabel` VARCHAR(160) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_trade_document_version`(`documentId`, `version`),
    INDEX `ix_trade_document_version_review`(`validation`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_trade_document_events` (
    `id` CHAR(26) NOT NULL,
    `documentId` CHAR(26) NOT NULL,
    `versionId` CHAR(26) NULL,
    `action` VARCHAR(32) NOT NULL,
    `actorType` VARCHAR(16) NOT NULL,
    `actorLabel` VARCHAR(160) NOT NULL,
    `note` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_trade_document_event`(`documentId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `trade_compliance_rules` (
    `id` CHAR(26) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `destinationCountry` VARCHAR(2) NOT NULL DEFAULT '',
    `categoryId` CHAR(26) NULL,
    `hsPrefix` VARCHAR(10) NOT NULL DEFAULT '',
    `restriction` ENUM('NONE', 'RESTRICTED', 'PROHIBITED') NOT NULL DEFAULT 'NONE',
    `requiredDocumentKind` VARCHAR(64) NULL,
    `requiredDocumentName` VARCHAR(160) NULL,
    `responsibleParty` ENUM('SELLER', 'BUYER', 'FORWARDER', 'OPERATOR') NOT NULL DEFAULT 'SELLER',
    `requiresHsVerification` BOOLEAN NOT NULL DEFAULT false,
    `documentBuyerVisible` BOOLEAN NOT NULL DEFAULT true,
    `note` VARCHAR(1000) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdByUserId` CHAR(26) NULL,
    `updatedByUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_trade_rule_destination`(`destinationCountry`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `consignment_booking_terms` (
    `id` CHAR(26) NOT NULL,
    `shipmentId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `incoterm` VARCHAR(3) NOT NULL,
    `incotermPlace` VARCHAR(120) NULL,
    `mode` ENUM('ROAD', 'AIR', 'SEA', 'RAIL', 'COURIER', 'MULTIMODAL') NOT NULL,
    `originPort` VARCHAR(5) NULL,
    `destinationPort` VARCHAR(5) NULL,
    `routeNote` VARCHAR(500) NULL,
    `insured` BOOLEAN NOT NULL DEFAULT false,
    `insuredValueMinor` BIGINT NULL,
    `insurancePremiumMinor` BIGINT NULL,
    `insuranceBasisPointsApplied` INTEGER NULL,
    `currency` CHAR(3) NULL,
    `updatedByLabel` VARCHAR(160) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_booking_terms_shipment`(`shipmentId`),
    INDEX `ix_booking_terms_seller`(`sellerAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_trade_settings` (
    `id` VARCHAR(16) NOT NULL DEFAULT 'default',
    `insuranceBasisPoints` INTEGER NOT NULL DEFAULT 0,
    `maxInsuredBasisPoints` INTEGER NOT NULL DEFAULT 11000,
    `requireTermsCrossBorder` BOOLEAN NOT NULL DEFAULT true,
    `updatedByUserId` CHAR(26) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_lanes` (
    `id` CHAR(26) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `originCountry` CHAR(2) NOT NULL,
    `originRegion` VARCHAR(64) NOT NULL DEFAULT '',
    `originPort` VARCHAR(5) NOT NULL DEFAULT '',
    `destinationCountry` CHAR(2) NOT NULL,
    `destinationRegion` VARCHAR(64) NOT NULL DEFAULT '',
    `destinationPort` VARCHAR(5) NOT NULL DEFAULT '',
    `mode` ENUM('ROAD', 'AIR', 'SEA', 'RAIL', 'COURIER', 'MULTIMODAL') NOT NULL,
    `carrierName` VARCHAR(120) NOT NULL,
    `serviceLevel` VARCHAR(48) NOT NULL DEFAULT 'STANDARD',
    `transitDaysMin` SMALLINT NOT NULL,
    `transitDaysMax` SMALLINT NOT NULL,
    `isServiceable` BOOLEAN NOT NULL DEFAULT true,
    `currency` CHAR(3) NOT NULL,
    `minimumChargeMinor` BIGINT NOT NULL DEFAULT 0,
    `fuelSurchargeBasisPoints` INTEGER NOT NULL DEFAULT 0,
    `validFrom` DATETIME(3) NOT NULL,
    `validTo` DATETIME(3) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdByUserId` CHAR(26) NULL,
    `updatedByUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_logistics_lane_match`(`originCountry`, `destinationCountry`, `mode`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_lane_bands` (
    `id` CHAR(26) NOT NULL,
    `laneId` CHAR(26) NOT NULL,
    `minWeightGrams` INTEGER NOT NULL,
    `maxWeightGrams` INTEGER NULL,
    `amountMinor` BIGINT NOT NULL,
    `perKgMinor` BIGINT NOT NULL DEFAULT 0,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `uq_logistics_lane_band`(`laneId`, `minWeightGrams`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `seller_production_milestones` ADD CONSTRAINT `seller_production_milestones_orderGroupId_fkey` FOREIGN KEY (`orderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_production_delays` ADD CONSTRAINT `seller_production_delays_orderGroupId_fkey` FOREIGN KEY (`orderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_order_buyer_updates` ADD CONSTRAINT `seller_order_buyer_updates_orderGroupId_fkey` FOREIGN KEY (`orderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_trade_documents` ADD CONSTRAINT `order_trade_documents_orderGroupId_fkey` FOREIGN KEY (`orderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_trade_document_versions` ADD CONSTRAINT `order_trade_document_versions_documentId_fkey` FOREIGN KEY (`documentId`) REFERENCES `order_trade_documents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `order_trade_document_events` ADD CONSTRAINT `order_trade_document_events_documentId_fkey` FOREIGN KEY (`documentId`) REFERENCES `order_trade_documents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `consignment_booking_terms` ADD CONSTRAINT `consignment_booking_terms_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `logistics_shipments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_lane_bands` ADD CONSTRAINT `logistics_lane_bands_laneId_fkey` FOREIGN KEY (`laneId`) REFERENCES `logistics_lanes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
