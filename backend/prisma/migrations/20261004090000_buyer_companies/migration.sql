-- Buyer companies: a registered business that buys here, verified by staff
-- before it may place orders in its own name. See the BUYER COMPANIES section
-- of schema.prisma.
--
-- Backward compatible by construction. Every column added to an existing
-- table is NULLable and means "individual" when NULL, so each account, cart,
-- order, address and preorder that already exists carries on exactly as it
-- was, as an individual buyer's, with nothing to backfill. No existing row is
-- rewritten.
--
-- `registrationClaimKey` and `buyer_company_identifiers.claimKey` are UNIQUE
-- and stay NULL until a company is approved. MariaDB treats every NULL as
-- distinct, so any number of drafts and pending applications may name the
-- same registration number (a duplicate *signal* for the reviewer) while two
-- APPROVED companies cannot.

-- AlterTable
ALTER TABLE `sessions` ADD COLUMN `buyerCompanyId` CHAR(26) NULL,
    ADD COLUMN `buyerContextKind` ENUM('INDIVIDUAL', 'COMPANY') NULL;

-- AlterTable
ALTER TABLE `addresses` ADD COLUMN `buyerCompanyId` CHAR(26) NULL;

-- AlterTable
ALTER TABLE `carts` ADD COLUMN `buyerCompanyId` CHAR(26) NULL;

-- AlterTable
ALTER TABLE `orders` ADD COLUMN `buyerCompanyId` CHAR(26) NULL;

-- AlterTable
ALTER TABLE `preorder_requests` ADD COLUMN `buyerCompanyId` CHAR(26) NULL;

-- CreateTable
CREATE TABLE `buyer_companies` (
    `id` CHAR(26) NOT NULL,
    `applicationReference` VARCHAR(16) NOT NULL,
    `status` ENUM('DRAFT', 'EMAIL_VERIFICATION_PENDING', 'SUBMITTED', 'AUTOMATED_CHECK_IN_PROGRESS', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUIRED', 'RESUBMITTED', 'APPROVED', 'REJECTED', 'SUSPENDED', 'REVERIFICATION_REQUIRED') NOT NULL DEFAULT 'DRAFT',
    `version` INTEGER NOT NULL DEFAULT 0,
    `legalName` VARCHAR(255) NULL,
    `legalNameNormalized` VARCHAR(255) NULL,
    `tradingName` VARCHAR(255) NULL,
    `entityType` ENUM('SOLE_PROPRIETORSHIP', 'PARTNERSHIP', 'LIMITED_LIABILITY_PARTNERSHIP', 'PRIVATE_LIMITED_COMPANY', 'PUBLIC_LIMITED_COMPANY', 'COOPERATIVE', 'NON_PROFIT', 'PUBLIC_BODY', 'OTHER') NULL,
    `registrationCountry` CHAR(2) NULL,
    `registrationNumber` VARCHAR(64) NULL,
    `registrationNumberNormalized` VARCHAR(64) NULL,
    `registrationClaimKey` VARCHAR(80) NULL,
    `incorporationDate` DATE NULL,
    `industry` VARCHAR(64) NULL,
    `website` VARCHAR(255) NULL,
    `businessEmail` VARCHAR(320) NULL,
    `businessEmailNormalized` VARCHAR(320) NULL,
    `businessEmailVerifiedAt` DATETIME(3) NULL,
    `businessDomain` VARCHAR(253) NULL,
    `businessDomainStatus` ENUM('UNKNOWN', 'FREE_MAIL_PROVIDER', 'MATCHES_WEBSITE', 'DIFFERS_FROM_WEBSITE', 'NO_WEBSITE') NOT NULL DEFAULT 'UNKNOWN',
    `businessPhone` VARCHAR(32) NULL,
    `applicantJobTitle` VARCHAR(128) NULL,
    `applicantAuthorityConfirmedAt` DATETIME(3) NULL,
    `procurementProfileJson` JSON NULL,
    `riskLevel` ENUM('NONE', 'LOW', 'ELEVATED', 'HIGH') NOT NULL DEFAULT 'NONE',
    `statusReason` VARCHAR(1000) NULL,
    `statusReasonCode` VARCHAR(48) NULL,
    `resubmissionAllowed` BOOLEAN NOT NULL DEFAULT true,
    `createdByUserId` CHAR(26) NOT NULL,
    `submittedAt` DATETIME(3) NULL,
    `firstSubmittedAt` DATETIME(3) NULL,
    `approvedAt` DATETIME(3) NULL,
    `rejectedAt` DATETIME(3) NULL,
    `suspendedAt` DATETIME(3) NULL,
    `reverificationRequestedAt` DATETIME(3) NULL,
    `lastStatusChangedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `archivedAt` DATETIME(3) NULL,

    UNIQUE INDEX `uq_buyer_company_reference`(`applicationReference`),
    UNIQUE INDEX `uq_buyer_company_registration_claim`(`registrationClaimKey`),
    INDEX `ix_buyer_company_status`(`status`, `submittedAt`),
    INDEX `ix_buyer_company_registration`(`registrationCountry`, `registrationNumberNormalized`),
    INDEX `ix_buyer_company_name`(`legalNameNormalized`),
    INDEX `ix_buyer_company_domain`(`businessDomain`),
    INDEX `ix_buyer_company_creator`(`createdByUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `buyer_company_addresses` (
    `id` CHAR(26) NOT NULL,
    `companyId` CHAR(26) NOT NULL,
    `kind` ENUM('REGISTERED_OFFICE', 'OPERATING', 'BILLING', 'SHIPPING') NOT NULL,
    `line1` VARCHAR(255) NOT NULL,
    `line2` VARCHAR(255) NULL,
    `city` VARCHAR(128) NOT NULL,
    `region` VARCHAR(128) NULL,
    `postalCode` VARCHAR(32) NULL,
    `countryCode` CHAR(2) NOT NULL,
    `fingerprint` CHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_buyer_company_address_fingerprint`(`fingerprint`),
    UNIQUE INDEX `uq_buyer_company_address_kind`(`companyId`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `buyer_company_identifiers` (
    `id` CHAR(26) NOT NULL,
    `companyId` CHAR(26) NOT NULL,
    `scheme` VARCHAR(24) NOT NULL,
    `value` VARCHAR(64) NULL,
    `valueNormalized` VARCHAR(64) NULL,
    `notApplicable` BOOLEAN NOT NULL DEFAULT false,
    `notApplicableReason` VARCHAR(48) NULL,
    `claimKey` VARCHAR(120) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_buyer_company_identifier_claim`(`claimKey`),
    INDEX `ix_buyer_company_identifier_value`(`scheme`, `valueNormalized`),
    UNIQUE INDEX `uq_buyer_company_identifier_scheme`(`companyId`, `scheme`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `buyer_company_locations` (
    `id` CHAR(26) NOT NULL,
    `companyId` CHAR(26) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `line1` VARCHAR(255) NOT NULL,
    `line2` VARCHAR(255) NULL,
    `city` VARCHAR(128) NOT NULL,
    `region` VARCHAR(128) NULL,
    `postalCode` VARCHAR(32) NULL,
    `countryCode` CHAR(2) NOT NULL,
    `taxIdentifier` VARCHAR(64) NULL,
    `isBilling` BOOLEAN NOT NULL DEFAULT false,
    `isShipping` BOOLEAN NOT NULL DEFAULT true,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_buyer_company_location_company`(`companyId`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `buyer_company_members` (
    `id` CHAR(26) NOT NULL,
    `companyId` CHAR(26) NOT NULL,
    `userId` CHAR(26) NOT NULL,
    `role` ENUM('OWNER', 'COMPANY_ADMIN', 'BUYER', 'ORDER_APPROVER', 'FINANCE', 'VIEWER') NOT NULL DEFAULT 'BUYER',
    `status` ENUM('ACTIVE', 'SUSPENDED', 'REMOVED') NOT NULL DEFAULT 'ACTIVE',
    `invitedByUserId` CHAR(26) NULL,
    `removedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_buyer_company_member_user`(`userId`, `status`),
    UNIQUE INDEX `uq_buyer_company_member`(`companyId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `buyer_company_verification_cases` (
    `id` CHAR(26) NOT NULL,
    `companyId` CHAR(26) NOT NULL,
    `round` INTEGER NOT NULL,
    `trigger` ENUM('INITIAL', 'RESUBMISSION', 'REVERIFICATION') NOT NULL,
    `state` ENUM('OPEN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `assignedReviewerId` CHAR(26) NULL,
    `assignedAt` DATETIME(3) NULL,
    `requiresSecondReview` BOOLEAN NOT NULL DEFAULT false,
    `firstApprovalById` CHAR(26) NULL,
    `firstApprovalAt` DATETIME(3) NULL,
    `openedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `closedAt` DATETIME(3) NULL,
    `outcome` ENUM('DRAFT', 'EMAIL_VERIFICATION_PENDING', 'SUBMITTED', 'AUTOMATED_CHECK_IN_PROGRESS', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUIRED', 'RESUBMITTED', 'APPROVED', 'REJECTED', 'SUSPENDED', 'REVERIFICATION_REQUIRED') NULL,

    INDEX `ix_buyer_company_case_reviewer`(`state`, `assignedReviewerId`),
    UNIQUE INDEX `uq_buyer_company_case_round`(`companyId`, `round`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `buyer_company_checks` (
    `id` CHAR(26) NOT NULL,
    `companyId` CHAR(26) NOT NULL,
    `caseId` CHAR(26) NULL,
    `provider` VARCHAR(32) NOT NULL,
    `subject` VARCHAR(48) NOT NULL,
    `outcome` ENUM('PASS', 'FAIL', 'INCONCLUSIVE', 'UNAVAILABLE', 'MANUAL_REQUIRED', 'SIGNAL') NOT NULL,
    `summary` VARCHAR(500) NOT NULL,
    `requestJson` JSON NOT NULL,
    `resultJson` JSON NULL,
    `sourceReference` VARCHAR(128) NULL,
    `sourceUrl` VARCHAR(512) NULL,
    `checkedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `triggeredByUserId` CHAR(26) NULL,

    INDEX `ix_buyer_company_check_company`(`companyId`, `checkedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `buyer_company_documents` (
    `id` CHAR(26) NOT NULL,
    `companyId` CHAR(26) NOT NULL,
    `kind` ENUM('CERTIFICATE_OF_INCORPORATION', 'REGISTRY_EXTRACT', 'TAX_REGISTRATION_CERTIFICATE', 'PROOF_OF_REGISTERED_ADDRESS', 'AUTHORIZATION_LETTER', 'REPRESENTATIVE_IDENTITY', 'OWNERSHIP_DECLARATION', 'OTHER') NOT NULL,
    `status` ENUM('PENDING_REVIEW', 'ACCEPTED', 'REJECTED', 'SUPERSEDED', 'WITHDRAWN') NOT NULL DEFAULT 'PENDING_REVIEW',
    `storageKey` VARCHAR(512) NOT NULL,
    `mimeType` VARCHAR(64) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `pageCount` INTEGER NULL,
    `contentHash` CHAR(64) NOT NULL,
    `scanState` ENUM('CLEAN', 'UNSCANNED') NOT NULL,
    `uploadedByUserId` CHAR(26) NOT NULL,
    `infoRequestId` CHAR(26) NULL,
    `reviewedByUserId` CHAR(26) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `reviewReason` VARCHAR(1000) NULL,
    `supersededById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_buyer_company_document_company`(`companyId`, `kind`, `status`),
    INDEX `ix_buyer_company_document_hash`(`contentHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `buyer_company_info_requests` (
    `id` CHAR(26) NOT NULL,
    `companyId` CHAR(26) NOT NULL,
    `caseId` CHAR(26) NULL,
    `status` ENUM('OPEN', 'ANSWERED', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
    `message` TEXT NOT NULL,
    `requestedDocumentKindsJson` JSON NULL,
    `createdByUserId` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `responseMessage` TEXT NULL,
    `respondedByUserId` CHAR(26) NULL,
    `respondedAt` DATETIME(3) NULL,

    INDEX `ix_buyer_company_info_request_company`(`companyId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `buyer_company_review_events` (
    `id` CHAR(26) NOT NULL,
    `companyId` CHAR(26) NOT NULL,
    `caseId` CHAR(26) NULL,
    `kind` VARCHAR(48) NOT NULL,
    `visibility` ENUM('INTERNAL', 'APPLICANT') NOT NULL,
    `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER', 'LOGISTICS') NOT NULL,
    `actorUserId` CHAR(26) NULL,
    `message` TEXT NULL,
    `dataJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_buyer_company_event_company`(`companyId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `buyer_company_status_history` (
    `id` CHAR(26) NOT NULL,
    `companyId` CHAR(26) NOT NULL,
    `fromStatus` ENUM('DRAFT', 'EMAIL_VERIFICATION_PENDING', 'SUBMITTED', 'AUTOMATED_CHECK_IN_PROGRESS', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUIRED', 'RESUBMITTED', 'APPROVED', 'REJECTED', 'SUSPENDED', 'REVERIFICATION_REQUIRED') NOT NULL,
    `toStatus` ENUM('DRAFT', 'EMAIL_VERIFICATION_PENDING', 'SUBMITTED', 'AUTOMATED_CHECK_IN_PROGRESS', 'UNDER_REVIEW', 'MORE_INFORMATION_REQUIRED', 'RESUBMITTED', 'APPROVED', 'REJECTED', 'SUSPENDED', 'REVERIFICATION_REQUIRED') NOT NULL,
    `reason` VARCHAR(1000) NULL,
    `reasonCode` VARCHAR(48) NULL,
    `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER', 'LOGISTICS') NOT NULL,
    `actorUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_buyer_company_status_history`(`companyId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `consent_records` (
    `id` CHAR(26) NOT NULL,
    `userId` CHAR(26) NOT NULL,
    `companyId` CHAR(26) NULL,
    `purpose` ENUM('ACCURACY_DECLARATION', 'BUSINESS_TERMS', 'PRIVACY_NOTICE', 'AUTHORITY_TO_ACT') NOT NULL,
    `textVersion` VARCHAR(32) NOT NULL,
    `textHash` CHAR(64) NOT NULL,
    `acceptedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `ipAddress` VARCHAR(45) NULL,
    `userAgent` VARCHAR(512) NULL,
    `withdrawnAt` DATETIME(3) NULL,

    INDEX `ix_consent_record_user`(`userId`, `purpose`),
    INDEX `ix_consent_record_company`(`companyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `buyer_company_email_challenges` (
    `id` CHAR(26) NOT NULL,
    `companyId` CHAR(26) NOT NULL,
    `userId` CHAR(26) NOT NULL,
    `emailNormalized` VARCHAR(320) NOT NULL,
    `codeHash` CHAR(64) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_buyer_company_email_company`(`companyId`, `consumedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ix_address_buyer_company` ON `addresses`(`buyerCompanyId`, `archivedAt`);

-- CreateIndex
CREATE INDEX `ix_cart_buyer_company` ON `carts`(`buyerCompanyId`, `status`);

-- CreateIndex
CREATE INDEX `ix_order_buyer_company` ON `orders`(`buyerCompanyId`, `createdAt`);

-- CreateIndex
CREATE INDEX `ix_preorder_request_buyer_company` ON `preorder_requests`(`buyerCompanyId`);

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `fk_session_buyer_company` FOREIGN KEY (`buyerCompanyId`) REFERENCES `buyer_companies`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `addresses` ADD CONSTRAINT `fk_address_buyer_company` FOREIGN KEY (`buyerCompanyId`) REFERENCES `buyer_companies`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `carts` ADD CONSTRAINT `fk_cart_buyer_company` FOREIGN KEY (`buyerCompanyId`) REFERENCES `buyer_companies`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `fk_order_buyer_company` FOREIGN KEY (`buyerCompanyId`) REFERENCES `buyer_companies`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_requests` ADD CONSTRAINT `fk_preorder_request_buyer_company` FOREIGN KEY (`buyerCompanyId`) REFERENCES `buyer_companies`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `buyer_company_addresses` ADD CONSTRAINT `fk_buyer_company_address_company` FOREIGN KEY (`companyId`) REFERENCES `buyer_companies`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `buyer_company_identifiers` ADD CONSTRAINT `fk_buyer_company_identifier_company` FOREIGN KEY (`companyId`) REFERENCES `buyer_companies`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `buyer_company_locations` ADD CONSTRAINT `fk_buyer_company_location_company` FOREIGN KEY (`companyId`) REFERENCES `buyer_companies`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `buyer_company_members` ADD CONSTRAINT `fk_buyer_company_member_company` FOREIGN KEY (`companyId`) REFERENCES `buyer_companies`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `buyer_company_members` ADD CONSTRAINT `fk_buyer_company_member_user` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `buyer_company_verification_cases` ADD CONSTRAINT `fk_buyer_company_case_company` FOREIGN KEY (`companyId`) REFERENCES `buyer_companies`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `buyer_company_verification_cases` ADD CONSTRAINT `fk_buyer_company_case_reviewer` FOREIGN KEY (`assignedReviewerId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `buyer_company_checks` ADD CONSTRAINT `fk_buyer_company_check_company` FOREIGN KEY (`companyId`) REFERENCES `buyer_companies`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `buyer_company_checks` ADD CONSTRAINT `fk_buyer_company_check_case` FOREIGN KEY (`caseId`) REFERENCES `buyer_company_verification_cases`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `buyer_company_documents` ADD CONSTRAINT `fk_buyer_company_document_company` FOREIGN KEY (`companyId`) REFERENCES `buyer_companies`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `buyer_company_info_requests` ADD CONSTRAINT `fk_buyer_company_info_request_company` FOREIGN KEY (`companyId`) REFERENCES `buyer_companies`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `buyer_company_info_requests` ADD CONSTRAINT `fk_buyer_company_info_request_case` FOREIGN KEY (`caseId`) REFERENCES `buyer_company_verification_cases`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `buyer_company_review_events` ADD CONSTRAINT `fk_buyer_company_event_company` FOREIGN KEY (`companyId`) REFERENCES `buyer_companies`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `buyer_company_status_history` ADD CONSTRAINT `fk_buyer_company_status_company` FOREIGN KEY (`companyId`) REFERENCES `buyer_companies`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `consent_records` ADD CONSTRAINT `fk_consent_record_user` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `consent_records` ADD CONSTRAINT `fk_consent_record_company` FOREIGN KEY (`companyId`) REFERENCES `buyer_companies`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `buyer_company_email_challenges` ADD CONSTRAINT `fk_buyer_company_email_company` FOREIGN KEY (`companyId`) REFERENCES `buyer_companies`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `buyer_company_email_challenges` ADD CONSTRAINT `fk_buyer_company_email_user` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

