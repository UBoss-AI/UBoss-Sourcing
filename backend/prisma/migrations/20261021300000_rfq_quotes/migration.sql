-- Master row 18: quotes on a request for quotation.
--
-- One quote per seller per request (uq_rfq_quote_seller). A quote is a chain
-- of immutable offer versions (uq_rfq_quote_version); money is BIGINT minor
-- units and a term the seller did not give is NULL, never zero.

-- CreateTable
CREATE TABLE `rfq_quotes` (
    `id` CHAR(26) NOT NULL,
    `rfqId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `invitationId` CHAR(26) NOT NULL,
    `status` ENUM('OPEN', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `currency` CHAR(3) NOT NULL,
    `currentVersionId` CHAR(26) NULL,
    `currentVersionNumber` INTEGER NOT NULL DEFAULT 1,
    `basedOnRequirementVersion` INTEGER NOT NULL,
    `shortlisted` BOOLEAN NOT NULL DEFAULT false,
    `shortlistedAt` DATETIME(3) NULL,
    `acceptedVersionId` CHAR(26) NULL,
    `acceptedTermsHash` CHAR(64) NULL,
    `acceptedTermsJson` JSON NULL,
    `acceptedAt` DATETIME(3) NULL,
    `acceptedByParty` ENUM('BUYER', 'SUPPLIER', 'SYSTEM') NULL,
    `acceptedByUserId` CHAR(26) NULL,
    `closedReason` VARCHAR(40) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_rfq_quote_rfq`(`rfqId`, `status`),
    UNIQUE INDEX `uq_rfq_quote_seller`(`rfqId`, `sellerAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rfq_quote_versions` (
    `id` CHAR(26) NOT NULL,
    `quoteId` CHAR(26) NOT NULL,
    `rfqId` CHAR(26) NOT NULL,
    `versionNumber` INTEGER NOT NULL,
    `authorParty` ENUM('BUYER', 'SUPPLIER', 'SYSTEM') NOT NULL,
    `authorUserId` CHAR(26) NOT NULL,
    `state` ENUM('PROPOSED', 'SUPERSEDED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'CLOSED') NOT NULL DEFAULT 'PROPOSED',
    `currency` CHAR(3) NOT NULL,
    `unitPriceMinor` BIGINT NOT NULL,
    `quantity` DECIMAL(15, 3) NOT NULL,
    `moq` DECIMAL(15, 3) NULL,
    `leadTimeDays` INTEGER NULL,
    `capacityPerMonth` DECIMAL(15, 3) NULL,
    `incoterm` VARCHAR(3) NULL,
    `incotermPlace` VARCHAR(120) NULL,
    `paymentTerms` VARCHAR(500) NULL,
    `inspectionTerms` VARCHAR(500) NULL,
    `warranty` VARCHAR(500) NULL,
    `toolingMinor` BIGINT NULL,
    `sampleCostMinor` BIGINT NULL,
    `shippingEstimateMinor` BIGINT NULL,
    `taxesDisclosure` VARCHAR(1000) NULL,
    `tiersJson` JSON NULL,
    `comment` VARCHAR(2000) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `termsHash` CHAR(64) NOT NULL,
    `respondedAt` DATETIME(3) NULL,
    `respondedByUserId` CHAR(26) NULL,
    `responseNote` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_rfq_quote_version_rfq`(`rfqId`),
    UNIQUE INDEX `uq_rfq_quote_version`(`quoteId`, `versionNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `rfq_quotes` ADD CONSTRAINT `fk_rfq_quote_rfq` FOREIGN KEY (`rfqId`) REFERENCES `rfq_requests`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `rfq_quotes` ADD CONSTRAINT `fk_rfq_quote_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `rfq_quote_versions` ADD CONSTRAINT `fk_rfq_quote_version_quote` FOREIGN KEY (`quoteId`) REFERENCES `rfq_quotes`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
