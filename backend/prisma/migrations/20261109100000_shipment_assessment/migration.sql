-- Shipment Assessment: the Audit Team's check between L1 and L2, the Audit
-- seller badge, waivers, release authorizations and Audit-issued documents.
--
-- Nothing existing is changed: no seller gets a badge (so every shipment needs
-- assessment until Audit grants one), no certificate is issued, and no
-- assessment is created here. With FEATURE_SHIPMENT_ASSESSMENT on, the worker
-- opens a case for each shipment still awaiting L2 (marking those already at
-- the port as existingAtRollout) - never a waiver. Completed L2 journeys are
-- never touched.

-- AlterTable
ALTER TABLE `seller_accounts` ADD COLUMN `auditBadge` ENUM('PLATINUM', 'GOLD', 'SILVER', 'BRONZE') NULL,
    ADD COLUMN `auditBadgeSetAt` DATETIME(3) NULL,
    ADD COLUMN `auditBadgeVersion` INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `seller_notifications` MODIFY `kind` ENUM('APPLICATION_STATUS', 'SHIPMENT_ASSESSMENT', 'LISTING_DECISION', 'NEW_ORDER', 'DISPATCH_SLA_WARNING', 'LOW_STOCK', 'ERP_SYNC_FAILURE', 'DOCUMENT_EXPIRING', 'PAYOUT_RESULT', 'RETURN_OR_DISPUTE', 'SECURITY_EVENT', 'BRAND_REQUEST_DECISION', 'CARRIER_ARRANGEMENT_DECISION', 'CARRIER_ACCEPTED', 'CARRIER_REJECTED', 'CARRIER_OFFER_EXPIRED', 'FULFILMENT_METHOD_DECISION', 'CARRIER_CONNECTION_FAILED', 'PARTNER_INVITATION_RESULT', 'CONSIGNMENT_AWAITING_METHOD', 'BULK_ORDER_RECEIVED', 'FREIGHT_QUOTE_REQUESTED', 'FREIGHT_QUOTE_AVAILABLE', 'PACKAGING_VALIDATION_FAILED', 'ERP_BRIDGE_OFFLINE', 'ERP_MAPPING_INCOMPLETE', 'ERP_SYNC_RECOVERED', 'ERP_INITIAL_SYNC_COMPLETE', 'CONSIGNMENT_NEEDS_CARRIER', 'CARRIER_BOOKING_INCOMPLETE', 'LOGISTICS_POLICY_UPDATE', 'LOGISTICS_PRICE_REQUIRED', 'LOGISTICS_UBOSS_PRICE_PUBLISHED', 'LOGISTICS_LEG_ASSIGNMENT_REQUIRED', 'LOGISTICS_LEG_UPDATE', 'SETTLEMENT_CALCULATED', 'PREORDER_REQUEST_RECEIVED', 'PREORDER_BUYER_RESPONSE', 'PREORDER_CONFIRMED', 'PREORDER_CLOSED', 'PREORDER_DELIVERY_RISK', 'INVOICE_CREDIT_NOTE_REQUIRED', 'INSPECTION_UPDATE', 'RFQ_INVITATION', 'RFQ_UPDATE', 'ORDER_MESSAGE') NOT NULL;

-- CreateTable
CREATE TABLE `seller_badge_changes` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `fromTier` ENUM('PLATINUM', 'GOLD', 'SILVER', 'BRONZE') NULL,
    `toTier` ENUM('PLATINUM', 'GOLD', 'SILVER', 'BRONZE') NULL,
    `reason` VARCHAR(2000) NOT NULL,
    `changedByUserId` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_seller_badge_change_seller`(`sellerAccountId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipment_assessment_policies` (
    `id` CHAR(26) NOT NULL,
    `version` INTEGER NOT NULL,
    `platinumRule` ENUM('WAIVER_ELIGIBLE', 'WAIVER_ELIGIBLE_WITH_REVIEW', 'ASSESSMENT_REQUIRED') NOT NULL,
    `goldRule` ENUM('WAIVER_ELIGIBLE', 'WAIVER_ELIGIBLE_WITH_REVIEW', 'ASSESSMENT_REQUIRED') NOT NULL,
    `silverRule` ENUM('WAIVER_ELIGIBLE', 'WAIVER_ELIGIBLE_WITH_REVIEW', 'ASSESSMENT_REQUIRED') NOT NULL,
    `bronzeRule` ENUM('WAIVER_ELIGIBLE', 'WAIVER_ELIGIBLE_WITH_REVIEW', 'ASSESSMENT_REQUIRED') NOT NULL,
    `unbadgedRule` ENUM('WAIVER_ELIGIBLE', 'WAIVER_ELIGIBLE_WITH_REVIEW', 'ASSESSMENT_REQUIRED') NOT NULL,
    `defaultDispatchDays` SMALLINT NULL,
    `maxDispatchDays` SMALLINT NULL,
    `sellerCertificateMonths` SMALLINT NOT NULL DEFAULT 12,
    `note` TEXT NULL,
    `createdByUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_shipment_assessment_policy_version`(`version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipment_assessments` (
    `id` CHAR(26) NOT NULL,
    `number` VARCHAR(24) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `status` ENUM('AWAITING_L1', 'READY_FOR_ASSESSMENT', 'IN_PROGRESS', 'AWAITING_QA', 'WAIVER_REVIEW', 'APPROVED_FOR_L2', 'FAILED', 'ON_HOLD', 'REASSESSMENT_REQUIRED', 'DISPATCHED', 'CANCELLED') NOT NULL DEFAULT 'AWAITING_L1',
    `requirement` ENUM('ASSESSMENT_REQUIRED', 'WAIVER_ELIGIBLE', 'WAIVER_ELIGIBLE_WITH_REVIEW') NOT NULL DEFAULT 'ASSESSMENT_REQUIRED',
    `requirementReason` VARCHAR(512) NOT NULL,
    `mandatoryInspection` BOOLEAN NOT NULL DEFAULT false,
    `mandatoryReason` VARCHAR(512) NULL,
    `applicabilityKnown` BOOLEAN NOT NULL DEFAULT true,
    `badgeAtEvaluation` ENUM('PLATINUM', 'GOLD', 'SILVER', 'BRONZE') NULL,
    `policyVersion` INTEGER NOT NULL,
    `evaluatedAt` DATETIME(3) NOT NULL,
    `currentRound` INTEGER NOT NULL DEFAULT 0,
    `assessorUserId` CHAR(26) NULL,
    `qaReviewerUserId` CHAR(26) NULL,
    `l1LegId` CHAR(26) NULL,
    `l2LegId` CHAR(26) NULL,
    `l1CompletedAt` DATETIME(3) NULL,
    `l1Location` VARCHAR(160) NULL,
    `plannedL2At` DATETIME(3) NULL,
    `scopeFingerprint` CHAR(64) NULL,
    `existingAtRollout` BOOLEAN NOT NULL DEFAULT false,
    `readinessNote` TEXT NULL,
    `readinessSubmittedAt` DATETIME(3) NULL,
    `sellerResponse` TEXT NULL,
    `sellerRespondedAt` DATETIME(3) NULL,
    `holdReason` VARCHAR(1000) NULL,
    `loadingChecksCompletedAt` DATETIME(3) NULL,
    `dispatchedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_shipment_assessment_number`(`number`),
    UNIQUE INDEX `uq_shipment_assessment_group`(`sellerOrderGroupId`),
    INDEX `ix_shipment_assessment_status`(`status`, `updatedAt`),
    INDEX `ix_shipment_assessment_seller`(`sellerAccountId`, `status`),
    INDEX `ix_shipment_assessment_order`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipment_assessment_rounds` (
    `id` CHAR(26) NOT NULL,
    `assessmentId` CHAR(26) NOT NULL,
    `round` INTEGER NOT NULL,
    `kind` ENUM('ASSESSMENT', 'WAIVER') NOT NULL,
    `checklistVersion` VARCHAR(48) NOT NULL,
    `categoryPlanId` CHAR(26) NULL,
    `categoryPlanVersion` INTEGER NULL,
    `checklistJson` JSON NOT NULL,
    `assessorUserId` CHAR(26) NULL,
    `startedAt` DATETIME(3) NULL,
    `submittedAt` DATETIME(3) NULL,
    `inspectionLocation` VARCHAR(255) NULL,
    `orderedQuantity` INTEGER NULL,
    `declaredQuantity` INTEGER NULL,
    `presentedQuantity` INTEGER NULL,
    `countedQuantity` INTEGER NULL,
    `sampledQuantity` INTEGER NULL,
    `approvedQuantity` INTEGER NULL,
    `sellingUnit` VARCHAR(32) NULL,
    `unitsPerPackage` INTEGER NULL,
    `packagesDeclared` INTEGER NULL,
    `packagesCounted` INTEGER NULL,
    `grossWeightDeclaredGrams` BIGINT NULL,
    `grossWeightMeasuredGrams` BIGINT NULL,
    `countingMethod` VARCHAR(255) NULL,
    `samplingMethod` VARCHAR(255) NULL,
    `sampleCoverageNote` VARCHAR(1000) NULL,
    `outcome` ENUM('PASSED', 'FAILED', 'HELD') NULL,
    `findingsSummary` TEXT NULL,
    `qaReviewerUserId` CHAR(26) NULL,
    `qaDecision` VARCHAR(16) NULL,
    `qaNote` TEXT NULL,
    `qaDecidedAt` DATETIME(3) NULL,
    `correctiveAction` TEXT NULL,
    `correctiveActionAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_shipment_assessment_round`(`assessmentId`, `round`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipment_assessment_checks` (
    `id` CHAR(26) NOT NULL,
    `assessmentId` CHAR(26) NOT NULL,
    `round` INTEGER NOT NULL,
    `itemCode` VARCHAR(48) NOT NULL,
    `section` VARCHAR(4) NOT NULL,
    `phase` VARCHAR(16) NOT NULL,
    `outcome` ENUM('PASS', 'FAIL', 'HOLD', 'NOT_APPLICABLE') NOT NULL,
    `note` VARCHAR(2000) NULL,
    `measuredValue` VARCHAR(255) NULL,
    `sampled` BOOLEAN NOT NULL DEFAULT false,
    `recordedByUserId` CHAR(26) NOT NULL,
    `recordedByRole` VARCHAR(16) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_shipment_assessment_check`(`assessmentId`, `round`, `itemCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipment_assessment_evidence` (
    `id` CHAR(26) NOT NULL,
    `assessmentId` CHAR(26) NOT NULL,
    `round` INTEGER NOT NULL,
    `itemCode` VARCHAR(48) NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `fileName` VARCHAR(255) NOT NULL,
    `contentType` VARCHAR(128) NOT NULL,
    `byteSize` INTEGER NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `uploadedByUserId` CHAR(26) NOT NULL,
    `uploadedByRole` VARCHAR(16) NOT NULL,
    `note` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_shipment_assessment_evidence`(`assessmentId`, `round`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipment_assessment_events` (
    `id` CHAR(26) NOT NULL,
    `assessmentId` CHAR(26) NOT NULL,
    `kind` VARCHAR(48) NOT NULL,
    `fromStatus` ENUM('AWAITING_L1', 'READY_FOR_ASSESSMENT', 'IN_PROGRESS', 'AWAITING_QA', 'WAIVER_REVIEW', 'APPROVED_FOR_L2', 'FAILED', 'ON_HOLD', 'REASSESSMENT_REQUIRED', 'DISPATCHED', 'CANCELLED') NULL,
    `toStatus` ENUM('AWAITING_L1', 'READY_FOR_ASSESSMENT', 'IN_PROGRESS', 'AWAITING_QA', 'WAIVER_REVIEW', 'APPROVED_FOR_L2', 'FAILED', 'ON_HOLD', 'REASSESSMENT_REQUIRED', 'DISPATCHED', 'CANCELLED') NULL,
    `actorRole` VARCHAR(16) NOT NULL,
    `actorUserId` CHAR(26) NULL,
    `note` TEXT NULL,
    `dataJson` JSON NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `idempotencyKey` VARCHAR(80) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_shipment_assessment_event`(`assessmentId`, `occurredAt`),
    UNIQUE INDEX `uq_shipment_assessment_event_idem`(`idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipment_waiver_decisions` (
    `id` CHAR(26) NOT NULL,
    `assessmentId` CHAR(26) NOT NULL,
    `decision` ENUM('APPROVED', 'REJECTED') NOT NULL,
    `badgeAtDecision` ENUM('PLATINUM', 'GOLD', 'SILVER', 'BRONZE') NULL,
    `badgeVersion` INTEGER NOT NULL,
    `policyVersion` INTEGER NOT NULL,
    `historyReviewNote` TEXT NULL,
    `historySnapshotJson` JSON NOT NULL,
    `reason` TEXT NOT NULL,
    `evidenceRefsJson` JSON NULL,
    `decidedByUserId` CHAR(26) NOT NULL,
    `decidedAt` DATETIME(3) NOT NULL,
    `invalidatedAt` DATETIME(3) NULL,
    `invalidationReason` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_shipment_waiver_assessment`(`assessmentId`, `decidedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipment_release_authorizations` (
    `id` CHAR(26) NOT NULL,
    `assessmentId` CHAR(26) NOT NULL,
    `kind` ENUM('ASSESSMENT', 'WAIVER') NOT NULL,
    `round` INTEGER NOT NULL,
    `waiverDecisionId` CHAR(26) NULL,
    `status` ENUM('ACTIVE', 'CONSUMED', 'INVALIDATED', 'EXPIRED') NOT NULL DEFAULT 'ACTIVE',
    `activeSlot` CHAR(26) NULL,
    `scopeFingerprint` CHAR(64) NOT NULL,
    `badgeAtIssue` ENUM('PLATINUM', 'GOLD', 'SILVER', 'BRONZE') NULL,
    `badgeVersion` INTEGER NOT NULL,
    `policyVersion` INTEGER NOT NULL,
    `dispatchDeadline` DATETIME(3) NOT NULL,
    `deadlineJustification` VARCHAR(1000) NOT NULL,
    `loadingChecksRequired` BOOLEAN NOT NULL DEFAULT true,
    `issuedByUserId` CHAR(26) NOT NULL,
    `issuedAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `consumedLegId` CHAR(26) NULL,
    `invalidatedAt` DATETIME(3) NULL,
    `invalidationReason` VARCHAR(1000) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_shipment_release_active`(`activeSlot`),
    INDEX `ix_shipment_release_status`(`status`, `dispatchDeadline`),
    INDEX `ix_shipment_release_assessment`(`assessmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipment_assessment_exceptions` (
    `id` CHAR(26) NOT NULL,
    `assessmentId` CHAR(26) NOT NULL,
    `kind` VARCHAR(48) NOT NULL,
    `logisticsShipmentId` CHAR(26) NULL,
    `shipmentEventId` CHAR(26) NULL,
    `detail` TEXT NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `resolvedAt` DATETIME(3) NULL,
    `resolvedByUserId` CHAR(26) NULL,
    `resolutionNote` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_shipment_assessment_exception`(`assessmentId`, `resolvedAt`),
    UNIQUE INDEX `uq_shipment_assessment_exception_event`(`shipmentEventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_documents` (
    `id` CHAR(26) NOT NULL,
    `number` VARCHAR(32) NOT NULL,
    `kind` ENUM('SELLER_VERIFICATION_CERTIFICATE', 'SHIPMENT_ASSESSMENT_CERTIFICATE', 'SHIPMENT_WAIVER_AUTHORIZATION', 'SHIPMENT_FINDINGS_REPORT') NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `supersedesId` CHAR(26) NULL,
    `status` ENUM('ACTIVE', 'EXPIRED', 'REVOKED', 'SUPERSEDED', 'USED') NOT NULL DEFAULT 'ACTIVE',
    `sellerAccountId` CHAR(26) NOT NULL,
    `assessmentId` CHAR(26) NULL,
    `round` INTEGER NULL,
    `releaseId` CHAR(26) NULL,
    `scopeJson` JSON NOT NULL,
    `detailJson` JSON NOT NULL,
    `issuedAt` DATETIME(3) NOT NULL,
    `validUntil` DATETIME(3) NULL,
    `dispatchBy` DATETIME(3) NULL,
    `signedByUserId` CHAR(26) NOT NULL,
    `signedByName` VARCHAR(160) NOT NULL,
    `signedByRole` VARCHAR(48) NOT NULL,
    `signingMechanism` VARCHAR(255) NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `byteSize` INTEGER NOT NULL,
    `pageCount` INTEGER NOT NULL,
    `statusChangedAt` DATETIME(3) NULL,
    `revokedByUserId` CHAR(26) NULL,
    `revokedReason` VARCHAR(1000) NULL,
    `reminderSentAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_audit_document_number`(`number`),
    UNIQUE INDEX `uq_audit_document_supersedes`(`supersedesId`),
    INDEX `ix_audit_document_seller`(`sellerAccountId`, `kind`),
    INDEX `ix_audit_document_assessment`(`assessmentId`),
    INDEX `ix_audit_document_status`(`status`, `validUntil`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `seller_badge_changes` ADD CONSTRAINT `fk_seller_badge_change_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_assessments` ADD CONSTRAINT `fk_shipment_assessment_group` FOREIGN KEY (`sellerOrderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_assessments` ADD CONSTRAINT `fk_shipment_assessment_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_assessment_rounds` ADD CONSTRAINT `fk_shipment_assessment_round_assessment` FOREIGN KEY (`assessmentId`) REFERENCES `shipment_assessments`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_assessment_checks` ADD CONSTRAINT `fk_shipment_assessment_check_assessment` FOREIGN KEY (`assessmentId`) REFERENCES `shipment_assessments`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_assessment_evidence` ADD CONSTRAINT `fk_shipment_assessment_evidence_assessment` FOREIGN KEY (`assessmentId`) REFERENCES `shipment_assessments`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_assessment_events` ADD CONSTRAINT `fk_shipment_assessment_event_assessment` FOREIGN KEY (`assessmentId`) REFERENCES `shipment_assessments`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_waiver_decisions` ADD CONSTRAINT `fk_shipment_waiver_assessment` FOREIGN KEY (`assessmentId`) REFERENCES `shipment_assessments`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_release_authorizations` ADD CONSTRAINT `fk_shipment_release_assessment` FOREIGN KEY (`assessmentId`) REFERENCES `shipment_assessments`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_assessment_exceptions` ADD CONSTRAINT `fk_shipment_assessment_exception_assessment` FOREIGN KEY (`assessmentId`) REFERENCES `shipment_assessments`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `audit_documents` ADD CONSTRAINT `fk_audit_document_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `audit_documents` ADD CONSTRAINT `fk_audit_document_assessment` FOREIGN KEY (`assessmentId`) REFERENCES `shipment_assessments`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- Policy version 1: the confirmed mapping. No approved dispatch window exists,
-- so a reviewer sets a justified deadline each time. 12 months is a platform
-- policy for seller certificates, not a legal rule.
INSERT INTO `shipment_assessment_policies` (`id`, `version`, `platinumRule`, `goldRule`, `silverRule`, `bronzeRule`, `unbadgedRule`, `defaultDispatchDays`, `maxDispatchDays`, `sellerCertificateMonths`, `note`, `createdByUserId`, `createdAt`, `updatedAt`)
VALUES ('01K0SAP0L1CY0000000000000V', 1, 'WAIVER_ELIGIBLE', 'WAIVER_ELIGIBLE_WITH_REVIEW', 'ASSESSMENT_REQUIRED', 'ASSESSMENT_REQUIRED', 'ASSESSMENT_REQUIRED', NULL, NULL, 12, 'Initial policy: Platinum waiver-eligible; Gold waiver-eligible after documented review; Silver, Bronze and no badge need assessment.', NULL, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
