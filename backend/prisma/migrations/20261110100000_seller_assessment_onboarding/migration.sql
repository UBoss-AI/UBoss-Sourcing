-- Seller Assessment and Onboarding (policy document Version 1.0, 9 October 2026).
--
-- Adds the eight-gate assessment workflow, the 23-item applicant checklist,
-- scoring, CAPA, the product x site x country x channel scope matrix, the
-- marketplace-appointed external certification record, the internal trading
-- approval and its exact scope (read by the purchase gate), notices, appeals,
-- change requests, incidents, order dispositions, bank-change dual approval
-- and surveillance tasks.
--
-- Additive: new tables, one nullable column on audit_staff_members and one
-- new audit_documents kind. No existing row changes meaning. Legacy APPROVED
-- sellers are NOT converted into trading approvals here - they are reassessed.
--
-- Policy v1.0 is seeded as DRAFT. Its proposed commercial defaults bind only
-- after an authorised person records adoption, an effective date and disclosure.

-- AlterTable
ALTER TABLE `audit_staff_members` ADD COLUMN `assessmentCapabilitiesJson` JSON NULL;

-- AlterTable
ALTER TABLE `audit_documents` MODIFY `kind` ENUM('SELLER_VERIFICATION_CERTIFICATE', 'SELLER_TRADING_APPROVAL', 'SHIPMENT_ASSESSMENT_CERTIFICATE', 'SHIPMENT_WAIVER_AUTHORIZATION', 'SHIPMENT_FINDINGS_REPORT') NOT NULL;

-- CreateTable
CREATE TABLE `seller_assessment_policies` (
    `id` CHAR(26) NOT NULL,
    `version` VARCHAR(16) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
    `configJson` JSON NOT NULL,
    `sourceDocument` VARCHAR(255) NOT NULL,
    `note` TEXT NULL,
    `createdByUserId` CHAR(26) NULL,
    `effectiveFrom` DATETIME(3) NULL,
    `adoptedByUserId` CHAR(26) NULL,
    `adoptedAt` DATETIME(3) NULL,
    `adoptionReference` VARCHAR(255) NULL,
    `disclosedAt` DATETIME(3) NULL,
    `disclosureReference` VARCHAR(255) NULL,
    `retiredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_sa_policy_version`(`version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_assessments` (
    `id` CHAR(26) NOT NULL,
    `number` VARCHAR(32) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `kind` VARCHAR(24) NOT NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
    `policyVersion` VARCHAR(16) NOT NULL,
    `applicationJson` JSON NOT NULL,
    `applicationRevision` INTEGER NOT NULL DEFAULT 0,
    `ownerUserId` CHAR(26) NULL,
    `riskLevel` VARCHAR(8) NOT NULL DEFAULT 'MEDIUM',
    `submittedAt` DATETIME(3) NULL,
    `fileCompleteAt` DATETIME(3) NULL,
    `reviewTargetAt` DATETIME(3) NULL,
    `correctionNote` TEXT NULL,
    `scoreTimesFive` INTEGER NULL,
    `scoreBand` VARCHAR(20) NULL,
    `hardStopsJson` JSON NULL,
    `decision` VARCHAR(24) NULL,
    `decisionReason` TEXT NULL,
    `decidedByUserId` CHAR(26) NULL,
    `decidedAt` DATETIME(3) NULL,
    `baseApprovalId` CHAR(26) NULL,
    `legacyNote` TEXT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_sa_number`(`number`),
    INDEX `ix_sa_seller`(`sellerAccountId`, `status`),
    INDEX `ix_sa_status`(`status`, `reviewTargetAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_assessment_gates` (
    `id` CHAR(26) NOT NULL,
    `assessmentId` CHAR(26) NOT NULL,
    `gate` TINYINT NOT NULL,
    `status` VARCHAR(24) NOT NULL DEFAULT 'NOT_STARTED',
    `assignedUserId` CHAR(26) NULL,
    `decidedByUserId` CHAR(26) NULL,
    `decidedAt` DATETIME(3) NULL,
    `reason` TEXT NULL,
    `policyVersion` VARCHAR(16) NULL,
    `evidenceIdsJson` JSON NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_sa_gate`(`assessmentId`, `gate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_assessment_checklist_items` (
    `id` CHAR(26) NOT NULL,
    `assessmentId` CHAR(26) NOT NULL,
    `code` VARCHAR(8) NOT NULL,
    `outcome` VARCHAR(16) NOT NULL DEFAULT 'UNREVIEWED',
    `evidenceRef` VARCHAR(255) NULL,
    `reviewerUserId` CHAR(26) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `expiresOn` DATE NULL,
    `comment` TEXT NULL,
    `naReason` TEXT NULL,
    `naApprovedByUserId` CHAR(26) NULL,
    `naApprovedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_sa_check`(`assessmentId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_assessment_scores` (
    `id` CHAR(26) NOT NULL,
    `assessmentId` CHAR(26) NOT NULL,
    `dimension` VARCHAR(32) NOT NULL,
    `rating` TINYINT NOT NULL,
    `evidenceRef` VARCHAR(255) NOT NULL,
    `reasoning` TEXT NOT NULL,
    `ratedByUserId` CHAR(26) NOT NULL,
    `ratedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_sa_score`(`assessmentId`, `dimension`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_assessment_evidence` (
    `id` CHAR(26) NOT NULL,
    `assessmentId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `category` VARCHAR(24) NOT NULL,
    `evidenceKey` VARCHAR(64) NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `evidenceVersion` INTEGER NOT NULL DEFAULT 1,
    `supersedesId` CHAR(26) NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `fileName` VARCHAR(255) NOT NULL,
    `contentType` VARCHAR(64) NOT NULL,
    `byteSize` INTEGER NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `scanState` VARCHAR(24) NOT NULL,
    `uploadedByUserId` CHAR(26) NOT NULL,
    `uploadedByRole` VARCHAR(16) NOT NULL,
    `retentionCategory` VARCHAR(24) NOT NULL,
    `legalHold` BOOLEAN NOT NULL DEFAULT false,
    `legalHoldReason` VARCHAR(1000) NULL,
    `legalHoldByUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_sa_evidence_key`(`assessmentId`, `evidenceKey`),
    INDEX `ix_sa_evidence_seller`(`sellerAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_assessment_scope_items` (
    `id` CHAR(26) NOT NULL,
    `assessmentId` CHAR(26) NOT NULL,
    `productKey` VARCHAR(64) NOT NULL,
    `offerId` CHAR(26) NULL,
    `productName` VARCHAR(255) NOT NULL,
    `productVersion` VARCHAR(64) NOT NULL,
    `intendedUse` TEXT NOT NULL,
    `facilityRef` VARCHAR(64) NOT NULL,
    `countryCode` CHAR(2) NOT NULL,
    `channel` VARCHAR(4) NOT NULL,
    `catalogueCategory` VARCHAR(160) NULL,
    `hsProposal` VARCHAR(16) NULL,
    `regulatoryClass` VARCHAR(255) NULL,
    `requiredTests` TEXT NULL,
    `authorisations` TEXT NULL,
    `authorisationExpiresOn` DATE NULL,
    `localResponsible` VARCHAR(512) NULL,
    `importerLicence` VARCHAR(512) NULL,
    `labelsLanguages` VARCHAR(512) NULL,
    `warnings` TEXT NULL,
    `restrictions` TEXT NULL,
    `recallObligations` TEXT NULL,
    `shippingInsurance` TEXT NULL,
    `decision` VARCHAR(12) NOT NULL DEFAULT 'PENDING',
    `decisionReason` TEXT NULL,
    `classifiedByUserId` CHAR(26) NULL,
    `classifiedAt` DATETIME(3) NULL,
    `nextReviewAt` DATETIME(3) NULL,

    UNIQUE INDEX `uq_sa_scope`(`assessmentId`, `productKey`, `facilityRef`, `countryCode`, `channel`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_assessment_findings` (
    `id` CHAR(26) NOT NULL,
    `number` VARCHAR(32) NOT NULL,
    `assessmentId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `classification` VARCHAR(12) NOT NULL,
    `requirement` TEXT NOT NULL,
    `evidence` TEXT NOT NULL,
    `containment` TEXT NULL,
    `rootCause` TEXT NULL,
    `correctiveAction` TEXT NULL,
    `preventiveAction` TEXT NULL,
    `ownerName` VARCHAR(160) NULL,
    `raisedAt` DATETIME(3) NOT NULL,
    `containmentDueAt` DATETIME(3) NULL,
    `planDueAt` DATETIME(3) NULL,
    `closureDueAt` DATETIME(3) NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'OPEN',
    `closureEvidenceIdsJson` JSON NULL,
    `effectivenessVerification` TEXT NULL,
    `raisedByUserId` CHAR(26) NOT NULL,
    `closedByUserId` CHAR(26) NULL,
    `closedAt` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_sa_finding_number`(`number`),
    INDEX `ix_sa_finding`(`assessmentId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_assessment_workpapers` (
    `id` CHAR(26) NOT NULL,
    `assessmentId` CHAR(26) NOT NULL,
    `kind` VARCHAR(24) NOT NULL,
    `subjectRef` VARCHAR(64) NULL,
    `mode` VARCHAR(16) NOT NULL,
    `payloadJson` JSON NOT NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `supersedesId` CHAR(26) NULL,
    `recordedByUserId` CHAR(26) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL,

    INDEX `ix_sa_workpaper`(`assessmentId`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_external_certifications` (
    `id` CHAR(26) NOT NULL,
    `assessmentId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `bodyName` VARCHAR(255) NOT NULL,
    `scheme` VARCHAR(255) NOT NULL,
    `appointedByUserId` CHAR(26) NOT NULL,
    `appointedAt` DATETIME(3) NOT NULL,
    `procurementRef` VARCHAR(128) NULL,
    `paymentRef` VARCHAR(128) NULL,
    `accreditationBody` VARCHAR(255) NULL,
    `accreditationNumber` VARCHAR(128) NULL,
    `accreditationVerified` BOOLEAN NOT NULL DEFAULT false,
    `sectorScope` TEXT NULL,
    `legalRecognition` TEXT NULL,
    `conflictCheck` TEXT NULL,
    `independenceVerified` BOOLEAN NOT NULL DEFAULT false,
    `facilityRefsJson` JSON NULL,
    `productKeysJson` JSON NULL,
    `certificateNumber` VARCHAR(128) NULL,
    `issuer` VARCHAR(255) NULL,
    `authenticityMethod` VARCHAR(255) NULL,
    `authenticityReference` VARCHAR(512) NULL,
    `authenticatedByUserId` CHAR(26) NULL,
    `authenticatedAt` DATETIME(3) NULL,
    `issuedOn` DATE NULL,
    `expiresOn` DATE NULL,
    `surveillanceConditions` TEXT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'APPOINTED',
    `statusReason` TEXT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_sa_cert_seller`(`sellerAccountId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_trading_approvals` (
    `id` CHAR(26) NOT NULL,
    `number` VARCHAR(32) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `assessmentId` CHAR(26) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `supersedesId` CHAR(26) NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    `policyVersion` VARCHAR(16) NOT NULL,
    `policyStatusAtRelease` VARCHAR(16) NOT NULL,
    `externalCertificationId` CHAR(26) NOT NULL,
    `recordJson` JSON NOT NULL,
    `scoreTimesFive` INTEGER NOT NULL,
    `issuedAt` DATETIME(3) NOT NULL,
    `validUntil` DATETIME(3) NOT NULL,
    `nextReviewAt` DATETIME(3) NOT NULL,
    `releaseApproverUserId` CHAR(26) NOT NULL,
    `auditDocumentId` CHAR(26) NULL,
    `statusReason` TEXT NULL,
    `statusChangedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_sta_number`(`number`),
    INDEX `ix_sta_seller`(`sellerAccountId`, `status`),
    INDEX `ix_sta_status`(`status`, `validUntil`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_trading_approval_scopes` (
    `id` CHAR(26) NOT NULL,
    `approvalId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `scopeItemId` CHAR(26) NOT NULL,
    `offerId` CHAR(26) NULL,
    `productKey` VARCHAR(64) NOT NULL,
    `productVersion` VARCHAR(64) NOT NULL,
    `facilityRef` VARCHAR(64) NOT NULL,
    `countryCode` CHAR(2) NOT NULL,
    `channel` VARCHAR(4) NOT NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
    `validUntil` DATETIME(3) NOT NULL,
    `scheduleJson` JSON NOT NULL,
    `blockedReason` TEXT NULL,
    `blockedAt` DATETIME(3) NULL,

    INDEX `ix_stas_lookup`(`sellerAccountId`, `offerId`, `countryCode`, `channel`, `status`),
    INDEX `ix_stas_approval`(`approvalId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_assessment_events` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `assessmentId` CHAR(26) NULL,
    `subjectType` VARCHAR(24) NOT NULL,
    `subjectId` CHAR(26) NULL,
    `kind` VARCHAR(40) NOT NULL,
    `actorUserId` CHAR(26) NULL,
    `actorRole` VARCHAR(16) NOT NULL,
    `capability` VARCHAR(24) NULL,
    `reason` TEXT NULL,
    `policyVersion` VARCHAR(16) NULL,
    `evidenceRefsJson` JSON NULL,
    `dataJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_sae_assessment`(`assessmentId`, `createdAt`),
    INDEX `ix_sae_seller`(`sellerAccountId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_assessment_notices` (
    `id` CHAR(26) NOT NULL,
    `number` VARCHAR(32) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `approvalId` CHAR(26) NULL,
    `assessmentId` CHAR(26) NULL,
    `kind` VARCHAR(16) NOT NULL,
    `hardStop` VARCHAR(40) NULL,
    `scopeIdsJson` JSON NULL,
    `wholeSeller` BOOLEAN NOT NULL DEFAULT false,
    `reason` TEXT NOT NULL,
    `shareableEvidence` TEXT NOT NULL,
    `affectedOrdersJson` JSON NULL,
    `settlementTreatment` TEXT NOT NULL,
    `correctiveActions` TEXT NOT NULL,
    `reviewRoute` TEXT NOT NULL,
    `issuedByUserId` CHAR(26) NOT NULL,
    `issuedAt` DATETIME(3) NOT NULL,
    `appealDeadline` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_san_number`(`number`),
    INDEX `ix_san_seller`(`sellerAccountId`, `issuedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_assessment_appeals` (
    `id` CHAR(26) NOT NULL,
    `noticeId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `grounds` TEXT NOT NULL,
    `evidenceRef` VARCHAR(512) NULL,
    `submittedByProfileId` CHAR(26) NOT NULL,
    `submittedAt` DATETIME(3) NOT NULL,
    `targetBy` DATETIME(3) NOT NULL,
    `reviewerUserId` CHAR(26) NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'SUBMITTED',
    `outcomeReason` TEXT NULL,
    `decidedAt` DATETIME(3) NULL,

    INDEX `ix_saa_status`(`status`, `targetBy`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_assessment_change_requests` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `approvalId` CHAR(26) NULL,
    `kind` VARCHAR(24) NOT NULL,
    `description` TEXT NOT NULL,
    `plannedFrom` DATE NULL,
    `undisclosed` BOOLEAN NOT NULL DEFAULT false,
    `submittedByProfileId` CHAR(26) NULL,
    `recordedByUserId` CHAR(26) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'SUBMITTED',
    `reviewerUserId` CHAR(26) NULL,
    `decisionReason` TEXT NULL,
    `decidedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_sacr_seller`(`sellerAccountId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_incident_reports` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `severity` VARCHAR(12) NOT NULL,
    `description` TEXT NOT NULL,
    `affectedProducts` TEXT NULL,
    `awareAt` DATETIME(3) NOT NULL,
    `reportedAt` DATETIME(3) NOT NULL,
    `deadlineHours` INTEGER NOT NULL,
    `statutoryDeadlineHours` INTEGER NULL,
    `late` BOOLEAN NOT NULL,
    `submittedByProfileId` CHAR(26) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    `reviewerUserId` CHAR(26) NULL,
    `reviewNote` TEXT NULL,
    `reviewedAt` DATETIME(3) NULL,

    INDEX `ix_sir_seller`(`sellerAccountId`, `reportedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_order_dispositions` (
    `id` CHAR(26) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `noticeId` CHAR(26) NULL,
    `trigger` VARCHAR(24) NOT NULL,
    `triggerKey` VARCHAR(64) NOT NULL,
    `reason` TEXT NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'PENDING_REVIEW',
    `decidedByUserId` CHAR(26) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_sod_status`(`status`, `createdAt`),
    UNIQUE INDEX `uq_sod_trigger`(`sellerOrderGroupId`, `triggerKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_bank_change_requests` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `beneficiaryName` VARCHAR(255) NOT NULL,
    `accountLast4` VARCHAR(4) NOT NULL,
    `bankCode` VARCHAR(16) NOT NULL,
    `evidenceRef` VARCHAR(512) NULL,
    `requestedByProfileId` CHAR(26) NOT NULL,
    `requestedAt` DATETIME(3) NOT NULL,
    `knownContactName` VARCHAR(160) NULL,
    `knownContactSource` VARCHAR(255) NULL,
    `contactConfirmedByUserId` CHAR(26) NULL,
    `contactConfirmedAt` DATETIME(3) NULL,
    `firstApproverUserId` CHAR(26) NULL,
    `firstApprovedAt` DATETIME(3) NULL,
    `secondApproverUserId` CHAR(26) NULL,
    `secondApprovedAt` DATETIME(3) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'SUBMITTED',
    `reason` TEXT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,

    INDEX `ix_sbcr_seller`(`sellerAccountId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_surveillance_tasks` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `approvalId` CHAR(26) NULL,
    `kind` VARCHAR(32) NOT NULL,
    `subjectRef` VARCHAR(64) NULL,
    `dueAt` DATETIME(3) NOT NULL,
    `dedupeKey` VARCHAR(160) NOT NULL,
    `status` VARCHAR(12) NOT NULL DEFAULT 'OPEN',
    `outcome` VARCHAR(24) NULL,
    `note` TEXT NULL,
    `completedByUserId` CHAR(26) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_sst_dedupe`(`dedupeKey`),
    INDEX `ix_sst_status`(`status`, `dueAt`),
    INDEX `ix_sst_seller`(`sellerAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `seller_assessments` ADD CONSTRAINT `fk_sa_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_assessment_gates` ADD CONSTRAINT `fk_sa_gate_assessment` FOREIGN KEY (`assessmentId`) REFERENCES `seller_assessments`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_assessment_checklist_items` ADD CONSTRAINT `fk_sa_check_assessment` FOREIGN KEY (`assessmentId`) REFERENCES `seller_assessments`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_assessment_scores` ADD CONSTRAINT `fk_sa_score_assessment` FOREIGN KEY (`assessmentId`) REFERENCES `seller_assessments`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_assessment_evidence` ADD CONSTRAINT `fk_sa_evidence_assessment` FOREIGN KEY (`assessmentId`) REFERENCES `seller_assessments`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_assessment_scope_items` ADD CONSTRAINT `fk_sa_scope_assessment` FOREIGN KEY (`assessmentId`) REFERENCES `seller_assessments`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_assessment_findings` ADD CONSTRAINT `fk_sa_finding_assessment` FOREIGN KEY (`assessmentId`) REFERENCES `seller_assessments`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_assessment_workpapers` ADD CONSTRAINT `fk_sa_workpaper_assessment` FOREIGN KEY (`assessmentId`) REFERENCES `seller_assessments`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_external_certifications` ADD CONSTRAINT `fk_sa_cert_assessment` FOREIGN KEY (`assessmentId`) REFERENCES `seller_assessments`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_trading_approvals` ADD CONSTRAINT `fk_sta_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_trading_approval_scopes` ADD CONSTRAINT `fk_stas_approval` FOREIGN KEY (`approvalId`) REFERENCES `seller_trading_approvals`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_assessment_appeals` ADD CONSTRAINT `fk_saa_notice` FOREIGN KEY (`noticeId`) REFERENCES `seller_assessment_notices`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;


-- Seed: policy v1.0, DRAFT, never adopted by this migration.
INSERT INTO `seller_assessment_policies` (`id`, `version`, `status`, `configJson`, `sourceDocument`, `note`, `createdAt`, `updatedAt`)
VALUES ('01SAP0L1CYV100000000000000', '1.0', 'DRAFT', '{"turnoverMinimumMinor":"30000000000","turnoverCurrency":"INR","releaseScoreMinimum":80,"remediationScoreMinimum":65,"dimensionRatingMinimum":3,"adminReviewTargetBusinessDays":5,"majorPlanDays":7,"majorClosureDays":30,"minorClosureDays":60,"approvalValidityMonths":12,"reminderDaysBeforeExpiry":[90,60,30],"appealWindowCalendarDays":7,"appealTargetBusinessDays":10,"incidentReportHours":24,"retentionYearsDefault":7,"surveillanceMonthsByCategory":{"*":12},"sanctionsRescreenDays":30}', 'Seller Assessment and Onboarding Process and Checklist, Version 1.0, prepared 9 October 2026', 'Proposed defaults from the source document. Not adopted; effective date blank in the source.', NOW(3), NOW(3));

-- Rules the database can hold on its own.
ALTER TABLE `seller_assessment_scores` ADD CONSTRAINT `chk_sa_score_rating` CHECK (`rating` BETWEEN 0 AND 5);
ALTER TABLE `seller_assessment_scope_items` ADD CONSTRAINT `chk_sa_scope_channel` CHECK (`channel` IN ('B2B', 'B2C'));
ALTER TABLE `seller_trading_approval_scopes` ADD CONSTRAINT `chk_stas_channel` CHECK (`channel` IN ('B2B', 'B2C'));
ALTER TABLE `seller_assessment_gates` ADD CONSTRAINT `chk_sa_gate_number` CHECK (`gate` BETWEEN 1 AND 8);
