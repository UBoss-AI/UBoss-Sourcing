-- Master row 16: requests for quotation.
--
-- A buyer's request (the current requirement on `rfq_requests`, every
-- submitted version in `rfq_requirement_versions`), the sellers asked to
-- answer it (`rfq_invitations`, one row per seller per request - the UNIQUE
-- index refuses a second invitation), its private files and its timeline.
--
-- The CHECK keeps a target price whole: an amount without its currency, or a
-- currency without an amount, means nothing to a seller. Neither column is
-- touched by a referential action, so it holds on MariaDB 11.4 as well.

-- AlterTable
ALTER TABLE `seller_notifications` MODIFY `kind` ENUM('APPLICATION_STATUS', 'LISTING_DECISION', 'NEW_ORDER', 'DISPATCH_SLA_WARNING', 'LOW_STOCK', 'ERP_SYNC_FAILURE', 'DOCUMENT_EXPIRING', 'PAYOUT_RESULT', 'RETURN_OR_DISPUTE', 'SECURITY_EVENT', 'BRAND_REQUEST_DECISION', 'CARRIER_ARRANGEMENT_DECISION', 'CARRIER_ACCEPTED', 'CARRIER_REJECTED', 'CARRIER_OFFER_EXPIRED', 'FULFILMENT_METHOD_DECISION', 'CARRIER_CONNECTION_FAILED', 'PARTNER_INVITATION_RESULT', 'CONSIGNMENT_AWAITING_METHOD', 'BULK_ORDER_RECEIVED', 'FREIGHT_QUOTE_REQUESTED', 'FREIGHT_QUOTE_AVAILABLE', 'PACKAGING_VALIDATION_FAILED', 'ERP_BRIDGE_OFFLINE', 'ERP_MAPPING_INCOMPLETE', 'ERP_SYNC_RECOVERED', 'ERP_INITIAL_SYNC_COMPLETE', 'CONSIGNMENT_NEEDS_CARRIER', 'CARRIER_BOOKING_INCOMPLETE', 'LOGISTICS_POLICY_UPDATE', 'LOGISTICS_PRICE_REQUIRED', 'LOGISTICS_UBOSS_PRICE_PUBLISHED', 'LOGISTICS_LEG_ASSIGNMENT_REQUIRED', 'LOGISTICS_LEG_UPDATE', 'SETTLEMENT_CALCULATED', 'PREORDER_REQUEST_RECEIVED', 'PREORDER_BUYER_RESPONSE', 'PREORDER_CONFIRMED', 'PREORDER_CLOSED', 'PREORDER_DELIVERY_RISK', 'INVOICE_CREDIT_NOTE_REQUIRED', 'INSPECTION_UPDATE', 'RFQ_INVITATION', 'RFQ_UPDATE') NOT NULL;

-- CreateTable
CREATE TABLE `rfq_requests` (
    `id` CHAR(26) NOT NULL,
    `reference` VARCHAR(32) NOT NULL,
    `status` ENUM('DRAFT', 'OPEN', 'CLOSED', 'AWARDED', 'CANCELLED') NOT NULL DEFAULT 'DRAFT',
    `version` INTEGER NOT NULL DEFAULT 0,
    `customerProfileId` CHAR(26) NOT NULL,
    `buyerCompanyId` CHAR(26) NULL,
    `createdByUserId` CHAR(26) NOT NULL,
    `categoryId` CHAR(26) NULL,
    `title` VARCHAR(200) NOT NULL DEFAULT '',
    `specification` TEXT NULL,
    `specsJson` JSON NULL,
    `quantity` DECIMAL(15, 3) NULL,
    `unitOfMeasure` VARCHAR(16) NULL,
    `annualVolume` DECIMAL(15, 3) NULL,
    `targetUnitPriceMinor` BIGINT NULL,
    `targetCurrency` CHAR(3) NULL,
    `destinationCountry` CHAR(2) NULL,
    `destinationAddress` VARCHAR(500) NULL,
    `destinationPort` VARCHAR(120) NULL,
    `incoterm` VARCHAR(3) NULL,
    `certificationsJson` JSON NULL,
    `sampleRequirement` VARCHAR(24) NOT NULL DEFAULT 'NONE',
    `inspectionRequirement` VARCHAR(32) NOT NULL DEFAULT 'NONE',
    `responseDeadline` DATETIME(3) NULL,
    `deliveryTargetDate` DATE NULL,
    `notes` TEXT NULL,
    `includeSellerIdsJson` JSON NULL,
    `excludeSellerIdsJson` JSON NULL,
    `matchedSupplierCount` INTEGER NOT NULL DEFAULT 0,
    `matchOutcome` VARCHAR(16) NULL,
    `currentRequirementVersion` INTEGER NOT NULL DEFAULT 0,
    `submittedAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `statusReason` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_rfq_reference`(`reference`),
    INDEX `ix_rfq_request_owner`(`customerProfileId`, `buyerCompanyId`, `updatedAt`),
    INDEX `ix_rfq_request_company`(`buyerCompanyId`, `updatedAt`),
    INDEX `ix_rfq_request_deadline`(`status`, `responseDeadline`),
    INDEX `ix_rfq_request_category`(`categoryId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rfq_requirement_versions` (
    `id` CHAR(26) NOT NULL,
    `rfqId` CHAR(26) NOT NULL,
    `versionNumber` INTEGER NOT NULL,
    `snapshotJson` JSON NOT NULL,
    `changedFieldsJson` JSON NOT NULL,
    `changeSummary` VARCHAR(1000) NULL,
    `createdByUserId` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_rfq_requirement_version`(`rfqId`, `versionNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rfq_invitations` (
    `id` CHAR(26) NOT NULL,
    `rfqId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `source` ENUM('MATCHED', 'BUYER_SELECTED') NOT NULL,
    `status` ENUM('INVITED', 'VIEWED', 'QUOTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED') NOT NULL DEFAULT 'INVITED',
    `invitedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `viewedAt` DATETIME(3) NULL,
    `respondedAt` DATETIME(3) NULL,
    `declineReason` VARCHAR(1000) NULL,
    `notifiedVersion` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_rfq_invitation_seller`(`sellerAccountId`, `status`, `updatedAt`),
    UNIQUE INDEX `uq_rfq_invitation_seller`(`rfqId`, `sellerAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rfq_attachments` (
    `id` CHAR(26) NOT NULL,
    `rfqId` CHAR(26) NOT NULL,
    `purpose` ENUM('REQUIREMENT', 'QUOTE', 'NEGOTIATION') NOT NULL,
    `sellerAccountId` CHAR(26) NULL,
    `requirementVersion` INTEGER NULL,
    `quoteVersionId` CHAR(26) NULL,
    `uploadedByParty` ENUM('BUYER', 'SUPPLIER', 'SYSTEM') NOT NULL,
    `uploadedByUserId` CHAR(26) NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `fileName` VARCHAR(255) NOT NULL,
    `contentType` VARCHAR(100) NOT NULL,
    `byteSize` INTEGER NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `scanState` VARCHAR(24) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_rfq_attachment_rfq`(`rfqId`, `purpose`, `createdAt`),
    INDEX `ix_rfq_attachment_seller`(`rfqId`, `sellerAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rfq_events` (
    `id` CHAR(26) NOT NULL,
    `rfqId` CHAR(26) NOT NULL,
    `kind` VARCHAR(40) NOT NULL,
    `sellerAccountId` CHAR(26) NULL,
    `sharedWithSuppliers` BOOLEAN NOT NULL DEFAULT false,
    `actorParty` ENUM('BUYER', 'SUPPLIER', 'SYSTEM') NOT NULL,
    `actorUserId` CHAR(26) NULL,
    `metaJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_rfq_event_rfq`(`rfqId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `rfq_requests` ADD CONSTRAINT `fk_rfq_request_customer` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `rfq_requests` ADD CONSTRAINT `fk_rfq_request_buyer_company` FOREIGN KEY (`buyerCompanyId`) REFERENCES `buyer_companies`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `rfq_requests` ADD CONSTRAINT `fk_rfq_request_category` FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `rfq_requirement_versions` ADD CONSTRAINT `fk_rfq_requirement_version_rfq` FOREIGN KEY (`rfqId`) REFERENCES `rfq_requests`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `rfq_invitations` ADD CONSTRAINT `fk_rfq_invitation_rfq` FOREIGN KEY (`rfqId`) REFERENCES `rfq_requests`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `rfq_invitations` ADD CONSTRAINT `fk_rfq_invitation_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `rfq_attachments` ADD CONSTRAINT `fk_rfq_attachment_rfq` FOREIGN KEY (`rfqId`) REFERENCES `rfq_requests`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `rfq_events` ADD CONSTRAINT `fk_rfq_event_rfq` FOREIGN KEY (`rfqId`) REFERENCES `rfq_requests`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- A target price is an amount AND a currency, or neither.
ALTER TABLE `rfq_requests` ADD CONSTRAINT `chk_rfq_target_price_pair` CHECK ((`targetUnitPriceMinor` IS NULL) = (`targetCurrency` IS NULL));
