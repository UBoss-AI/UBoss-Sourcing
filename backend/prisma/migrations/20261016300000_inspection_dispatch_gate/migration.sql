-- Third-party pre-shipment inspection and the dispatch gate.
--
-- An independent inspection agency checks a seller's goods before they leave.
-- When the operator's rules (inspection_rules) say an order needs inspecting,
-- the seller's part of it cannot be marked ready or shipped, and no consignment
-- carrying it can be collected, until a signed report has PASSED or a
-- conditional release has been approved by a second person. The gate itself is
-- code (domain/inspection-gate.ts, called from the seller-order and shipment
-- state machines); these tables are what it reads.
--
-- Additive only: seventeen new tables, and nothing existing is altered. Every
-- inspection row hangs off inspection_requirements, which cascades from
-- seller_order_groups, so removing an order group removes its inspection with
-- it. inspection_agency_members.userId names a person and is disclosed in the
-- GDPR export under `inspectionAgencyMembership`.

-- CreateTable
CREATE TABLE `inspection_policies` (
    `id` VARCHAR(16) NOT NULL,
    `majorNcrBlocksDispatch` BOOLEAN NOT NULL DEFAULT true,
    `minorNcrBlocksDispatch` BOOLEAN NOT NULL DEFAULT false,
    `buyerReportAccess` ENUM('BEFORE_RELEASE', 'AFTER_RELEASE', 'NONE') NOT NULL DEFAULT 'BEFORE_RELEASE',
    `buyerNcrVisibility` ENUM('ALL', 'MAJOR_AND_CRITICAL', 'NONE') NOT NULL DEFAULT 'MAJOR_AND_CRITICAL',
    `buyerReviewHours` INTEGER NOT NULL DEFAULT 0,
    `buyerMayRequest` BOOLEAN NOT NULL DEFAULT true,
    `supplierRiskLookbackDays` INTEGER NOT NULL DEFAULT 180,
    `supplierRiskFailThreshold` INTEGER NOT NULL DEFAULT 2,
    `agencyAcceptSlaHours` INTEGER NOT NULL DEFAULT 24,
    `reportSlaHours` INTEGER NOT NULL DEFAULT 72,
    `conditionalReleaseMinReasonLength` INTEGER NOT NULL DEFAULT 20,
    `requireInspectorCompetence` BOOLEAN NOT NULL DEFAULT true,
    `updatedById` CHAR(26) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_plans` (
    `id` CHAR(26) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `categoryId` CHAR(26) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `effectiveFrom` DATETIME(3) NOT NULL,
    `effectiveTo` DATETIME(3) NULL,
    `inspectionLevel` VARCHAR(4) NOT NULL DEFAULT 'II',
    `aqlCritical` VARCHAR(8) NOT NULL DEFAULT '0',
    `aqlMajor` VARCHAR(8) NOT NULL DEFAULT '2.5',
    `aqlMinor` VARCHAR(8) NOT NULL DEFAULT '4.0',
    `checklistJson` JSON NOT NULL,
    `language` VARCHAR(8) NOT NULL DEFAULT 'en',
    `createdById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_insp_plan_category`(`categoryId`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_rules` (
    `id` CHAR(26) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `priority` INTEGER NOT NULL DEFAULT 100,
    `level` ENUM('MANDATORY', 'RISK_TRIGGERED', 'BUYER_REQUESTED', 'NOT_REQUIRED') NOT NULL,
    `categoryId` CHAR(26) NULL,
    `minOrderValueMinor` BIGINT NULL,
    `currency` CHAR(3) NULL,
    `destinationCountriesJson` JSON NULL,
    `supplierRiskAtLeast` ENUM('LOW', 'MEDIUM', 'HIGH') NULL,
    `planId` CHAR(26) NULL,
    `preferredAgencyId` CHAR(26) NULL,
    `allowConditionalRelease` BOOLEAN NOT NULL DEFAULT true,
    `effectiveFrom` DATETIME(3) NOT NULL,
    `effectiveTo` DATETIME(3) NULL,
    `createdById` CHAR(26) NULL,
    `updatedById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_insp_rule_active`(`isActive`, `level`, `priority`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_supplier_risks` (
    `sellerAccountId` CHAR(26) NOT NULL,
    `tier` ENUM('LOW', 'MEDIUM', 'HIGH') NOT NULL,
    `reason` VARCHAR(512) NOT NULL,
    `setById` CHAR(26) NULL,
    `setAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`sellerAccountId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_agencies` (
    `id` CHAR(26) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `legalName` VARCHAR(255) NOT NULL,
    `registrationNumber` VARCHAR(64) NULL,
    `country` CHAR(2) NOT NULL,
    `contactEmail` VARCHAR(320) NOT NULL,
    `contactPhone` VARCHAR(32) NULL,
    `accreditation` VARCHAR(512) NULL,
    `categoryIdsJson` JSON NULL,
    `countriesJson` JSON NULL,
    `status` ENUM('ACTIVE', 'SUSPENDED') NOT NULL DEFAULT 'ACTIVE',
    `suspendedReason` VARCHAR(512) NULL,
    `affiliatedSellerIdsJson` JSON NULL,
    `independenceStatement` TEXT NULL,
    `independenceDeclaredAt` DATETIME(3) NULL,
    `defaultFeeMinor` BIGINT NULL,
    `feeCurrency` CHAR(3) NULL,
    `createdById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_insp_agency_status`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_agency_members` (
    `id` CHAR(26) NOT NULL,
    `agencyId` CHAR(26) NOT NULL,
    `userId` CHAR(26) NOT NULL,
    `role` ENUM('AGENCY_ADMIN', 'COORDINATOR', 'INSPECTOR', 'QA_REVIEWER') NOT NULL,
    `status` ENUM('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE',
    `fullName` VARCHAR(160) NOT NULL,
    `jobTitle` VARCHAR(120) NULL,
    `idDocumentType` VARCHAR(32) NULL,
    `idDocumentNumber` VARCHAR(64) NULL,
    `identityVerifiedAt` DATETIME(3) NULL,
    `identityVerifiedById` CHAR(26) NULL,
    `competenceCategoryIdsJson` JSON NULL,
    `credentials` VARCHAR(1024) NULL,
    `credentialExpiresAt` DATETIME(3) NULL,
    `addedById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_insp_member_agency`(`agencyId`, `role`),
    UNIQUE INDEX `uq_insp_member_user`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_requirements` (
    `id` CHAR(26) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `level` ENUM('MANDATORY', 'RISK_TRIGGERED', 'BUYER_REQUESTED', 'NOT_REQUIRED') NOT NULL,
    `status` ENUM('NOT_REQUIRED', 'AWAITING_BOOKING', 'BOOKED', 'IN_PROGRESS', 'REPORT_IN_REVIEW', 'FAILED', 'BLOCKED_BY_NCR', 'RELEASE_PENDING_APPROVAL', 'RELEASED', 'RELEASED_CONDITIONALLY', 'REEVALUATION_REQUIRED', 'DISPATCHED') NOT NULL,
    `ruleId` CHAR(26) NULL,
    `ruleName` VARCHAR(160) NULL,
    `reason` VARCHAR(512) NOT NULL,
    `inputsJson` JSON NOT NULL,
    `planId` CHAR(26) NULL,
    `preferredAgencyId` CHAR(26) NULL,
    `allowConditionalRelease` BOOLEAN NOT NULL DEFAULT true,
    `buyerRequested` BOOLEAN NOT NULL DEFAULT false,
    `buyerRequestedAt` DATETIME(3) NULL,
    `buyerRequestNote` VARCHAR(1024) NULL,
    `evaluatedAt` DATETIME(3) NOT NULL,
    `loadReleasedAt` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_insp_requirement_order`(`orderId`),
    INDEX `ix_insp_requirement_status`(`status`, `updatedAt`),
    INDEX `ix_insp_requirement_seller`(`sellerAccountId`, `status`),
    UNIQUE INDEX `uq_insp_requirement_group`(`sellerOrderGroupId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_jobs` (
    `id` CHAR(26) NOT NULL,
    `jobNumber` VARCHAR(32) NOT NULL,
    `requirementId` CHAR(26) NOT NULL,
    `agencyId` CHAR(26) NOT NULL,
    `kind` ENUM('INITIAL', 'REINSPECTION') NOT NULL DEFAULT 'INITIAL',
    `reinspectionOfJobId` CHAR(26) NULL,
    `status` ENUM('REQUESTED', 'ACCEPTED', 'DECLINED', 'INSPECTOR_ASSIGNED', 'IN_PROGRESS', 'REPORT_SUBMITTED', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'REQUESTED',
    `bookedByParty` ENUM('SYSTEM', 'SELLER', 'BUYER', 'OPERATOR', 'AGENCY') NOT NULL,
    `bookedById` CHAR(26) NULL,
    `bookedByLabel` VARCHAR(160) NOT NULL,
    `payer` ENUM('BUYER', 'SELLER', 'PLATFORM') NOT NULL,
    `inspectionPointType` ENUM('SELLER_PREMISES', 'WAREHOUSE', 'PORT', 'OTHER') NOT NULL,
    `inspectionPointJson` JSON NOT NULL,
    `scheduledFor` DATETIME(3) NOT NULL,
    `language` VARCHAR(8) NOT NULL,
    `standard` VARCHAR(160) NOT NULL,
    `scopeJson` JSON NOT NULL,
    `planSnapshotJson` JSON NOT NULL,
    `lotSize` INTEGER NOT NULL,
    `samplingJson` JSON NOT NULL,
    `poReference` VARCHAR(64) NULL,
    `referenceSample` VARCHAR(512) NULL,
    `specialRequirements` TEXT NULL,
    `acceptDueAt` DATETIME(3) NOT NULL,
    `reportDueAt` DATETIME(3) NOT NULL,
    `acceptedAt` DATETIME(3) NULL,
    `acceptedById` CHAR(26) NULL,
    `agencyConflictStatement` TEXT NULL,
    `declinedAt` DATETIME(3) NULL,
    `declineReason` VARCHAR(1024) NULL,
    `inspectorMemberId` CHAR(26) NULL,
    `backupInspectorMemberId` CHAR(26) NULL,
    `assignedAt` DATETIME(3) NULL,
    `startedAt` DATETIME(3) NULL,
    `submittedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelReason` VARCHAR(1024) NULL,
    `lotReference` VARCHAR(64) NULL,
    `sampledQuantity` INTEGER NULL,
    `acceptedQuantity` INTEGER NULL,
    `rejectedQuantity` INTEGER NULL,
    `cartonsOpened` INTEGER NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_insp_job_agency`(`agencyId`, `status`, `scheduledFor`),
    INDEX `ix_insp_job_requirement`(`requirementId`, `createdAt`),
    INDEX `ix_insp_job_inspector`(`inspectorMemberId`, `status`),
    UNIQUE INDEX `uq_insp_job_number`(`jobNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_conflict_declarations` (
    `id` CHAR(26) NOT NULL,
    `jobId` CHAR(26) NOT NULL,
    `memberId` CHAR(26) NOT NULL,
    `hasConflict` BOOLEAN NOT NULL,
    `details` TEXT NULL,
    `declaredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_insp_declaration_member`(`memberId`),
    UNIQUE INDEX `uq_insp_declaration`(`jobId`, `memberId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_check_results` (
    `id` CHAR(26) NOT NULL,
    `jobId` CHAR(26) NOT NULL,
    `itemCode` VARCHAR(48) NOT NULL,
    `section` VARCHAR(24) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `requirement` VARCHAR(512) NULL,
    `outcome` ENUM('CONFORM', 'NONCONFORM', 'NOT_APPLICABLE') NOT NULL,
    `measuredValue` VARCHAR(128) NULL,
    `note` VARCHAR(1024) NULL,
    `recordedByMemberId` CHAR(26) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_insp_check_item`(`jobId`, `itemCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_defects` (
    `id` CHAR(26) NOT NULL,
    `jobId` CHAR(26) NOT NULL,
    `requirementId` CHAR(26) NOT NULL,
    `ncrNumber` VARCHAR(40) NOT NULL,
    `severity` ENUM('CRITICAL', 'MAJOR', 'MINOR') NOT NULL,
    `originalSeverity` ENUM('CRITICAL', 'MAJOR', 'MINOR') NOT NULL,
    `requirementRef` VARCHAR(128) NOT NULL,
    `description` TEXT NOT NULL,
    `defectQuantity` INTEGER NOT NULL DEFAULT 1,
    `status` ENUM('OPEN', 'CAPA_SUBMITTED', 'VERIFIED_CLOSED') NOT NULL DEFAULT 'OPEN',
    `recordedByMemberId` CHAR(26) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `reclassifiedAt` DATETIME(3) NULL,
    `reclassifiedByMemberId` CHAR(26) NULL,
    `reclassificationReason` TEXT NULL,
    `sellerResponse` TEXT NULL,
    `correctiveAction` TEXT NULL,
    `capaSubmittedAt` DATETIME(3) NULL,
    `capaSubmittedById` CHAR(26) NULL,
    `capaSubmittedByLabel` VARCHAR(160) NULL,
    `verifiedAt` DATETIME(3) NULL,
    `verifiedByReportId` CHAR(26) NULL,

    INDEX `ix_insp_defect_job`(`jobId`),
    INDEX `ix_insp_defect_requirement`(`requirementId`, `status`),
    UNIQUE INDEX `uq_insp_ncr_number`(`ncrNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_evidence` (
    `id` CHAR(26) NOT NULL,
    `requirementId` CHAR(26) NOT NULL,
    `jobId` CHAR(26) NULL,
    `defectId` CHAR(26) NULL,
    `releaseId` CHAR(26) NULL,
    `bindingId` CHAR(26) NULL,
    `checkItemCode` VARCHAR(48) NULL,
    `purpose` ENUM('GENERAL', 'CHECKLIST', 'SAMPLING', 'PACKAGING', 'MEASUREMENT', 'DEFECT', 'CAPA', 'RELEASE', 'BINDING', 'RECLASSIFICATION') NOT NULL,
    `mediaKind` ENUM('IMAGE', 'VIDEO', 'DOCUMENT') NOT NULL,
    `fileName` VARCHAR(255) NOT NULL,
    `contentType` VARCHAR(128) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `scanState` VARCHAR(16) NOT NULL,
    `capturedAt` DATETIME(3) NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `uploadedById` CHAR(26) NULL,
    `uploadedByLabel` VARCHAR(160) NOT NULL,
    `uploadedByParty` ENUM('SYSTEM', 'SELLER', 'BUYER', 'OPERATOR', 'AGENCY') NOT NULL,
    `clientUploadId` VARCHAR(64) NULL,
    `latitude` DECIMAL(9, 6) NULL,
    `longitude` DECIMAL(9, 6) NULL,
    `measurement` VARCHAR(255) NULL,
    `note` VARCHAR(512) NULL,

    INDEX `ix_insp_evidence_job`(`jobId`, `purpose`),
    INDEX `ix_insp_evidence_defect`(`defectId`),
    INDEX `ix_insp_evidence_release`(`releaseId`),
    UNIQUE INDEX `uq_insp_evidence_upload`(`requirementId`, `clientUploadId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_reports` (
    `id` CHAR(26) NOT NULL,
    `jobId` CHAR(26) NOT NULL,
    `revision` INTEGER NOT NULL,
    `status` ENUM('SUBMITTED', 'RETURNED', 'SIGNED') NOT NULL DEFAULT 'SUBMITTED',
    `result` ENUM('PASS', 'FAIL') NOT NULL,
    `summary` TEXT NULL,
    `computationJson` JSON NOT NULL,
    `contentJson` JSON NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `signature` CHAR(64) NULL,
    `submittedAt` DATETIME(3) NOT NULL,
    `submittedByMemberId` CHAR(26) NOT NULL,
    `returnedAt` DATETIME(3) NULL,
    `returnedByMemberId` CHAR(26) NULL,
    `returnReason` VARCHAR(1024) NULL,
    `signedAt` DATETIME(3) NULL,
    `signedByMemberId` CHAR(26) NULL,
    `signedByName` VARCHAR(160) NULL,
    `publishedToBuyerAt` DATETIME(3) NULL,

    UNIQUE INDEX `uq_insp_report_revision`(`jobId`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_releases` (
    `id` CHAR(26) NOT NULL,
    `requirementId` CHAR(26) NOT NULL,
    `kind` ENUM('PASS', 'CONDITIONAL') NOT NULL,
    `state` ENUM('PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'SUPERSEDED') NOT NULL,
    `reportId` CHAR(26) NULL,
    `bindingId` CHAR(26) NULL,
    `reason` TEXT NULL,
    `riskNote` VARCHAR(1024) NULL,
    `requestedByParty` ENUM('SYSTEM', 'SELLER', 'BUYER', 'OPERATOR', 'AGENCY') NOT NULL,
    `requestedById` CHAR(26) NULL,
    `requestedByLabel` VARCHAR(160) NOT NULL,
    `requestedAt` DATETIME(3) NOT NULL,
    `approvedById` CHAR(26) NULL,
    `approvedByLabel` VARCHAR(160) NULL,
    `approvedAt` DATETIME(3) NULL,
    `rejectedById` CHAR(26) NULL,
    `rejectedAt` DATETIME(3) NULL,
    `rejectionReason` VARCHAR(1024) NULL,
    `boundScopeHash` CHAR(64) NOT NULL,
    `boundScopeJson` JSON NOT NULL,
    `supersededAt` DATETIME(3) NULL,
    `supersededReason` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_insp_release_requirement`(`requirementId`, `state`),
    INDEX `ix_insp_release_state`(`state`, `requestedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_shipment_bindings` (
    `id` CHAR(26) NOT NULL,
    `requirementId` CHAR(26) NOT NULL,
    `jobId` CHAR(26) NOT NULL,
    `logisticsShipmentId` CHAR(26) NULL,
    `containerNumber` VARCHAR(20) NULL,
    `sealNumber` VARCHAR(64) NULL,
    `stuffedQuantity` INTEGER NOT NULL,
    `stuffedAt` DATETIME(3) NOT NULL,
    `witnessName` VARCHAR(160) NULL,
    `recordedByMemberId` CHAR(26) NOT NULL,
    `scopeHash` CHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_insp_binding_requirement`(`requirementId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_agency_invoices` (
    `id` CHAR(26) NOT NULL,
    `jobId` CHAR(26) NOT NULL,
    `agencyId` CHAR(26) NOT NULL,
    `invoiceNumber` VARCHAR(64) NOT NULL,
    `amountMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `payer` ENUM('BUYER', 'SELLER', 'PLATFORM') NOT NULL,
    `status` ENUM('SUBMITTED', 'APPROVED', 'PAID', 'DISPUTED', 'VOID') NOT NULL DEFAULT 'SUBMITTED',
    `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `submittedByMemberId` CHAR(26) NOT NULL,
    `decidedAt` DATETIME(3) NULL,
    `decidedById` CHAR(26) NULL,
    `paidAt` DATETIME(3) NULL,
    `note` VARCHAR(1024) NULL,

    INDEX `ix_insp_invoice_job`(`jobId`),
    INDEX `ix_insp_invoice_status`(`status`, `submittedAt`),
    UNIQUE INDEX `uq_insp_invoice_number`(`agencyId`, `invoiceNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_events` (
    `id` CHAR(26) NOT NULL,
    `requirementId` CHAR(26) NOT NULL,
    `jobId` CHAR(26) NULL,
    `orderId` CHAR(26) NOT NULL,
    `kind` VARCHAR(48) NOT NULL,
    `actorParty` ENUM('SYSTEM', 'SELLER', 'BUYER', 'OPERATOR', 'AGENCY') NOT NULL,
    `actorId` CHAR(26) NULL,
    `actorLabel` VARCHAR(160) NOT NULL,
    `summary` VARCHAR(512) NOT NULL,
    `dataJson` JSON NULL,
    `visibleToBuyer` BOOLEAN NOT NULL DEFAULT true,
    `visibleToSeller` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_insp_event_requirement`(`requirementId`, `createdAt`),
    INDEX `ix_insp_event_order`(`orderId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `inspection_rules` ADD CONSTRAINT `inspection_rules_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `inspection_plans`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspection_agency_members` ADD CONSTRAINT `inspection_agency_members_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `inspection_agencies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspection_requirements` ADD CONSTRAINT `fk_insp_requirement_group` FOREIGN KEY (`sellerOrderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspection_jobs` ADD CONSTRAINT `inspection_jobs_requirementId_fkey` FOREIGN KEY (`requirementId`) REFERENCES `inspection_requirements`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspection_jobs` ADD CONSTRAINT `inspection_jobs_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `inspection_agencies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspection_conflict_declarations` ADD CONSTRAINT `inspection_conflict_declarations_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `inspection_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspection_conflict_declarations` ADD CONSTRAINT `inspection_conflict_declarations_memberId_fkey` FOREIGN KEY (`memberId`) REFERENCES `inspection_agency_members`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspection_check_results` ADD CONSTRAINT `inspection_check_results_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `inspection_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspection_defects` ADD CONSTRAINT `inspection_defects_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `inspection_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspection_evidence` ADD CONSTRAINT `inspection_evidence_requirementId_fkey` FOREIGN KEY (`requirementId`) REFERENCES `inspection_requirements`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspection_evidence` ADD CONSTRAINT `inspection_evidence_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `inspection_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspection_evidence` ADD CONSTRAINT `inspection_evidence_defectId_fkey` FOREIGN KEY (`defectId`) REFERENCES `inspection_defects`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspection_reports` ADD CONSTRAINT `inspection_reports_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `inspection_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspection_releases` ADD CONSTRAINT `inspection_releases_requirementId_fkey` FOREIGN KEY (`requirementId`) REFERENCES `inspection_requirements`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspection_shipment_bindings` ADD CONSTRAINT `inspection_shipment_bindings_requirementId_fkey` FOREIGN KEY (`requirementId`) REFERENCES `inspection_requirements`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspection_shipment_bindings` ADD CONSTRAINT `inspection_shipment_bindings_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `inspection_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspection_agency_invoices` ADD CONSTRAINT `inspection_agency_invoices_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `inspection_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspection_agency_invoices` ADD CONSTRAINT `inspection_agency_invoices_agencyId_fkey` FOREIGN KEY (`agencyId`) REFERENCES `inspection_agencies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `inspection_events` ADD CONSTRAINT `inspection_events_requirementId_fkey` FOREIGN KEY (`requirementId`) REFERENCES `inspection_requirements`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

