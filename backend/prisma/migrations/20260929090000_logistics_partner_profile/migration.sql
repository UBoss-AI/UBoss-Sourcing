-- My Profile in the logistics portal: the carrier describing itself.
--
-- New columns on logistics_partners are all nullable or defaulted, so every
-- existing row is valid unchanged. verificationState defaults to UNVERIFIED
-- because no identity check has been recorded for any existing carrier.
--
-- logistics_partner_profile_changes holds identity changes (legal name,
-- registration, tax number, registered address, licence) until an operator
-- approves them. pendingKey is UNIQUE and NULL once decided, so one company
-- has at most one open request.
--
-- logistics_partner_documents is the compliance file. Bytes live under the
-- private storage prefix and are served only through a single-use link.


-- AlterTable
ALTER TABLE `logistics_partners` ADD COLUMN `billingContactName` VARCHAR(160) NULL,
    ADD COLUMN `billingEmail` VARCHAR(320) NULL,
    ADD COLUMN `billingPhone` VARCHAR(32) NULL,
    ADD COLUMN `businessDescription` VARCHAR(2000) NULL,
    ADD COLUMN `declaredTransportModesJson` JSON NULL,
    ADD COLUMN `emergencyContactName` VARCHAR(160) NULL,
    ADD COLUMN `hubLocationsJson` JSON NULL,
    ADD COLUMN `logoStorageKey` VARCHAR(512) NULL,
    ADD COLUMN `operatingHoursJson` JSON NULL,
    ADD COLUMN `operationalAddressJson` JSON NULL,
    ADD COLUMN `primaryContactName` VARCHAR(160) NULL,
    ADD COLUMN `primaryContactTitle` VARCHAR(120) NULL,
    ADD COLUMN `supportEmail` VARCHAR(320) NULL,
    ADD COLUMN `supportPhone` VARCHAR(32) NULL,
    ADD COLUMN `timeZone` VARCHAR(64) NULL,
    ADD COLUMN `verificationState` ENUM('UNVERIFIED', 'VERIFIED', 'REVERIFICATION_REQUIRED') NOT NULL DEFAULT 'UNVERIFIED',
    ADD COLUMN `verifiedAt` DATETIME(3) NULL,
    ADD COLUMN `verifiedByUserId` CHAR(26) NULL;

-- CreateTable
CREATE TABLE `logistics_partner_profile_changes` (
    `id` CHAR(26) NOT NULL,
    `logisticsPartnerId` CHAR(26) NOT NULL,
    `state` ENUM('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN') NOT NULL DEFAULT 'PENDING',
    `pendingKey` CHAR(26) NULL,
    `proposedJson` JSON NOT NULL,
    `currentJson` JSON NOT NULL,
    `requestedByUserId` CHAR(26) NOT NULL,
    `requestedByLabel` VARCHAR(160) NOT NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decidedByUserId` CHAR(26) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` VARCHAR(512) NULL,

    UNIQUE INDEX `uq_logistics_profile_change_pending`(`pendingKey`),
    INDEX `ix_logistics_profile_change_partner`(`logisticsPartnerId`, `requestedAt`),
    INDEX `ix_logistics_profile_change_state`(`state`, `requestedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_partner_documents` (
    `id` CHAR(26) NOT NULL,
    `logisticsPartnerId` CHAR(26) NOT NULL,
    `kind` ENUM('BUSINESS_LICENCE', 'INSURANCE_CERTIFICATE', 'TRANSPORT_PERMIT', 'COMPANY_REGISTRATION', 'TAX_REGISTRATION', 'OTHER') NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `originalFileName` VARCHAR(255) NOT NULL,
    `contentType` VARCHAR(128) NOT NULL,
    `byteSize` INTEGER NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `scanState` ENUM('PENDING', 'CLEAN', 'INFECTED', 'FAILED', 'SKIPPED', 'GENERATED') NOT NULL DEFAULT 'PENDING',
    `expiresOn` DATE NULL,
    `reviewState` ENUM('PENDING_REVIEW', 'VERIFIED', 'REJECTED') NOT NULL DEFAULT 'PENDING_REVIEW',
    `reviewedByUserId` CHAR(26) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `rejectionReason` VARCHAR(512) NULL,
    `uploadedByUserId` CHAR(26) NOT NULL,
    `uploadedByLabel` VARCHAR(160) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `supersededAt` DATETIME(3) NULL,

    INDEX `ix_logistics_partner_document_kind`(`logisticsPartnerId`, `kind`, `supersededAt`),
    INDEX `ix_logistics_partner_document_review`(`reviewState`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `logistics_partner_profile_changes` ADD CONSTRAINT `fk_logistics_profile_change_partner` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `logistics_partner_documents` ADD CONSTRAINT `fk_logistics_partner_document_partner` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

