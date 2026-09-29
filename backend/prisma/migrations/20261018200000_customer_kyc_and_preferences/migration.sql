-- Master row 11: an individual buyer's identity check, importer details,
-- the files they upload to prove them, and their marketing choices.
--
-- The identity document NUMBER is never stored whole: only a masked form
-- ending in its last four characters. Files live in private storage; the row
-- keeps the key, the type, the size and the SHA-256.

CREATE TABLE `customer_kyc` (
    `id` CHAR(26) NOT NULL,
    `customerProfileId` CHAR(26) NOT NULL,
    `legalName` VARCHAR(255) NULL,
    `dateOfBirth` DATE NULL,
    `nationality` CHAR(2) NULL,
    `residenceCountry` CHAR(2) NULL,
    `idDocumentType` VARCHAR(24) NULL,
    `idDocumentNumberMasked` VARCHAR(32) NULL,
    `idDocumentExpiresOn` DATE NULL,
    `status` ENUM('NOT_STARTED', 'SUBMITTED', 'VERIFIED', 'REJECTED', 'EXPIRED') NOT NULL DEFAULT 'NOT_STARTED',
    `submittedAt` DATETIME(3) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `reviewedById` CHAR(26) NULL,
    `reviewNote` VARCHAR(500) NULL,
    `isImporter` BOOLEAN NOT NULL DEFAULT false,
    `importerName` VARCHAR(255) NULL,
    `eoriNumber` VARCHAR(32) NULL,
    `importerTaxId` VARCHAR(64) NULL,
    `importLicenceNumber` VARCHAR(64) NULL,
    `customsBrokerName` VARCHAR(255) NULL,
    `customsBrokerEmail` VARCHAR(320) NULL,
    `preferredIncoterm` VARCHAR(8) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_customer_kyc_profile`(`customerProfileId`),
    INDEX `ix_customer_kyc_status`(`status`, `submittedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `customer_kyc_documents` (
    `id` CHAR(26) NOT NULL,
    `customerProfileId` CHAR(26) NOT NULL,
    `kind` ENUM('IDENTITY', 'PROOF_OF_ADDRESS', 'IMPORT_LICENCE', 'TAX_REGISTRATION', 'OTHER') NOT NULL,
    `status` ENUM('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN') NOT NULL DEFAULT 'PENDING',
    `fileName` VARCHAR(255) NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `mimeType` VARCHAR(100) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `sha256` CHAR(64) NOT NULL,
    `scanState` VARCHAR(16) NOT NULL,
    `reviewNote` VARCHAR(500) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `reviewedById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_customer_kyc_document_profile`(`customerProfileId`, `createdAt`),
    INDEX `ix_customer_kyc_document_status`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `customer_preferences` (
    `id` CHAR(26) NOT NULL,
    `customerProfileId` CHAR(26) NOT NULL,
    `marketingEmailOptIn` BOOLEAN NOT NULL DEFAULT false,
    `marketingSmsOptIn` BOOLEAN NOT NULL DEFAULT false,
    `productNewsOptIn` BOOLEAN NOT NULL DEFAULT false,
    `marketingUpdatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_customer_preference_profile`(`customerProfileId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `customer_kyc` ADD CONSTRAINT `fk_customer_kyc_profile` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `customer_kyc_documents` ADD CONSTRAINT `fk_customer_kyc_document_profile` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `customer_preferences` ADD CONSTRAINT `fk_customer_preference_profile` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
