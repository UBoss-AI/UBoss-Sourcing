-- Supplier trust, market eligibility and search tuning.
--
-- Additive: fourteen new tables and five new members on legal_documents.kind.
-- Nothing existing is altered otherwise.
--
--   * seller_trust_profiles, seller_beneficial_owners, seller_factories (+
--     machines, evidence), seller_certifications, seller_trust_checks and
--     seller_screening_checks hold what a supplier said about itself and what
--     the operator decided about it. The verified-supplier badge is computed
--     from the current checks (modules/trust/badge.ts); no column awards it.
--   * seller_profile_change_requests hold edits to verified fields until an
--     operator approves them.
--   * seller_listing_trust / seller_listing_certifications hold per-listing
--     sourcing terms (samples, OEM, lead time) and the certificates a listing
--     relies on; seller_offer_compliance_holds records offers paused because
--     one of those certificates expired.
--   * market_rules: destination restrictions and document requirements with a
--     source, version and owner. market_landed_cost_rates: the configurable
--     duty / import tax / freight table behind the landed-cost ESTIMATE.
--     market_profiles: operator-written country landing content.
--   * search_synonyms and search_query_logs (anonymous: no user, no session).
--   * trust_settings: one row, 'default', inserted here.
--
-- seller_beneficial_owners names people but holds no userId/customerProfileId;
-- it is disclosed in the GDPR export of the seller owner under
-- `sellerBeneficialOwners`.

-- AlterTable
ALTER TABLE `legal_documents` MODIFY `kind` ENUM('PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'PRIVACY_POLICY', 'INSPECTION_POLICY', 'BUYER_PROTECTION_POLICY', 'PROHIBITED_PRODUCTS') NOT NULL;

-- CreateTable
CREATE TABLE `trust_settings` (
    `id` VARCHAR(16) NOT NULL,
    `certificateExpiryPolicy` ENUM('WARN', 'HOLD_LISTINGS') NOT NULL DEFAULT 'WARN',
    `expiryWarningDays` SMALLINT NOT NULL DEFAULT 30,
    `reverificationDays` SMALLINT NOT NULL DEFAULT 365,
    `badgeRequiresTaxRegistration` BOOLEAN NOT NULL DEFAULT true,
    `badgeRequiresScreening` BOOLEAN NOT NULL DEFAULT true,
    `badgeRequiresFactory` BOOLEAN NOT NULL DEFAULT false,
    `inspectionFeeBasisPoints` SMALLINT NULL,
    `buyerServiceFeeBasisPoints` SMALLINT NULL,
    `updatedById` CHAR(26) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_trust_profiles` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `udyamNumber` VARCHAR(32) NULL,
    `iecNumber` VARCHAR(16) NULL,
    `exportCapable` BOOLEAN NOT NULL DEFAULT false,
    `exportMarketsJson` JSON NULL,
    `yearsExporting` SMALLINT NULL,
    `capabilitiesJson` JSON NULL,
    `responseSlaHours` SMALLINT NULL,
    `about` TEXT NULL,
    `badgeVerified` BOOLEAN NOT NULL DEFAULT false,
    `badgeComputedAt` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_seller_trust_profile_account`(`sellerAccountId`),
    INDEX `ix_seller_trust_profile_badge`(`badgeVerified`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_beneficial_owners` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `fullName` VARCHAR(160) NOT NULL,
    `nationality` CHAR(2) NULL,
    `ownershipBasisPoints` SMALLINT NOT NULL,
    `isControllingPerson` BOOLEAN NOT NULL DEFAULT false,
    `role` VARCHAR(120) NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_beneficial_owner_seller`(`sellerAccountId`, `archivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_factories` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `addressLine1` VARCHAR(255) NOT NULL,
    `addressLine2` VARCHAR(255) NULL,
    `city` VARCHAR(120) NOT NULL,
    `region` VARCHAR(120) NULL,
    `postcode` VARCHAR(24) NOT NULL,
    `countryCode` CHAR(2) NOT NULL,
    `latitude` DECIMAL(10, 7) NULL,
    `longitude` DECIMAL(10, 7) NULL,
    `establishedYear` SMALLINT NULL,
    `floorAreaSqm` INTEGER NULL,
    `workforceCount` INTEGER NULL,
    `qcStaffCount` INTEGER NULL,
    `monthlyCapacity` INTEGER NULL,
    `capacityUnit` VARCHAR(40) NULL,
    `productsMade` TEXT NULL,
    `qcProcess` TEXT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_factory_seller`(`sellerAccountId`, `archivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_factory_machines` (
    `id` CHAR(26) NOT NULL,
    `factoryId` CHAR(26) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `capacityNote` VARCHAR(255) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    INDEX `ix_seller_factory_machine_factory`(`factoryId`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_factory_evidence` (
    `id` CHAR(26) NOT NULL,
    `factoryId` CHAR(26) NOT NULL,
    `documentId` CHAR(26) NOT NULL,
    `caption` VARCHAR(255) NULL,
    `capturedLatitude` DECIMAL(10, 7) NULL,
    `capturedLongitude` DECIMAL(10, 7) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_seller_factory_evidence`(`factoryId`, `documentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_certifications` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `factoryId` CHAR(26) NULL,
    `standard` VARCHAR(80) NOT NULL,
    `certificateNumber` VARCHAR(120) NULL,
    `issuer` VARCHAR(160) NOT NULL,
    `scope` TEXT NULL,
    `issuedOn` DATE NULL,
    `expiresOn` DATE NULL,
    `documentId` CHAR(26) NULL,
    `state` ENUM('PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `verifiedAt` DATETIME(3) NULL,
    `verifiedByUserId` CHAR(26) NULL,
    `lastCheckedAt` DATETIME(3) NULL,
    `rejectionReason` TEXT NULL,
    `expiryWarnedAt` DATETIME(3) NULL,
    `expiredAt` DATETIME(3) NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_certification_seller`(`sellerAccountId`, `state`),
    INDEX `ix_seller_certification_expiry`(`state`, `expiresOn`),
    INDEX `ix_seller_certification_standard`(`standard`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_trust_checks` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `kind` ENUM('LEGAL_ENTITY', 'TAX_REGISTRATION', 'UDYAM_REGISTRATION', 'IMPORT_EXPORT_CODE', 'EXPORT_CAPABILITY', 'BENEFICIAL_OWNERSHIP', 'BANK_ACCOUNT', 'FACTORY') NOT NULL,
    `subjectId` VARCHAR(26) NOT NULL DEFAULT '',
    `state` ENUM('PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `method` VARCHAR(48) NOT NULL DEFAULT 'manual_review',
    `issuer` VARCHAR(160) NULL,
    `checkedValue` VARCHAR(255) NULL,
    `evidenceDocumentId` CHAR(26) NULL,
    `checkedAt` DATETIME(3) NULL,
    `validUntil` DATETIME(3) NULL,
    `sellerReason` TEXT NULL,
    `internalNote` TEXT NULL,
    `decidedByUserId` CHAR(26) NULL,
    `isCurrent` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_trust_check_current`(`sellerAccountId`, `kind`, `subjectId`, `isCurrent`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_screening_checks` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `subjectType` ENUM('ENTITY', 'BENEFICIAL_OWNER') NOT NULL,
    `beneficialOwnerId` CHAR(26) NULL,
    `subjectName` VARCHAR(255) NOT NULL,
    `provider` VARCHAR(48) NOT NULL,
    `automated` BOOLEAN NOT NULL DEFAULT false,
    `state` ENUM('PENDING_REVIEW', 'CLEAR', 'POTENTIAL_MATCH', 'CONFIRMED_MATCH') NOT NULL DEFAULT 'PENDING_REVIEW',
    `listsChecked` VARCHAR(512) NULL,
    `providerReference` VARCHAR(128) NULL,
    `note` TEXT NULL,
    `reviewedByUserId` CHAR(26) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `isCurrent` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_screening_current`(`sellerAccountId`, `isCurrent`),
    INDEX `ix_seller_screening_state`(`state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_profile_change_requests` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `section` VARCHAR(32) NOT NULL,
    `subjectId` VARCHAR(26) NOT NULL DEFAULT '',
    `proposedJson` JSON NOT NULL,
    `previousJson` JSON NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN') NOT NULL DEFAULT 'PENDING',
    `submittedByProfileId` CHAR(26) NULL,
    `decidedByUserId` CHAR(26) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_profile_change_seller`(`sellerAccountId`, `status`),
    INDEX `ix_seller_profile_change_queue`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_listing_trust` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `productId` CHAR(26) NOT NULL,
    `sampleAvailable` BOOLEAN NOT NULL DEFAULT false,
    `sampleNote` VARCHAR(255) NULL,
    `privateLabelAvailable` BOOLEAN NOT NULL DEFAULT false,
    `oemAvailable` BOOLEAN NOT NULL DEFAULT false,
    `leadTimeDaysMin` SMALLINT NULL,
    `leadTimeDaysMax` SMALLINT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_listing_trust_product`(`productId`),
    UNIQUE INDEX `uq_seller_listing_trust`(`sellerAccountId`, `productId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_listing_certifications` (
    `id` CHAR(26) NOT NULL,
    `listingTrustId` CHAR(26) NOT NULL,
    `certificationId` CHAR(26) NOT NULL,

    INDEX `ix_seller_listing_cert_certification`(`certificationId`),
    UNIQUE INDEX `uq_seller_listing_certification`(`listingTrustId`, `certificationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_offer_compliance_holds` (
    `id` CHAR(26) NOT NULL,
    `offerId` CHAR(26) NOT NULL,
    `certificationId` CHAR(26) NOT NULL,
    `previousStatus` ENUM('INACTIVE', 'ACTIVE', 'PAUSED', 'NEEDS_CHANGES', 'ARCHIVED') NOT NULL,
    `heldAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `releasedAt` DATETIME(3) NULL,

    INDEX `ix_offer_compliance_hold_offer`(`offerId`, `releasedAt`),
    INDEX `ix_offer_compliance_hold_certification`(`certificationId`, `releasedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `market_rules` (
    `id` CHAR(26) NOT NULL,
    `scope` ENUM('PRODUCT', 'CATEGORY') NOT NULL,
    `productId` CHAR(26) NULL,
    `categoryId` CHAR(26) NULL,
    `countryCode` CHAR(2) NOT NULL,
    `effect` ENUM('BLOCK', 'DOCUMENTS_REQUIRED') NOT NULL,
    `reason` VARCHAR(512) NOT NULL,
    `requiredDocumentsJson` JSON NULL,
    `source` VARCHAR(255) NOT NULL,
    `version` VARCHAR(32) NOT NULL,
    `ownerName` VARCHAR(160) NOT NULL,
    `effectiveFrom` DATETIME(3) NOT NULL,
    `effectiveUntil` DATETIME(3) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdById` CHAR(26) NULL,
    `updatedById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_market_rule_country`(`countryCode`, `isActive`, `effect`),
    INDEX `ix_market_rule_product`(`productId`),
    INDEX `ix_market_rule_category`(`categoryId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `market_landed_cost_rates` (
    `id` CHAR(26) NOT NULL,
    `countryCode` CHAR(2) NOT NULL,
    `hsPrefix` VARCHAR(10) NOT NULL DEFAULT '',
    `dutyBasisPoints` SMALLINT NOT NULL,
    `importTaxBasisPoints` SMALLINT NOT NULL,
    `freightBasisPoints` SMALLINT NULL,
    `transitDaysMin` SMALLINT NULL,
    `transitDaysMax` SMALLINT NULL,
    `source` VARCHAR(255) NOT NULL,
    `version` VARCHAR(32) NOT NULL,
    `ownerName` VARCHAR(160) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `updatedById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_market_landed_cost_rate`(`countryCode`, `hsPrefix`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `market_profiles` (
    `countryCode` CHAR(2) NOT NULL,
    `headline` VARCHAR(200) NULL,
    `intro` TEXT NULL,
    `dutiesGuidance` TEXT NULL,
    `deliveryPromise` TEXT NULL,
    `complianceNotes` TEXT NULL,
    `featuredCategoriesJson` JSON NULL,
    `isPublished` BOOLEAN NOT NULL DEFAULT false,
    `updatedById` CHAR(26) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`countryCode`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `search_synonyms` (
    `id` CHAR(26) NOT NULL,
    `term` VARCHAR(120) NOT NULL,
    `synonymsJson` JSON NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `updatedById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_search_synonym_term`(`term`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `search_query_logs` (
    `id` CHAR(26) NOT NULL,
    `queryNormalized` VARCHAR(120) NOT NULL,
    `surface` VARCHAR(16) NOT NULL,
    `resultCount` INTEGER NOT NULL,
    `correctedTo` VARCHAR(120) NULL,
    `countryCode` CHAR(2) NULL,
    `language` VARCHAR(10) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_search_query_log_created`(`createdAt`),
    INDEX `ix_search_query_log_query`(`queryNormalized`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `seller_trust_profiles` ADD CONSTRAINT `fk_seller_trust_profile_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_beneficial_owners` ADD CONSTRAINT `fk_seller_beneficial_owner_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_factories` ADD CONSTRAINT `fk_seller_factory_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_factory_machines` ADD CONSTRAINT `fk_seller_factory_machine_factory` FOREIGN KEY (`factoryId`) REFERENCES `seller_factories`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_factory_evidence` ADD CONSTRAINT `fk_seller_factory_evidence_factory` FOREIGN KEY (`factoryId`) REFERENCES `seller_factories`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_certifications` ADD CONSTRAINT `fk_seller_certification_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_certifications` ADD CONSTRAINT `fk_seller_certification_factory` FOREIGN KEY (`factoryId`) REFERENCES `seller_factories`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_trust_checks` ADD CONSTRAINT `fk_seller_trust_check_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_screening_checks` ADD CONSTRAINT `fk_seller_screening_check_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_profile_change_requests` ADD CONSTRAINT `fk_seller_profile_change_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_listing_trust` ADD CONSTRAINT `fk_seller_listing_trust_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_listing_trust` ADD CONSTRAINT `fk_seller_listing_trust_product` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_listing_certifications` ADD CONSTRAINT `fk_seller_listing_cert_listing` FOREIGN KEY (`listingTrustId`) REFERENCES `seller_listing_trust`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_listing_certifications` ADD CONSTRAINT `fk_seller_listing_cert_certification` FOREIGN KEY (`certificationId`) REFERENCES `seller_certifications`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_offer_compliance_holds` ADD CONSTRAINT `fk_offer_compliance_hold_offer` FOREIGN KEY (`offerId`) REFERENCES `seller_offers`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_offer_compliance_holds` ADD CONSTRAINT `fk_offer_compliance_hold_certification` FOREIGN KEY (`certificationId`) REFERENCES `seller_certifications`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `market_rules` ADD CONSTRAINT `fk_market_rule_product` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `market_rules` ADD CONSTRAINT `fk_market_rule_category` FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;


-- The single settings row. Every value is a default the operator changes.
INSERT IGNORE INTO `trust_settings` (`id`, `updatedAt`) VALUES ('default', CURRENT_TIMESTAMP(3));
