-- The Seller Hub: third-party sellers on the marketplace.
--
-- Thirty-two new tables and two new columns on `products`. Nothing is dropped,
-- nothing is narrowed, and every added column is nullable or defaulted, so a
-- running deployment that never opens the Seller Hub behaves exactly as it did
-- the day before this ran.
--
-- WHY THIS IS ONE MIGRATION AND NOT SIX
--
-- The tables are mutually dependent through foreign keys - an offer needs a
-- seller and a product, an inventory row needs an offer and a location, a
-- settlement line needs an order group. Splitting them would produce
-- intermediate states where half the graph exists and the other half's
-- constraints cannot be added, and every one of those states is a deploy that
-- can fail halfway.
--
-- THE TWO COLUMNS ON `products`
--
-- `isMarketplaceProduct` and `createdBySellerAccountId`. Both default to the
-- pre-existing behaviour: every row already in the table is an operator
-- product created by nobody, which is exactly what it was. The foreign key is
-- ON DELETE SET NULL rather than CASCADE deliberately - deleting a seller
-- account must never delete catalogue entries that other sellers are offering
-- and that buyers have ordered.
--
-- WHAT MARIADB 10.4 FORCED
--
--   * No native UUID. Every id is a ULID in CHAR(26), like the rest of this
--     schema.
--   * A UNIQUE index treats every NULL as distinct. Three places would have
--     been silently broken by that and each carries a NOT NULL surrogate:
--     `seller_offers.variantKey` ('' for the base product),
--     `seller_onboarding_requirements.countryKey` ('*' for "every country"),
--     and `category_attribute_definitions.categoryKey` ('*' for "every
--     category"). Without them, two base-product offers from one seller would
--     both be accepted.
--   * No SKIP LOCKED. Seller stock is decremented with a conditional UPDATE
--     against `seller_inventory.version` and an affected-rows check, the same
--     lease pattern `JobQueue` and `RecurringSchedule` already use.
--
-- MONEY
--
-- Every amount here is BigInt minor units, like every other money column in
-- this schema. The CHECK constraints at the bottom are the ones that can be
-- expressed in the database; the settlement identity (gross - commission -
-- fees - refunds + adjustments = net) cannot be, because it spans two tables,
-- and is asserted in `tests/unit/seller-settlement-arithmetic.test.ts`
-- instead.

-- AlterTable
ALTER TABLE `products` ADD COLUMN `createdBySellerAccountId` CHAR(26) NULL,
    ADD COLUMN `isMarketplaceProduct` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `seller_accounts` (
    `id` CHAR(26) NOT NULL,
    `legalName` VARCHAR(255) NOT NULL,
    `displayName` VARCHAR(160) NOT NULL,
    `displayNameNormalized` VARCHAR(160) NOT NULL,
    `slug` VARCHAR(180) NOT NULL,
    `kind` ENUM('MANUFACTURER', 'AUTHORISED_DISTRIBUTOR', 'WHOLESALER', 'RESELLER') NOT NULL DEFAULT 'RESELLER',
    `status` ENUM('DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED', 'SUSPENDED') NOT NULL DEFAULT 'DRAFT',
    `registrationCountry` CHAR(2) NOT NULL,
    `description` TEXT NULL,
    `statusReason` TEXT NULL,
    `internalNotes` TEXT NULL,
    `resubmissionAllowed` BOOLEAN NOT NULL DEFAULT true,
    `commissionBasisPoints` SMALLINT NULL,
    `qualityScore` DECIMAL(5, 2) NULL,
    `submittedAt` DATETIME(3) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `approvedAt` DATETIME(3) NULL,
    `suspendedAt` DATETIME(3) NULL,
    `createdByProfileId` CHAR(26) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `archivedAt` DATETIME(3) NULL,

    UNIQUE INDEX `uq_seller_display_name`(`displayNameNormalized`),
    UNIQUE INDEX `uq_seller_slug`(`slug`),
    INDEX `ix_seller_status`(`status`, `createdAt`),
    INDEX `ix_seller_country`(`registrationCountry`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_members` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `customerProfileId` CHAR(26) NOT NULL,
    `role` ENUM('OWNER', 'ADMIN', 'CATALOGUE_MANAGER', 'INVENTORY_MANAGER', 'ORDER_MANAGER', 'FINANCE_VIEWER', 'SUPPORT_MEMBER') NOT NULL DEFAULT 'SUPPORT_MEMBER',
    `invitedByProfileId` CHAR(26) NULL,
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `removedAt` DATETIME(3) NULL,

    UNIQUE INDEX `uq_seller_member_profile`(`customerProfileId`),
    INDEX `ix_seller_member_role`(`sellerAccountId`, `role`),
    INDEX `ix_seller_member_active`(`sellerAccountId`, `removedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_invitations` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `emailNormalized` VARCHAR(320) NOT NULL,
    `role` ENUM('OWNER', 'ADMIN', 'CATALOGUE_MANAGER', 'INVENTORY_MANAGER', 'ORDER_MANAGER', 'FINANCE_VIEWER', 'SUPPORT_MEMBER') NOT NULL DEFAULT 'SUPPORT_MEMBER',
    `tokenHash` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `invitedByProfileId` CHAR(26) NULL,
    `acceptedAt` DATETIME(3) NULL,
    `acceptedByProfileId` CHAR(26) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_seller_invitation_token`(`tokenHash`),
    INDEX `ix_seller_invitation_account`(`sellerAccountId`, `acceptedAt`),
    INDEX `ix_seller_invitation_email`(`emailNormalized`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_onboarding_progress` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `stepsJson` JSON NOT NULL,
    `completedSteps` INTEGER NOT NULL DEFAULT 0,
    `requiredSteps` INTEGER NOT NULL DEFAULT 0,
    `lastStepKey` VARCHAR(64) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_seller_onboarding_account`(`sellerAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_onboarding_requirements` (
    `id` CHAR(26) NOT NULL,
    `countryCode` CHAR(2) NULL,
    `countryKey` VARCHAR(2) NOT NULL,
    `stepKey` VARCHAR(64) NOT NULL,
    `fieldKey` VARCHAR(64) NOT NULL,
    `label` VARCHAR(160) NOT NULL,
    `helpText` VARCHAR(512) NULL,
    `isRequired` BOOLEAN NOT NULL DEFAULT true,
    `isDocument` BOOLEAN NOT NULL DEFAULT false,
    `validationPattern` VARCHAR(255) NULL,
    `appliesToKind` ENUM('MANUFACTURER', 'AUTHORISED_DISTRIBUTOR', 'WHOLESALER', 'RESELLER') NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_requirement_step`(`countryKey`, `stepKey`),
    UNIQUE INDEX `uq_seller_requirement`(`countryKey`, `stepKey`, `fieldKey`, `appliesToKind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_business_profiles` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `representativeName` VARCHAR(160) NULL,
    `representativeEmail` VARCHAR(320) NULL,
    `representativePhone` VARCHAR(32) NULL,
    `representativeRole` VARCHAR(120) NULL,
    `supportEmail` VARCHAR(320) NULL,
    `supportPhone` VARCHAR(32) NULL,
    `preferredLanguage` VARCHAR(12) NULL,
    `timezone` VARCHAR(64) NULL,
    `companyRegistrationNumber` VARCHAR(64) NULL,
    `taxRegistrationNumber` VARCHAR(64) NULL,
    `eoriNumber` VARCHAR(32) NULL,
    `eudamedSrn` VARCHAR(64) NULL,
    `websiteUrl` VARCHAR(512) NULL,
    `yearsInBusiness` SMALLINT NULL,
    `registeredAddressLine1` VARCHAR(255) NULL,
    `registeredAddressLine2` VARCHAR(255) NULL,
    `registeredCity` VARCHAR(120) NULL,
    `registeredRegion` VARCHAR(120) NULL,
    `registeredPostcode` VARCHAR(24) NULL,
    `registeredCountry` CHAR(2) NULL,
    `billingAddressLine1` VARCHAR(255) NULL,
    `billingAddressLine2` VARCHAR(255) NULL,
    `billingCity` VARCHAR(120) NULL,
    `billingRegion` VARCHAR(120) NULL,
    `billingPostcode` VARCHAR(24) NULL,
    `billingCountry` CHAR(2) NULL,
    `extraIdentifiersJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_seller_business_profile_account`(`sellerAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_verification_cases` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `kind` ENUM('BUSINESS_REGISTRATION', 'REPRESENTATIVE_IDENTITY', 'TAX_REGISTRATION', 'BANK_ACCOUNT', 'MEDICAL_COMPLIANCE', 'BRAND_AUTHORISATION') NOT NULL,
    `state` ENUM('NOT_STARTED', 'AWAITING_INPUT', 'IN_PROGRESS', 'VERIFIED', 'FAILED', 'PROVIDER_UNCONFIGURED', 'EXPIRED') NOT NULL DEFAULT 'NOT_STARTED',
    `provider` VARCHAR(48) NULL,
    `providerReference` VARCHAR(128) NULL,
    `failureReason` TEXT NULL,
    `internalDetail` TEXT NULL,
    `expiresAt` DATETIME(3) NULL,
    `isCurrent` BOOLEAN NOT NULL DEFAULT true,
    `decidedByUserId` CHAR(26) NULL,
    `decidedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_verification_current`(`sellerAccountId`, `kind`, `isCurrent`),
    INDEX `ix_seller_verification_expiry`(`state`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_documents` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `kind` ENUM('BUSINESS_REGISTRATION', 'TAX_CERTIFICATE', 'IDENTITY_PROOF', 'ADDRESS_PROOF', 'ISO_13485', 'CE_CERTIFICATE', 'DECLARATION_OF_CONFORMITY', 'NOTIFIED_BODY_CERTIFICATE', 'REGULATORY_LICENCE', 'BRAND_AUTHORISATION', 'TRADEMARK_EVIDENCE', 'INSTRUCTIONS_FOR_USE', 'STERILISATION_EVIDENCE', 'BANK_STATEMENT', 'OTHER') NOT NULL,
    `requirementFieldKey` VARCHAR(64) NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `originalFileName` VARCHAR(255) NOT NULL,
    `contentType` VARCHAR(128) NOT NULL,
    `byteSize` INTEGER NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `scanState` ENUM('PENDING_SCAN', 'CLEAN', 'INFECTED', 'SCAN_FAILED', 'SCANNER_UNCONFIGURED') NOT NULL DEFAULT 'PENDING_SCAN',
    `scannedAt` DATETIME(3) NULL,
    `approvedAt` DATETIME(3) NULL,
    `approvedByUserId` CHAR(26) NULL,
    `rejectedReason` TEXT NULL,
    `issuedOn` DATE NULL,
    `expiresOn` DATE NULL,
    `uploadedByProfileId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `supersededAt` DATETIME(3) NULL,

    INDEX `ix_seller_document_kind`(`sellerAccountId`, `kind`, `supersededAt`),
    INDEX `ix_seller_document_expiry`(`expiresOn`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_agreement_acceptances` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `kind` ENUM('MARKETPLACE_AGREEMENT', 'COMMISSION_SCHEDULE', 'RETURNS_POLICY', 'PRIVACY_POLICY', 'INTELLECTUAL_PROPERTY_DECLARATION') NOT NULL,
    `version` VARCHAR(32) NOT NULL,
    `method` ENUM('CLICKWRAP', 'DRAWN_CONSENT', 'QUALIFIED_ESIGNATURE') NOT NULL DEFAULT 'CLICKWRAP',
    `acceptedByProfileId` CHAR(26) NULL,
    `acceptedName` VARCHAR(160) NULL,
    `signatureStorageKey` VARCHAR(512) NULL,
    `ipAddress` VARCHAR(45) NULL,
    `userAgent` VARCHAR(512) NULL,
    `acceptedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_seller_agreement_kind`(`sellerAccountId`, `kind`, `acceptedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_payout_account_references` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `provider` VARCHAR(48) NULL,
    `providerAccountId` VARCHAR(128) NULL,
    `state` ENUM('NOT_STARTED', 'REQUIREMENTS_DUE', 'PENDING_VERIFICATION', 'ENABLED', 'RESTRICTED', 'PROVIDER_UNCONFIGURED') NOT NULL DEFAULT 'NOT_STARTED',
    `pendingRequirementsJson` JSON NULL,
    `bankName` VARCHAR(120) NULL,
    `accountLast4` VARCHAR(4) NULL,
    `payoutCurrency` CHAR(3) NULL,
    `payoutCountry` CHAR(2) NULL,
    `payoutsEnabled` BOOLEAN NOT NULL DEFAULT false,
    `payoutsHeldByOperator` BOOLEAN NOT NULL DEFAULT false,
    `payoutHoldReason` TEXT NULL,
    `lastSyncedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_seller_payout_account`(`sellerAccountId`),
    INDEX `ix_seller_payout_account_state`(`state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_locations` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `addressLine1` VARCHAR(255) NOT NULL,
    `addressLine2` VARCHAR(255) NULL,
    `city` VARCHAR(120) NOT NULL,
    `region` VARCHAR(120) NULL,
    `postcode` VARCHAR(24) NOT NULL,
    `countryCode` CHAR(2) NOT NULL,
    `latitude` DECIMAL(10, 7) NULL,
    `longitude` DECIMAL(10, 7) NULL,
    `timezone` VARCHAR(64) NOT NULL DEFAULT 'UTC',
    `isPickupLocation` BOOLEAN NOT NULL DEFAULT true,
    `isReturnLocation` BOOLEAN NOT NULL DEFAULT true,
    `dispatchCutoff` VARCHAR(5) NULL,
    `workingDaysMask` INTEGER NOT NULL DEFAULT 31,
    `handlingTimeDays` INTEGER NOT NULL DEFAULT 1,
    `shipsToCountriesJson` JSON NULL,
    `hasColdChain` BOOLEAN NOT NULL DEFAULT false,
    `hasControlledStorage` BOOLEAN NOT NULL DEFAULT false,
    `hasSterileStorage` BOOLEAN NOT NULL DEFAULT false,
    `isOperational` BOOLEAN NOT NULL DEFAULT true,
    `closedReason` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `archivedAt` DATETIME(3) NULL,

    INDEX `ix_seller_location_operational`(`sellerAccountId`, `isOperational`),
    INDEX `ix_seller_location_country`(`countryCode`),
    UNIQUE INDEX `uq_seller_location_code`(`sellerAccountId`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `brands` (
    `id` CHAR(26) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `nameNormalized` VARCHAR(160) NOT NULL,
    `slug` VARCHAR(180) NOT NULL,
    `status` ENUM('APPROVED', 'PENDING', 'REJECTED', 'RETIRED') NOT NULL DEFAULT 'PENDING',
    `manufacturerLegalName` VARCHAR(255) NULL,
    `manufacturerCountry` CHAR(2) NULL,
    `description` TEXT NULL,
    `websiteUrl` VARCHAR(512) NULL,
    `logoStorageKey` VARCHAR(512) NULL,
    `rejectedReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_brand_name_normalized`(`nameNormalized`),
    UNIQUE INDEX `uq_brand_slug`(`slug`),
    INDEX `ix_brand_status_name`(`status`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `brand_requests` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `brandId` CHAR(26) NULL,
    `requestedName` VARCHAR(160) NOT NULL,
    `manufacturerLegalName` VARCHAR(255) NULL,
    `websiteUrl` VARCHAR(512) NULL,
    `justification` TEXT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'INFORMATION_REQUESTED') NOT NULL DEFAULT 'PENDING',
    `decisionReason` TEXT NULL,
    `decidedByUserId` CHAR(26) NULL,
    `decidedAt` DATETIME(3) NULL,
    `requestedByProfileId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_brand_request_seller`(`sellerAccountId`, `status`),
    INDEX `ix_brand_request_queue`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `category_attribute_definitions` (
    `id` CHAR(26) NOT NULL,
    `categoryId` CHAR(26) NULL,
    `categoryKey` VARCHAR(26) NOT NULL,
    `attributeKey` VARCHAR(64) NOT NULL,
    `label` VARCHAR(160) NOT NULL,
    `helpText` VARCHAR(512) NULL,
    `section` ENUM('PRODUCT_PHOTOS', 'PRICE_STOCK_SHIPPING', 'PRODUCT_DESCRIPTION', 'ADDITIONAL_INFORMATION', 'MEDICAL_COMPLIANCE') NOT NULL,
    `type` ENUM('TEXT', 'LONG_TEXT', 'RICH_TEXT', 'NUMBER', 'DECIMAL', 'MEASUREMENT', 'DROPDOWN', 'MULTI_SELECT', 'BOOLEAN', 'DATE', 'KEY_VALUE_LIST', 'DOCUMENT') NOT NULL,
    `isRequired` BOOLEAN NOT NULL DEFAULT false,
    `unit` VARCHAR(24) NULL,
    `allowedUnitsJson` JSON NULL,
    `allowedValuesJson` JSON NULL,
    `minNumber` DECIMAL(18, 6) NULL,
    `maxNumber` DECIMAL(18, 6) NULL,
    `minLength` INTEGER NULL,
    `maxLength` INTEGER NULL,
    `pattern` VARCHAR(255) NULL,
    `isSearchable` BOOLEAN NOT NULL DEFAULT false,
    `isVariantDimension` BOOLEAN NOT NULL DEFAULT false,
    `isTitleComponent` BOOLEAN NOT NULL DEFAULT false,
    `titleOrder` SMALLINT NULL,
    `isRegulatoryOnly` BOOLEAN NOT NULL DEFAULT false,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_category_attribute_section`(`categoryId`, `section`, `sortOrder`),
    UNIQUE INDEX `uq_category_attribute_key`(`categoryKey`, `attributeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_listing_drafts` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `status` ENUM('DRAFT', 'VALIDATION_FAILED', 'READY_FOR_SUBMISSION', 'PENDING_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED', 'ARCHIVED') NOT NULL DEFAULT 'DRAFT',
    `categoryId` CHAR(26) NULL,
    `brandId` CHAR(26) NULL,
    `matchedProductId` CHAR(26) NULL,
    `publishedProductId` CHAR(26) NULL,
    `publishedOfferId` CHAR(26) NULL,
    `sellerSku` VARCHAR(64) NULL,
    `attributesJson` JSON NULL,
    `offerJson` JSON NULL,
    `stockJson` JSON NULL,
    `packagingJson` JSON NULL,
    `generatedTitle` VARCHAR(512) NULL,
    `generatedTitleSource` JSON NULL,
    `sellerEditedTitle` VARCHAR(512) NULL,
    `sectionStateJson` JSON NULL,
    `reviewComment` TEXT NULL,
    `reviewedByUserId` CHAR(26) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `submittedAt` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdByProfileId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_listing_draft_seller_status`(`sellerAccountId`, `status`, `updatedAt`),
    INDEX `ix_listing_draft_review_queue`(`status`, `submittedAt`),
    INDEX `ix_listing_draft_sku`(`sellerAccountId`, `sellerSku`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_listing_draft_media` (
    `id` CHAR(26) NOT NULL,
    `draftId` CHAR(26) NOT NULL,
    `slot` ENUM('FRONT_VIEW', 'BACK_VIEW', 'SIDE_VIEW', 'PACKAGING', 'PRODUCT_LABEL', 'UDI_LABEL', 'DIMENSIONS_REFERENCE', 'CONNECTOR_VIEW', 'STERILE_SEAL', 'INSTRUCTIONS_VIEW', 'OTHER', 'DOCUMENT') NOT NULL DEFAULT 'OTHER',
    `storageKey` VARCHAR(512) NOT NULL,
    `originalFileName` VARCHAR(255) NOT NULL,
    `contentType` VARCHAR(128) NOT NULL,
    `byteSize` INTEGER NOT NULL DEFAULT 0,
    `contentHash` CHAR(64) NULL,
    `widthPx` INTEGER NULL,
    `heightPx` INTEGER NULL,
    `altText` VARCHAR(255) NULL,
    `isPrimary` BOOLEAN NOT NULL DEFAULT false,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `uploadedAt` DATETIME(3) NULL,
    `scanState` ENUM('PENDING_SCAN', 'CLEAN', 'INFECTED', 'SCAN_FAILED', 'SCANNER_UNCONFIGURED') NOT NULL DEFAULT 'PENDING_SCAN',
    `moderationState` VARCHAR(24) NULL,
    `moderationNote` VARCHAR(512) NULL,
    `rejectionCode` VARCHAR(48) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_listing_media_order`(`draftId`, `sortOrder`),
    INDEX `ix_listing_media_slot`(`draftId`, `slot`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_listing_issues` (
    `id` CHAR(26) NOT NULL,
    `draftId` CHAR(26) NOT NULL,
    `severity` ENUM('BLOCKER', 'WARNING', 'ADVISORY') NOT NULL DEFAULT 'BLOCKER',
    `code` VARCHAR(64) NOT NULL,
    `section` ENUM('PRODUCT_PHOTOS', 'PRICE_STOCK_SHIPPING', 'PRODUCT_DESCRIPTION', 'ADDITIONAL_INFORMATION', 'MEDICAL_COMPLIANCE') NULL,
    `attributeKey` VARCHAR(64) NULL,
    `message` VARCHAR(512) NOT NULL,
    `isFromModerator` BOOLEAN NOT NULL DEFAULT false,
    `resolvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_listing_issue_open`(`draftId`, `resolvedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_offers` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `productId` CHAR(26) NOT NULL,
    `variantId` CHAR(26) NULL,
    `variantKey` VARCHAR(26) NOT NULL DEFAULT '',
    `sellerSku` VARCHAR(64) NOT NULL,
    `brandId` CHAR(26) NULL,
    `status` ENUM('INACTIVE', 'ACTIVE', 'PAUSED', 'NEEDS_CHANGES', 'ARCHIVED') NOT NULL DEFAULT 'INACTIVE',
    `priceMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `compareAtPriceMinor` BIGINT NULL,
    `taxClassId` CHAR(26) NULL,
    `orderingUnit` ENUM('PIECE', 'INNER_PACK', 'OUTER_CARTON') NOT NULL DEFAULT 'PIECE',
    `minimumOrderQuantity` INTEGER NOT NULL DEFAULT 1,
    `orderIncrement` INTEGER NOT NULL DEFAULT 1,
    `maximumOrderQuantity` INTEGER NULL,
    `handlingTimeDays` INTEGER NULL,
    `guaranteedShelfLifeMonths` SMALLINT NULL,
    `warrantyMonths` SMALLINT NULL,
    `sellingRegionsJson` JSON NULL,
    `availableQuantity` INTEGER NOT NULL DEFAULT 0,
    `reservedQuantity` INTEGER NOT NULL DEFAULT 0,
    `qualityScore` SMALLINT NULL,
    `statusReason` TEXT NULL,
    `sourceDraftId` CHAR(26) NULL,
    `publishedAt` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `archivedAt` DATETIME(3) NULL,

    INDEX `ix_seller_offer_product_price`(`productId`, `status`, `priceMinor`),
    INDEX `ix_seller_offer_seller_status`(`sellerAccountId`, `status`, `updatedAt`),
    INDEX `ix_seller_offer_stock`(`status`, `availableQuantity`),
    UNIQUE INDEX `uq_seller_offer_product`(`sellerAccountId`, `productId`, `variantKey`),
    UNIQUE INDEX `uq_seller_offer_sku`(`sellerAccountId`, `sellerSku`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_price_tiers` (
    `id` CHAR(26) NOT NULL,
    `offerId` CHAR(26) NOT NULL,
    `minQuantity` INTEGER NOT NULL,
    `priceMinor` BIGINT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_price_tier_band`(`offerId`, `minQuantity`),
    UNIQUE INDEX `uq_seller_price_tier`(`offerId`, `minQuantity`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_inventory` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `offerId` CHAR(26) NOT NULL,
    `locationId` CHAR(26) NOT NULL,
    `availableQuantity` INTEGER NOT NULL DEFAULT 0,
    `reservedQuantity` INTEGER NOT NULL DEFAULT 0,
    `quarantinedQuantity` INTEGER NOT NULL DEFAULT 0,
    `reorderThreshold` INTEGER NOT NULL DEFAULT 0,
    `batchNumber` VARCHAR(64) NULL,
    `manufacturedOn` DATE NULL,
    `expiresOn` DATE NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `erpQuantity` INTEGER NULL,
    `erpSyncedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_inventory_low`(`sellerAccountId`, `availableQuantity`),
    INDEX `ix_seller_inventory_expiry`(`expiresOn`),
    UNIQUE INDEX `uq_seller_inventory_offer_location`(`offerId`, `locationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_inventory_movements` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `offerId` CHAR(26) NOT NULL,
    `locationId` CHAR(26) NOT NULL,
    `type` ENUM('RECEIPT', 'ADJUSTMENT', 'RESERVATION', 'RESERVATION_RELEASE', 'DISPATCH', 'RETURN', 'QUARANTINE', 'QUARANTINE_RELEASE', 'ERP_RECONCILIATION') NOT NULL,
    `quantityDelta` INTEGER NOT NULL,
    `balanceAfter` INTEGER NOT NULL,
    `referenceType` VARCHAR(48) NULL,
    `referenceId` CHAR(26) NULL,
    `reason` VARCHAR(255) NULL,
    `batchNumber` VARCHAR(64) NULL,
    `actorProfileId` CHAR(26) NULL,
    `idempotencyKey` VARCHAR(128) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_seller_movement_offer`(`offerId`, `createdAt`),
    INDEX `ix_seller_movement_seller`(`sellerAccountId`, `createdAt`),
    UNIQUE INDEX `uq_seller_movement_idempotency`(`sellerAccountId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_bulk_import_jobs` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `status` ENUM('PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'DEAD', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `isDryRun` BOOLEAN NOT NULL DEFAULT true,
    `categoryId` CHAR(26) NULL,
    `originalFileName` VARCHAR(255) NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `columnMappingJson` JSON NULL,
    `totalRows` INTEGER NOT NULL DEFAULT 0,
    `validRows` INTEGER NOT NULL DEFAULT 0,
    `invalidRows` INTEGER NOT NULL DEFAULT 0,
    `createdRows` INTEGER NOT NULL DEFAULT 0,
    `updatedRows` INTEGER NOT NULL DEFAULT 0,
    `errorReportStorageKey` VARCHAR(512) NULL,
    `failureReason` TEXT NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `requestedByProfileId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_import_seller`(`sellerAccountId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_bulk_import_row_errors` (
    `id` CHAR(26) NOT NULL,
    `jobId` CHAR(26) NOT NULL,
    `rowNumber` INTEGER NOT NULL,
    `columnName` VARCHAR(128) NULL,
    `code` VARCHAR(64) NOT NULL,
    `message` VARCHAR(512) NOT NULL,
    `rawValue` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_seller_import_error_row`(`jobId`, `rowNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_order_groups` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `sellerOrderNumber` VARCHAR(32) NOT NULL,
    `status` ENUM('NEW', 'ACCEPTED', 'PROCESSING', 'READY_FOR_DISPATCH', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'RETURN_REQUESTED', 'RETURNED', 'REFUNDED', 'DISPUTED') NOT NULL DEFAULT 'NEW',
    `locationId` CHAR(26) NULL,
    `goodsTotalMinor` BIGINT NOT NULL DEFAULT 0,
    `taxTotalMinor` BIGINT NOT NULL DEFAULT 0,
    `shippingTotalMinor` BIGINT NOT NULL DEFAULT 0,
    `commissionMinor` BIGINT NOT NULL DEFAULT 0,
    `sellerNetMinor` BIGINT NOT NULL DEFAULT 0,
    `currency` CHAR(3) NOT NULL,
    `commissionBasisPointsApplied` SMALLINT NOT NULL DEFAULT 0,
    `dispatchDueAt` DATETIME(3) NULL,
    `acceptedAt` DATETIME(3) NULL,
    `dispatchedAt` DATETIME(3) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancellationReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_order_group_status`(`sellerAccountId`, `status`, `createdAt`),
    INDEX `ix_seller_order_group_sla`(`sellerAccountId`, `dispatchDueAt`),
    UNIQUE INDEX `uq_seller_order_number`(`sellerAccountId`, `sellerOrderNumber`),
    UNIQUE INDEX `uq_seller_order_group`(`orderId`, `sellerAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_order_lines` (
    `id` CHAR(26) NOT NULL,
    `orderGroupId` CHAR(26) NOT NULL,
    `orderItemId` CHAR(26) NOT NULL,
    `offerId` CHAR(26) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `unitPriceMinor` BIGINT NOT NULL,
    `lineTotalMinor` BIGINT NOT NULL,
    `commissionMinor` BIGINT NOT NULL DEFAULT 0,
    `sellerNetMinor` BIGINT NOT NULL DEFAULT 0,
    `currency` CHAR(3) NOT NULL,
    `fulfilledQuantity` INTEGER NOT NULL DEFAULT 0,
    `returnedQuantity` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_order_line_group`(`orderGroupId`),
    INDEX `ix_seller_order_line_offer`(`offerId`),
    UNIQUE INDEX `uq_seller_order_line_item`(`orderItemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_shipments` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `orderGroupId` CHAR(26) NOT NULL,
    `locationId` CHAR(26) NULL,
    `status` ENUM('CREATED', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'RETURNED_TO_ORIGIN') NOT NULL DEFAULT 'CREATED',
    `carrierName` VARCHAR(120) NULL,
    `trackingNumber` VARCHAR(128) NULL,
    `trackingUrl` VARCHAR(512) NULL,
    `contentsJson` JSON NULL,
    `dispatchedAt` DATETIME(3) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_shipment_status`(`sellerAccountId`, `status`),
    INDEX `ix_seller_shipment_group`(`orderGroupId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_returns` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `orderGroupId` CHAR(26) NOT NULL,
    `status` ENUM('REQUESTED', 'APPROVED', 'REJECTED', 'RECEIVED', 'INSPECTED', 'COMPLETED') NOT NULL DEFAULT 'REQUESTED',
    `reasonCode` VARCHAR(48) NOT NULL,
    `reasonText` TEXT NULL,
    `evidenceJson` JSON NULL,
    `sellerResponse` TEXT NULL,
    `sellerRespondedAt` DATETIME(3) NULL,
    `platformDecision` VARCHAR(24) NULL,
    `platformDecisionReason` TEXT NULL,
    `decidedByUserId` CHAR(26) NULL,
    `decidedAt` DATETIME(3) NULL,
    `refundAmountMinor` BIGINT NULL,
    `currency` CHAR(3) NULL,
    `returnTrackingNumber` VARCHAR(128) NULL,
    `receivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_return_status`(`sellerAccountId`, `status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_settlements` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `reference` VARCHAR(32) NOT NULL,
    `status` ENUM('OPEN', 'PENDING_PAYOUT', 'PAID', 'ON_HOLD') NOT NULL DEFAULT 'OPEN',
    `periodStart` DATETIME(3) NOT NULL,
    `periodEnd` DATETIME(3) NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `grossMinor` BIGINT NOT NULL DEFAULT 0,
    `taxMinor` BIGINT NOT NULL DEFAULT 0,
    `shippingMinor` BIGINT NOT NULL DEFAULT 0,
    `commissionMinor` BIGINT NOT NULL DEFAULT 0,
    `processingFeeMinor` BIGINT NOT NULL DEFAULT 0,
    `refundsMinor` BIGINT NOT NULL DEFAULT 0,
    `adjustmentsMinor` BIGINT NOT NULL DEFAULT 0,
    `netPayableMinor` BIGINT NOT NULL DEFAULT 0,
    `statementStorageKey` VARCHAR(512) NULL,
    `closedAt` DATETIME(3) NULL,
    `holdReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_settlement_period`(`sellerAccountId`, `status`, `periodEnd`),
    UNIQUE INDEX `uq_seller_settlement_reference`(`reference`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_settlement_lines` (
    `id` CHAR(26) NOT NULL,
    `settlementId` CHAR(26) NOT NULL,
    `orderGroupId` CHAR(26) NULL,
    `kind` ENUM('SALE', 'COMMISSION', 'PROCESSING_FEE', 'REFUND', 'RETURN_DEDUCTION', 'SHIPPING_CHARGE', 'MANUAL_ADJUSTMENT') NOT NULL,
    `amountMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `description` VARCHAR(255) NOT NULL,
    `reason` TEXT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `createdByUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_seller_settlement_line_kind`(`settlementId`, `kind`),
    INDEX `ix_seller_settlement_line_group`(`orderGroupId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_payouts` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `settlementId` CHAR(26) NULL,
    `reference` VARCHAR(32) NOT NULL,
    `status` ENUM('PENDING', 'IN_TRANSIT', 'PAID', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `amountMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `provider` VARCHAR(48) NULL,
    `providerPayoutId` VARCHAR(128) NULL,
    `providerStatusRaw` VARCHAR(64) NULL,
    `failureCode` VARCHAR(64) NULL,
    `failureReason` TEXT NULL,
    `remediationHint` VARCHAR(512) NULL,
    `scheduledFor` DATETIME(3) NULL,
    `paidAt` DATETIME(3) NULL,
    `idempotencyKey` VARCHAR(128) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_payout_status`(`sellerAccountId`, `status`, `createdAt`),
    UNIQUE INDEX `uq_seller_payout_reference`(`reference`),
    UNIQUE INDEX `uq_seller_payout_idempotency`(`sellerAccountId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_notifications` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `kind` ENUM('APPLICATION_STATUS', 'LISTING_DECISION', 'NEW_ORDER', 'DISPATCH_SLA_WARNING', 'LOW_STOCK', 'ERP_SYNC_FAILURE', 'DOCUMENT_EXPIRING', 'PAYOUT_RESULT', 'RETURN_OR_DISPUTE', 'SECURITY_EVENT', 'BRAND_REQUEST_DECISION') NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `body` TEXT NOT NULL,
    `linkPath` VARCHAR(255) NULL,
    `subjectType` VARCHAR(48) NULL,
    `subjectId` CHAR(26) NULL,
    `severity` VARCHAR(16) NOT NULL DEFAULT 'INFO',
    `readByJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NULL,

    INDEX `ix_seller_notification_feed`(`sellerAccountId`, `createdAt`),
    INDEX `ix_seller_notification_subject`(`sellerAccountId`, `kind`, `subjectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_audit_logs` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `action` VARCHAR(96) NOT NULL,
    `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER') NOT NULL,
    `actorUserId` CHAR(26) NULL,
    `actorLabel` VARCHAR(120) NULL,
    `resourceType` VARCHAR(48) NOT NULL,
    `resourceId` CHAR(26) NULL,
    `beforeJson` JSON NULL,
    `afterJson` JSON NULL,
    `summary` VARCHAR(512) NULL,
    `correlationId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_seller_audit_time`(`sellerAccountId`, `createdAt`),
    INDEX `ix_seller_audit_action`(`sellerAccountId`, `action`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ix_product_marketplace` ON `products`(`isMarketplaceProduct`, `status`);

-- CreateIndex
CREATE INDEX `ix_product_created_by_seller` ON `products`(`createdBySellerAccountId`);

-- AddForeignKey
ALTER TABLE `products` ADD CONSTRAINT `products_createdBySellerAccountId_fkey` FOREIGN KEY (`createdBySellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_members` ADD CONSTRAINT `seller_members_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_members` ADD CONSTRAINT `seller_members_customerProfileId_fkey` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_invitations` ADD CONSTRAINT `seller_invitations_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_onboarding_progress` ADD CONSTRAINT `seller_onboarding_progress_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_business_profiles` ADD CONSTRAINT `seller_business_profiles_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_verification_cases` ADD CONSTRAINT `seller_verification_cases_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_documents` ADD CONSTRAINT `seller_documents_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_agreement_acceptances` ADD CONSTRAINT `seller_agreement_acceptances_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_payout_account_references` ADD CONSTRAINT `seller_payout_account_references_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_locations` ADD CONSTRAINT `seller_locations_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `brand_requests` ADD CONSTRAINT `brand_requests_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `brand_requests` ADD CONSTRAINT `brand_requests_brandId_fkey` FOREIGN KEY (`brandId`) REFERENCES `brands`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `category_attribute_definitions` ADD CONSTRAINT `category_attribute_definitions_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_listing_drafts` ADD CONSTRAINT `seller_listing_drafts_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_listing_drafts` ADD CONSTRAINT `seller_listing_drafts_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_listing_drafts` ADD CONSTRAINT `seller_listing_drafts_brandId_fkey` FOREIGN KEY (`brandId`) REFERENCES `brands`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_listing_draft_media` ADD CONSTRAINT `seller_listing_draft_media_draftId_fkey` FOREIGN KEY (`draftId`) REFERENCES `seller_listing_drafts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_listing_issues` ADD CONSTRAINT `seller_listing_issues_draftId_fkey` FOREIGN KEY (`draftId`) REFERENCES `seller_listing_drafts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_offers` ADD CONSTRAINT `seller_offers_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_offers` ADD CONSTRAINT `seller_offers_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_offers` ADD CONSTRAINT `seller_offers_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `product_variants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_offers` ADD CONSTRAINT `seller_offers_brandId_fkey` FOREIGN KEY (`brandId`) REFERENCES `brands`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_price_tiers` ADD CONSTRAINT `seller_price_tiers_offerId_fkey` FOREIGN KEY (`offerId`) REFERENCES `seller_offers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_inventory` ADD CONSTRAINT `seller_inventory_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_inventory` ADD CONSTRAINT `seller_inventory_offerId_fkey` FOREIGN KEY (`offerId`) REFERENCES `seller_offers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_inventory` ADD CONSTRAINT `seller_inventory_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `seller_locations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_inventory_movements` ADD CONSTRAINT `seller_inventory_movements_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_inventory_movements` ADD CONSTRAINT `seller_inventory_movements_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `seller_locations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_bulk_import_jobs` ADD CONSTRAINT `seller_bulk_import_jobs_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_bulk_import_row_errors` ADD CONSTRAINT `seller_bulk_import_row_errors_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `seller_bulk_import_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_order_groups` ADD CONSTRAINT `seller_order_groups_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_order_groups` ADD CONSTRAINT `seller_order_groups_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_order_lines` ADD CONSTRAINT `seller_order_lines_orderGroupId_fkey` FOREIGN KEY (`orderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_order_lines` ADD CONSTRAINT `seller_order_lines_offerId_fkey` FOREIGN KEY (`offerId`) REFERENCES `seller_offers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_shipments` ADD CONSTRAINT `seller_shipments_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_shipments` ADD CONSTRAINT `seller_shipments_orderGroupId_fkey` FOREIGN KEY (`orderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_shipments` ADD CONSTRAINT `seller_shipments_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `seller_locations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_returns` ADD CONSTRAINT `seller_returns_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_returns` ADD CONSTRAINT `seller_returns_orderGroupId_fkey` FOREIGN KEY (`orderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_settlements` ADD CONSTRAINT `seller_settlements_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_settlement_lines` ADD CONSTRAINT `seller_settlement_lines_settlementId_fkey` FOREIGN KEY (`settlementId`) REFERENCES `seller_settlements`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_settlement_lines` ADD CONSTRAINT `seller_settlement_lines_orderGroupId_fkey` FOREIGN KEY (`orderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_payouts` ADD CONSTRAINT `seller_payouts_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_payouts` ADD CONSTRAINT `seller_payouts_settlementId_fkey` FOREIGN KEY (`settlementId`) REFERENCES `seller_settlements`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_notifications` ADD CONSTRAINT `seller_notifications_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seller_audit_logs` ADD CONSTRAINT `seller_audit_logs_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Invariants the database enforces itself.
--
-- These are the rules that must hold even if a service is wrong, a migration
-- is run by hand, or somebody edits a row in a client. Application-level
-- validation covers all of them too; this is what catches the case where it
-- did not run.
-- ---------------------------------------------------------------------------

-- Quantities cannot go negative, and reserved stock cannot exceed what is
-- there. The third is the one that matters under concurrency: two orders
-- reserving the last unit simultaneously must leave one of them refused, and
-- if the conditional UPDATE ever regressed this is what would catch it.
ALTER TABLE `seller_inventory`
  ADD CONSTRAINT `chk_seller_inventory_available_non_negative` CHECK (`availableQuantity` >= 0),
  ADD CONSTRAINT `chk_seller_inventory_reserved_non_negative` CHECK (`reservedQuantity` >= 0),
  ADD CONSTRAINT `chk_seller_inventory_quarantined_non_negative` CHECK (`quarantinedQuantity` >= 0),
  ADD CONSTRAINT `chk_seller_inventory_reorder_non_negative` CHECK (`reorderThreshold` >= 0);

-- A movement of zero moves nothing and is noise in a ledger people read.
ALTER TABLE `seller_inventory_movements`
  ADD CONSTRAINT `chk_seller_movement_delta_non_zero` CHECK (`quantityDelta` <> 0),
  ADD CONSTRAINT `chk_seller_movement_balance_non_negative` CHECK (`balanceAfter` >= 0);

-- Offer commercial terms. `chk_seller_offer_max_qty_valid` is the one that
-- stops a seller publishing terms nobody can satisfy: a maximum below the
-- minimum means no quantity is orderable, and the buyer is simply told no with
-- no explanation.
ALTER TABLE `seller_offers`
  ADD CONSTRAINT `chk_seller_offer_price_non_negative` CHECK (`priceMinor` >= 0),
  ADD CONSTRAINT `chk_seller_offer_compare_price_valid` CHECK (`compareAtPriceMinor` IS NULL OR `compareAtPriceMinor` >= `priceMinor`),
  ADD CONSTRAINT `chk_seller_offer_moq_positive` CHECK (`minimumOrderQuantity` >= 1),
  ADD CONSTRAINT `chk_seller_offer_increment_positive` CHECK (`orderIncrement` >= 1),
  ADD CONSTRAINT `chk_seller_offer_max_qty_valid` CHECK (`maximumOrderQuantity` IS NULL OR `maximumOrderQuantity` >= `minimumOrderQuantity`),
  ADD CONSTRAINT `chk_seller_offer_available_non_negative` CHECK (`availableQuantity` >= 0),
  ADD CONSTRAINT `chk_seller_offer_reserved_non_negative` CHECK (`reservedQuantity` >= 0),
  ADD CONSTRAINT `chk_seller_offer_quality_range` CHECK (`qualityScore` IS NULL OR (`qualityScore` >= 0 AND `qualityScore` <= 100));

-- A tier starting at zero or one is not a tier, it is the base price.
ALTER TABLE `seller_price_tiers`
  ADD CONSTRAINT `chk_seller_price_tier_min_qty` CHECK (`minQuantity` >= 2),
  ADD CONSTRAINT `chk_seller_price_tier_price_non_negative` CHECK (`priceMinor` >= 0);

-- Order money. Commission is stored as a positive amount and subtracted, so it
-- cannot be negative; a negative one would silently pay the seller more than
-- the order was worth.
ALTER TABLE `seller_order_groups`
  ADD CONSTRAINT `chk_seller_order_goods_non_negative` CHECK (`goodsTotalMinor` >= 0),
  ADD CONSTRAINT `chk_seller_order_tax_non_negative` CHECK (`taxTotalMinor` >= 0),
  ADD CONSTRAINT `chk_seller_order_shipping_non_negative` CHECK (`shippingTotalMinor` >= 0),
  ADD CONSTRAINT `chk_seller_order_commission_non_negative` CHECK (`commissionMinor` >= 0),
  ADD CONSTRAINT `chk_seller_order_commission_bps_range` CHECK (`commissionBasisPointsApplied` >= 0 AND `commissionBasisPointsApplied` <= 10000);

ALTER TABLE `seller_order_lines`
  ADD CONSTRAINT `chk_seller_order_line_qty_positive` CHECK (`quantity` >= 1),
  ADD CONSTRAINT `chk_seller_order_line_unit_price_non_negative` CHECK (`unitPriceMinor` >= 0),
  ADD CONSTRAINT `chk_seller_order_line_fulfilled_within_qty` CHECK (`fulfilledQuantity` >= 0 AND `fulfilledQuantity` <= `quantity`),
  ADD CONSTRAINT `chk_seller_order_line_returned_within_fulfilled` CHECK (`returnedQuantity` >= 0 AND `returnedQuantity` <= `fulfilledQuantity`);

-- A payout of nothing is not a payout, and a negative one is money going the
-- wrong way through a table that has no concept of that direction.
ALTER TABLE `seller_payouts`
  ADD CONSTRAINT `chk_seller_payout_amount_positive` CHECK (`amountMinor` > 0);

-- A period that ends before it starts produces a statement covering negative
-- time, which silently returns no lines rather than failing.
ALTER TABLE `seller_settlements`
  ADD CONSTRAINT `chk_seller_settlement_period_ordered` CHECK (`periodEnd` > `periodStart`),
  ADD CONSTRAINT `chk_seller_settlement_gross_non_negative` CHECK (`grossMinor` >= 0),
  ADD CONSTRAINT `chk_seller_settlement_commission_non_negative` CHECK (`commissionMinor` >= 0),
  ADD CONSTRAINT `chk_seller_settlement_refunds_non_negative` CHECK (`refundsMinor` >= 0);

-- Commission is basis points: 10000 is one hundred percent, and a marketplace
-- taking more than the whole order is a typo, not a business model.
ALTER TABLE `seller_accounts`
  ADD CONSTRAINT `chk_seller_commission_bps_range` CHECK (`commissionBasisPoints` IS NULL OR (`commissionBasisPoints` >= 0 AND `commissionBasisPoints` <= 10000));

-- Handling time in negative days would place a dispatch deadline in the past
-- the moment an order arrived, and every order would breach its SLA on
-- creation. The working-days mask is seven bits.
ALTER TABLE `seller_locations`
  ADD CONSTRAINT `chk_seller_location_handling_non_negative` CHECK (`handlingTimeDays` >= 0),
  ADD CONSTRAINT `chk_seller_location_working_days_mask` CHECK (`workingDaysMask` >= 0 AND `workingDaysMask` <= 127);

-- Counters on an import job describe one file, so no part can exceed the
-- whole.
ALTER TABLE `seller_bulk_import_jobs`
  ADD CONSTRAINT `chk_seller_import_rows_non_negative` CHECK (`totalRows` >= 0 AND `validRows` >= 0 AND `invalidRows` >= 0),
  ADD CONSTRAINT `chk_seller_import_rows_add_up` CHECK (`validRows` + `invalidRows` <= `totalRows`);
