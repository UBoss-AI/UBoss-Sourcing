-- Audit Console: a fourth sign-in audience (AUDIT), the audit staff and
-- notification tables, versioned compliance requirements and qualification
-- cases (seller/category and product/market), the compliance-review columns on
-- seller_certifications, and the inspection extensions: stage, scope method,
-- agency kind, exact-decimal quantities, laboratory samples with chain of
-- custody, report corrections, the INCONCLUSIVE result, and sub-lot release.
--
-- Additive. Every enum gains members at the end; every new column is NULL or
-- has a default. The one data change maps the existing certification state
-- onto the new review status (below). Existing certificates get no category
-- scope, so they satisfy no compliance requirement until a reviewer scopes
-- them - the backfill review, not an automatic approval.

-- AlterTable
ALTER TABLE `audit_logs` MODIFY `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER', 'LOGISTICS', 'AUDIT') NOT NULL DEFAULT 'SYSTEM';

-- AlterTable
ALTER TABLE `buyer_company_review_events` MODIFY `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER', 'LOGISTICS', 'AUDIT') NOT NULL;

-- AlterTable
ALTER TABLE `buyer_company_status_history` MODIFY `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER', 'LOGISTICS', 'AUDIT') NOT NULL;

-- AlterTable
ALTER TABLE `inspection_agencies` ADD COLUMN `kind` ENUM('THIRD_PARTY', 'INTERNAL', 'SELLER_SELF') NOT NULL DEFAULT 'THIRD_PARTY';

-- AlterTable
ALTER TABLE `inspection_agency_members` MODIFY `status` ENUM('INVITED', 'ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE `inspection_check_results` ADD COLUMN `equipmentCalibratedUntil` DATE NULL,
    ADD COLUMN `equipmentRef` VARCHAR(120) NULL,
    ADD COLUMN `labReportEvidenceId` CHAR(26) NULL;

-- AlterTable
ALTER TABLE `inspection_defects` ADD COLUMN `checkItemCode` VARCHAR(48) NULL,
    ADD COLUMN `unitRefsJson` JSON NULL;

-- AlterTable
ALTER TABLE `inspection_jobs` ADD COLUMN `qaReviewerMemberId` CHAR(26) NULL,
    ADD COLUMN `scopeMethod` ENUM('FULL', 'SAMPLE') NOT NULL DEFAULT 'SAMPLE',
    ADD COLUMN `stage` ENUM('RAW_MATERIAL', 'DURING_PRODUCTION', 'PRE_SHIPMENT', 'RECEIVING') NOT NULL DEFAULT 'PRE_SHIPMENT',
    ADD COLUMN `timezone` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `inspection_reports` ADD COLUMN `correctionReason` TEXT NULL,
    ADD COLUMN `correctsReportId` CHAR(26) NULL,
    ADD COLUMN `limitations` TEXT NULL,
    ADD COLUMN `supersededAt` DATETIME(3) NULL,
    ADD COLUMN `supersededByReportId` CHAR(26) NULL,
    MODIFY `result` ENUM('PASS', 'FAIL', 'INCONCLUSIVE') NOT NULL;

-- AlterTable
ALTER TABLE `inventory_movements` MODIFY `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER', 'LOGISTICS', 'AUDIT') NOT NULL DEFAULT 'SYSTEM';

-- AlterTable
ALTER TABLE `login_attempts` MODIFY `userType` ENUM('ADMIN', 'CUSTOMER', 'LOGISTICS', 'AUDIT') NOT NULL;

-- AlterTable
ALTER TABLE `order_status_history` MODIFY `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER', 'LOGISTICS', 'AUDIT') NOT NULL DEFAULT 'SYSTEM';

-- AlterTable
ALTER TABLE `preorder_status_history` MODIFY `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER', 'LOGISTICS', 'AUDIT') NOT NULL;

-- AlterTable
ALTER TABLE `seller_audit_logs` MODIFY `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER', 'LOGISTICS', 'AUDIT') NOT NULL;

-- AlterTable
ALTER TABLE `seller_certifications` ADD COLUMN `categoryScopeIdsJson` JSON NULL,
    ADD COLUMN `documentType` ENUM('CERTIFICATE', 'LICENCE', 'REGISTRATION', 'DECLARATION_OF_CONFORMITY', 'TEST_REPORT', 'AUTHORISATION', 'OTHER') NOT NULL DEFAULT 'CERTIFICATE',
    ADD COLUMN `internalNote` TEXT NULL,
    ADD COLUMN `issuingCountry` CHAR(2) NULL,
    ADD COLUMN `legalEntityName` VARCHAR(255) NULL,
    ADD COLUMN `modelScope` TEXT NULL,
    ADD COLUMN `noExpiryReason` VARCHAR(1024) NULL,
    ADD COLUMN `productScopeIdsJson` JSON NULL,
    ADD COLUMN `requirementCodesJson` JSON NULL,
    ADD COLUMN `reviewMessage` TEXT NULL,
    ADD COLUMN `reviewStartedAt` DATETIME(3) NULL,
    ADD COLUMN `reviewStatus` ENUM('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED', 'EXPIRED', 'SUSPENDED') NOT NULL DEFAULT 'SUBMITTED',
    ADD COLUMN `reviewerLabel` VARCHAR(160) NULL,
    ADD COLUMN `reviewerUserId` CHAR(26) NULL,
    ADD COLUMN `revision` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `supersededAt` DATETIME(3) NULL,
    ADD COLUMN `supersedesId` CHAR(26) NULL,
    ADD COLUMN `suspendedAt` DATETIME(3) NULL,
    ADD COLUMN `suspendedReason` VARCHAR(1024) NULL,
    ADD COLUMN `verificationMethod` ENUM('MANUAL_EVIDENCE', 'REGISTRY_LOOKUP', 'ISSUER_CONFIRMATION') NULL,
    ADD COLUMN `verificationOutcome` ENUM('NOT_CHECKED', 'VERIFIED', 'UNABLE_TO_VERIFY', 'MISMATCH') NOT NULL DEFAULT 'NOT_CHECKED',
    ADD COLUMN `verificationSource` VARCHAR(1024) NULL;

-- AlterTable
ALTER TABLE `seller_erp_audit_events` MODIFY `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER', 'LOGISTICS', 'AUDIT') NOT NULL;

-- AlterTable
ALTER TABLE `users` MODIFY `type` ENUM('ADMIN', 'CUSTOMER', 'LOGISTICS', 'AUDIT') NOT NULL;

-- CreateTable
CREATE TABLE `audit_staff_members` (
    `id` CHAR(26) NOT NULL,
    `userId` CHAR(26) NOT NULL,
    `role` ENUM('SUPERVISOR', 'COMPLIANCE_REVIEWER') NOT NULL,
    `status` ENUM('INVITED', 'ACTIVE', 'DISABLED') NOT NULL DEFAULT 'INVITED',
    `fullName` VARCHAR(160) NOT NULL,
    `jobTitle` VARCHAR(120) NULL,
    `competenceCategoryIdsJson` JSON NULL,
    `invitedByUserId` CHAR(26) NULL,
    `activatedAt` DATETIME(3) NULL,
    `disabledAt` DATETIME(3) NULL,
    `disabledReason` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_audit_staff_role`(`role`, `status`),
    UNIQUE INDEX `uq_audit_staff_user`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_notifications` (
    `id` CHAR(26) NOT NULL,
    `userId` CHAR(26) NOT NULL,
    `kind` VARCHAR(48) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `body` TEXT NULL,
    `link` VARCHAR(512) NULL,
    `subjectType` VARCHAR(32) NULL,
    `subjectId` CHAR(26) NULL,
    `dedupeKey` VARCHAR(160) NOT NULL DEFAULT '',
    `readAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_audit_notification_user`(`userId`, `readAt`, `createdAt`),
    INDEX `ix_audit_notification_dedupe`(`userId`, `dedupeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `compliance_requirements` (
    `id` CHAR(26) NOT NULL,
    `code` VARCHAR(64) NOT NULL,
    `ruleVersion` INTEGER NOT NULL DEFAULT 1,
    `status` ENUM('DRAFT', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'RETIRED') NOT NULL DEFAULT 'DRAFT',
    `name` VARCHAR(255) NOT NULL,
    `description` TEXT NOT NULL,
    `requiredEvidence` TEXT NOT NULL,
    `obligation` ENUM('LEGAL', 'CONTRACTUAL', 'OPTIONAL_QUALIFICATION') NOT NULL,
    `level` ENUM('SELLER_CATEGORY', 'PRODUCT') NOT NULL,
    `categoryIdsJson` JSON NOT NULL,
    `includeDescendants` BOOLEAN NOT NULL DEFAULT true,
    `supplyRolesJson` JSON NOT NULL,
    `originCountriesJson` JSON NOT NULL,
    `destinationMarketsJson` JSON NOT NULL,
    `riskClassesJson` JSON NOT NULL,
    `productTypeNote` VARCHAR(1024) NULL,
    `intendedUseNote` VARCHAR(1024) NULL,
    `applicability` ENUM('APPLIES', 'CONDITIONAL', 'UNRESOLVED') NOT NULL,
    `applicabilityNote` TEXT NULL,
    `expiryKind` ENUM('DOCUMENT_EXPIRY', 'NO_EXPIRY', 'PERIODIC_REVIEW') NOT NULL,
    `reviewMonths` INTEGER NULL,
    `sourceUrl` VARCHAR(1024) NOT NULL,
    `sourceTitle` VARCHAR(512) NOT NULL,
    `sourcePublisher` VARCHAR(255) NOT NULL,
    `lastReviewedOn` DATE NOT NULL,
    `confidence` VARCHAR(8) NULL,
    `importedFrom` VARCHAR(64) NULL,
    `effectiveFrom` DATETIME(3) NULL,
    `effectiveTo` DATETIME(3) NULL,
    `draftedByUserId` CHAR(26) NULL,
    `draftedByLabel` VARCHAR(160) NOT NULL,
    `submittedAt` DATETIME(3) NULL,
    `decidedByUserId` CHAR(26) NULL,
    `decidedByLabel` VARCHAR(160) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` TEXT NULL,
    `retiredAt` DATETIME(3) NULL,
    `supersedesId` CHAR(26) NULL,
    `lockVersion` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_compliance_requirement_status`(`status`, `level`),
    UNIQUE INDEX `uq_compliance_requirement_version`(`code`, `ruleVersion`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `compliance_cases` (
    `id` CHAR(26) NOT NULL,
    `caseNumber` VARCHAR(32) NOT NULL,
    `level` ENUM('SELLER_CATEGORY', 'PRODUCT') NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `categoryId` CHAR(26) NOT NULL,
    `productId` VARCHAR(26) NOT NULL DEFAULT '',
    `supplyRole` ENUM('MANUFACTURER', 'IMPORTER', 'DISTRIBUTOR', 'AUTHORISED_REPRESENTATIVE') NOT NULL,
    `destinationMarket` VARCHAR(8) NOT NULL DEFAULT '',
    `factoryId` VARCHAR(26) NOT NULL DEFAULT '',
    `status` ENUM('REQUESTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'QUALIFIED', 'REJECTED', 'SUSPENDED', 'EXPIRED', 'REREVIEW_REQUIRED', 'WITHDRAWN') NOT NULL DEFAULT 'REQUESTED',
    `requestedByParty` VARCHAR(16) NOT NULL,
    `requestedById` CHAR(26) NULL,
    `reviewerUserId` CHAR(26) NULL,
    `reviewerLabel` VARCHAR(160) NULL,
    `reviewStartedAt` DATETIME(3) NULL,
    `decidedAt` DATETIME(3) NULL,
    `sellerMessage` TEXT NULL,
    `internalNote` TEXT NULL,
    `determinationsJson` JSON NULL,
    `decisionSnapshotJson` JSON NULL,
    `expiresAt` DATETIME(3) NULL,
    `lockVersion` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_compliance_case_status`(`status`, `updatedAt`),
    INDEX `ix_compliance_case_seller`(`sellerAccountId`, `status`),
    INDEX `ix_compliance_case_category`(`categoryId`),
    UNIQUE INDEX `uq_compliance_case_number`(`caseNumber`),
    UNIQUE INDEX `uq_compliance_case_scope`(`level`, `sellerAccountId`, `categoryId`, `productId`, `supplyRole`, `destinationMarket`, `factoryId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `compliance_events` (
    `id` CHAR(26) NOT NULL,
    `subjectType` VARCHAR(24) NOT NULL,
    `subjectId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NULL,
    `kind` VARCHAR(48) NOT NULL,
    `actorType` VARCHAR(16) NOT NULL,
    `actorUserId` CHAR(26) NULL,
    `actorLabel` VARCHAR(160) NOT NULL,
    `summary` VARCHAR(1000) NOT NULL,
    `sellerVisible` BOOLEAN NOT NULL DEFAULT false,
    `dataJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_compliance_event_subject`(`subjectType`, `subjectId`, `createdAt`),
    INDEX `ix_compliance_event_seller`(`sellerAccountId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_quantity_records` (
    `id` CHAR(26) NOT NULL,
    `jobId` CHAR(26) NOT NULL,
    `unit` ENUM('PIECE', 'PAIR', 'SET', 'BOX', 'CARTON', 'PALLET', 'ROLL', 'KILOGRAM', 'GRAM', 'LITRE', 'MILLILITRE', 'METRE', 'SQUARE_METRE') NOT NULL,
    `orderedQuantity` DECIMAL(18, 3) NOT NULL,
    `declaredQuantity` DECIMAL(18, 3) NULL,
    `verifiedQuantity` DECIMAL(18, 3) NULL,
    `countingMethod` VARCHAR(24) NULL,
    `countingNote` VARCHAR(1024) NULL,
    `packagingJson` JSON NULL,
    `sampledQuantity` DECIMAL(18, 3) NULL,
    `functionallyTestedQuantity` DECIMAL(18, 3) NULL,
    `testedConformingQuantity` DECIMAL(18, 3) NULL,
    `testedNonconformingQuantity` DECIMAL(18, 3) NULL,
    `damagedQuantity` DECIMAL(18, 3) NULL,
    `packagingObservations` TEXT NULL,
    `labelingObservations` TEXT NULL,
    `damageObservations` TEXT NULL,
    `recordedByMemberId` CHAR(26) NOT NULL,
    `lockVersion` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_insp_quantity_job`(`jobId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_lab_samples` (
    `id` CHAR(26) NOT NULL,
    `jobId` CHAR(26) NOT NULL,
    `sampleCode` VARCHAR(64) NOT NULL,
    `description` VARCHAR(1024) NOT NULL,
    `quantity` DECIMAL(18, 3) NULL,
    `unit` ENUM('PIECE', 'PAIR', 'SET', 'BOX', 'CARTON', 'PALLET', 'ROLL', 'KILOGRAM', 'GRAM', 'LITRE', 'MILLILITRE', 'METRE', 'SQUARE_METRE') NULL,
    `sealNumber` VARCHAR(64) NULL,
    `takenAt` DATETIME(3) NOT NULL,
    `takenByMemberId` CHAR(26) NOT NULL,
    `laboratoryName` VARCHAR(255) NULL,
    `laboratoryAccreditation` VARCHAR(255) NULL,
    `custodyJson` JSON NOT NULL,
    `labReportEvidenceId` CHAR(26) NULL,
    `resultSummary` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_insp_lab_sample_code`(`jobId`, `sampleCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `inspection_sublot_releases` (
    `id` CHAR(26) NOT NULL,
    `requirementId` CHAR(26) NOT NULL,
    `jobId` CHAR(26) NOT NULL,
    `reportId` CHAR(26) NOT NULL,
    `subLotCode` VARCHAR(64) NOT NULL,
    `lotReference` VARCHAR(64) NOT NULL,
    `quantity` DECIMAL(18, 3) NOT NULL,
    `unit` ENUM('PIECE', 'PAIR', 'SET', 'BOX', 'CARTON', 'PALLET', 'ROLL', 'KILOGRAM', 'GRAM', 'LITRE', 'MILLILITRE', 'METRE', 'SQUARE_METRE') NOT NULL,
    `linesJson` JSON NOT NULL,
    `reason` TEXT NOT NULL,
    `state` ENUM('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING_APPROVAL',
    `requestedByUserId` CHAR(26) NOT NULL,
    `requestedByLabel` VARCHAR(160) NOT NULL,
    `requestedAt` DATETIME(3) NOT NULL,
    `decidedByUserId` CHAR(26) NULL,
    `decidedByLabel` VARCHAR(160) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` VARCHAR(1024) NULL,
    `consumedAt` DATETIME(3) NULL,
    `consumedByRef` VARCHAR(64) NULL,
    `lockVersion` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_insp_sublot_state`(`state`),
    UNIQUE INDEX `uq_insp_sublot_code`(`requirementId`, `subLotCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ix_seller_certification_review` ON `seller_certifications`(`reviewStatus`, `expiresOn`);

-- AddForeignKey
ALTER TABLE `compliance_cases` ADD CONSTRAINT `fk_compliance_case_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `compliance_cases` ADD CONSTRAINT `fk_compliance_case_category` FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `inspection_quantity_records` ADD CONSTRAINT `fk_insp_quantity_job` FOREIGN KEY (`jobId`) REFERENCES `inspection_jobs`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `inspection_lab_samples` ADD CONSTRAINT `fk_insp_lab_sample_job` FOREIGN KEY (`jobId`) REFERENCES `inspection_jobs`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `inspection_sublot_releases` ADD CONSTRAINT `fk_insp_sublot_requirement` FOREIGN KEY (`requirementId`) REFERENCES `inspection_requirements`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;


-- Backfill: the review status of certificates that existed before this table
-- had one, from the state the old workflow kept.
UPDATE `seller_certifications` SET `reviewStatus` = 'APPROVED' WHERE `state` = 'VERIFIED';
UPDATE `seller_certifications` SET `reviewStatus` = 'REJECTED' WHERE `state` = 'REJECTED';
UPDATE `seller_certifications` SET `reviewStatus` = 'EXPIRED' WHERE `state` = 'EXPIRED';
