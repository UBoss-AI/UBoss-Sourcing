-- How a seller's own goods get delivered: the four fulfilment modes, the
-- seller's own carrier accounts, the rules that route a parcel, and the
-- records that stop a seller being billed twice for one consignment.
--
-- PURELY ADDITIVE. Eleven new tables, fourteen new columns on four existing
-- tables, and four enums that gain members at the END of their lists. No
-- existing column changes meaning, no existing row is rewritten, and there is
-- no backfill. A deployment that upgrades and configures none of this keeps
-- dispatching exactly as it does today.
--
-- WHY EVERY ENUM CHANGE APPENDS
--
-- MariaDB stores an ENUM as the ORDINAL of its member, not as its text. A
-- MODIFY that rearranges the list rebuilds the table and every stored ordinal
-- then points at a different word - a seller-to-carrier arrangement that said
-- APPROVED comes back saying something else, silently, with no error anywhere
-- and no way to tell afterwards which rows were affected. So new members go on
-- the end, always, and the lifecycle order lives in the schema's comments and
-- in `domain/seller-logistics.ts` instead.
--
-- THE CHECK CONSTRAINTS ARE THE POINT OF SEVERAL OF THESE TABLES
--
-- `seller_fulfilment_methods` carries two nullable target columns and exactly
-- one of them is set on any row. `seller_fulfilment_rules` carries four match
-- columns and which are populated depends on the scope. Neither can be
-- expressed with a foreign key, both are the kind of invariant a service
-- forgets during a refactor, and both decide where a parcel goes. So they are
-- CHECK constraints, like `chk_schedule_frequency_field_present` already is.
--
-- MariaDB 10.4 enforces CHECK (10.2+), so these are real on every supported
-- version. Prisma does not model them; they live here, and a migration that
-- adds a member to `SellerFulfilmentMode` or `SellerFulfilmentRuleScope` must
-- amend them or every insert for the new member will fail.
--
-- ROLLBACK
--
-- Drop the eleven tables in the reverse of the order they are created, drop
-- the added columns and their foreign keys, then restore the four enum
-- definitions to their previous member lists. Nothing is destroyed by doing
-- so: every added column is nullable or defaulted and no existing data moved.

-- ---------------------------------------------------------------------------
-- 1. India Post joins the provider list.
--
--    Appended. An existing `carrier_integrations` row keeps its ordinal and
--    its meaning.
-- ---------------------------------------------------------------------------
ALTER TABLE `carrier_integrations`
    MODIFY `provider` ENUM('MANUAL', 'CUSTOM', 'DHL', 'FEDEX', 'UPS', 'INDIA_POST') NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. The service capabilities a seller's own operation declares.
--
--    Eight appended. SAME_DAY and NEXT_DAY were already members and are not
--    repeated.
-- ---------------------------------------------------------------------------
ALTER TABLE `logistics_capabilities`
    MODIFY `kind` ENUM(
        'TEMPERATURE_CONTROLLED', 'COLD_CHAIN_2_8', 'FROZEN', 'STERILE_HANDLING',
        'DANGEROUS_GOODS', 'FRAGILE_HANDLING', 'OVERSIZED', 'PALLET', 'TAIL_LIFT',
        'WHITE_GLOVE', 'SAME_DAY', 'NEXT_DAY', 'INTERNATIONAL', 'CUSTOMS_BROKERAGE',
        'PROOF_OF_DELIVERY_PHOTO', 'PROOF_OF_DELIVERY_OTP',
        'STANDARD_DELIVERY', 'EXPRESS_DELIVERY', 'SCHEDULED_DELIVERY',
        'BUSINESS_HOURS_DELIVERY', 'SIGNATURE_REQUIRED', 'CASH_ON_DELIVERY',
        'INSURANCE', 'REVERSE_PICKUP'
    ) NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. A seller-to-carrier arrangement gains the states a seller-introduced
--    company passes through, plus the contract reference and the invitation
--    that produced it.
-- ---------------------------------------------------------------------------
ALTER TABLE `seller_logistics_partners`
    MODIFY `relationshipType` ENUM(
        'DIRECT_CONTRACT', 'MARKETPLACE_BROKERED', 'PREFERRED',
        'SELLER_SELF_MANAGED', 'SELLER_DEDICATED'
    ) NOT NULL DEFAULT 'MARKETPLACE_BROKERED',
    MODIFY `status` ENUM(
        'REQUESTED', 'APPROVED', 'REJECTED', 'SUSPENDED', 'ENDED',
        'DRAFT', 'INVITED', 'PARTNER_ACCEPTANCE_PENDING', 'CHANGES_REQUESTED'
    ) NOT NULL DEFAULT 'REQUESTED',
    ADD COLUMN `contractReference` VARCHAR(64) NULL,
    ADD COLUMN `invitationId` CHAR(26) NULL;

-- ---------------------------------------------------------------------------
-- 4. A logistics company gains a kind and, sometimes, an owner.
--
--    Every existing row becomes MARKETPLACE_CARRIER, which is what those rows
--    have always been: created by the operator, requestable by any seller. The
--    default does that without an UPDATE.
--
--    `ownerSellerAccountId` is ON DELETE SET NULL rather than CASCADE on
--    purpose. A seller account being removed must not take a logistics
--    company - and its drivers, its consignments and its proof of delivery -
--    with it. The company is left ownerless for a person to deal with.
-- ---------------------------------------------------------------------------
ALTER TABLE `logistics_partners`
    ADD COLUMN `partnerKind` ENUM('MARKETPLACE_CARRIER', 'SELLER_SELF_MANAGED', 'SELLER_DEDICATED') NOT NULL DEFAULT 'MARKETPLACE_CARRIER',
    ADD COLUMN `ownerSellerAccountId` CHAR(26) NULL;

CREATE INDEX `ix_logistics_partner_owner` ON `logistics_partners`(`ownerSellerAccountId`, `partnerKind`);

ALTER TABLE `logistics_partners`
    ADD CONSTRAINT `logistics_partners_ownerSellerAccountId_fkey`
    FOREIGN KEY (`ownerSellerAccountId`) REFERENCES `seller_accounts`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. A service region gains what a seller needs to describe one.
--
--    All nullable or defaulted. `isExclusion` defaults to false, so every
--    existing region keeps granting coverage exactly as it did.
-- ---------------------------------------------------------------------------
ALTER TABLE `logistics_service_regions`
    ADD COLUMN `isExclusion` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `deliveryDaysMask` INTEGER NOT NULL DEFAULT 31,
    ADD COLUMN `transitDaysMin` INTEGER NULL,
    ADD COLUMN `transitDaysMax` INTEGER NULL,
    ADD COLUMN `remoteAreaSurchargeMinor` BIGINT NULL,
    ADD COLUMN `maxShipmentWeightGrams` INTEGER NULL,
    ADD COLUMN `maxPackageLengthMm` INTEGER NULL,
    ADD COLUMN `maxPackageWidthMm` INTEGER NULL,
    ADD COLUMN `maxPackageHeightMm` INTEGER NULL;

-- ---------------------------------------------------------------------------
-- 6. THE SELLER'S OWN CARRIER ACCOUNTS.
--
--    Not `carrier_integrations`. That table is the OPERATOR's, with the
--    operator's credentials, shared by every shipment the operator
--    dispatches. This is the seller's, and the split is the whole point: a
--    seller's DHL key must not sit in a row another seller's consignment can
--    reach.
-- ---------------------------------------------------------------------------
CREATE TABLE `seller_carrier_connections` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `provider` ENUM('MANUAL', 'CUSTOM', 'DHL', 'FEDEX', 'UPS', 'INDIA_POST') NOT NULL,
    `environment` ENUM('SANDBOX', 'PRODUCTION') NOT NULL DEFAULT 'SANDBOX',
    `state` ENUM('NOT_CONFIGURED', 'CREDENTIALS_SET', 'TEST_PASSED', 'ACTIVE', 'PAUSED', 'ERROR', 'DISCONNECTED') NOT NULL DEFAULT 'NOT_CONFIGURED',
    `trackingMode` ENUM('AUTOMATIC_API', 'MANUAL_ENTRY', 'EXTERNAL_LINK') NOT NULL DEFAULT 'AUTOMATIC_API',
    `accountNumber` VARCHAR(64) NULL,
    `billingAccountNumber` VARCHAR(64) NULL,
    `shipperDetailsJson` JSON NULL,
    `defaultServiceCode` VARCHAR(48) NULL,
    `labelFormat` VARCHAR(24) NULL,
    `packagingPreference` VARCHAR(48) NULL,
    `pickupPreference` VARCHAR(48) NULL,
    `customsDefaultsJson` JSON NULL,
    `consecutiveFailures` INTEGER NOT NULL DEFAULT 0,
    `lastSuccessAt` DATETIME(3) NULL,
    `lastFailureAt` DATETIME(3) NULL,
    `lastFailureMessage` VARCHAR(512) NULL,
    `lastTestAt` DATETIME(3) NULL,
    `lastTestPassedAt` DATETIME(3) NULL,
    `lastTestMessage` VARCHAR(512) NULL,
    `productionConfirmedAt` DATETIME(3) NULL,
    `productionConfirmedBySellerMemberId` CHAR(26) NULL,
    `createdBySellerMemberId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `disconnectedAt` DATETIME(3) NULL,

    INDEX `ix_seller_carrier_connection_state`(`sellerAccountId`, `state`),
    INDEX `ix_seller_carrier_connection_provider`(`provider`, `state`),
    UNIQUE INDEX `uq_seller_carrier_connection`(`sellerAccountId`, `provider`, `environment`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The secret, in a table of its own so that reaching it has to be deliberate.
-- A `SELECT *` on the connection above returns no credential, because there is
-- none in it to return.
CREATE TABLE `seller_carrier_credentials` (
    `id` CHAR(26) NOT NULL,
    `sellerCarrierConnectionId` CHAR(26) NOT NULL,
    `credentialsEnc` TEXT NOT NULL,
    `webhookSecretEnc` TEXT NULL,
    `maskedHint` VARCHAR(32) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `rotatedAt` DATETIME(3) NULL,
    `createdBySellerMemberId` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_seller_carrier_credential_connection`(`sellerCarrierConnectionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 7. HOW THIS SELLER SHIPS.
--
--    One row per way. `methodKey` is the NOT NULL surrogate that makes "one
--    method per target" expressible at all: two of the three target columns
--    are NULL on any row, and a composite UNIQUE over them would enforce
--    nothing, every NULL being distinct.
--
--    `primaryForSellerAccountId` and `fallbackForSellerAccountId` use the same
--    NULL-is-distinct property the other way up, exactly as
--    `logistics_driver_assignments.activeShipmentId` does: each holds the
--    seller's own id while this row plays that part and NULL when it does not,
--    so a second primary collides instead of being discovered later by a
--    picker that returns two answers.
-- ---------------------------------------------------------------------------
CREATE TABLE `seller_fulfilment_methods` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `mode` ENUM('INTEGRATED_CARRIER', 'SELF_MANAGED', 'DEDICATED_PARTNER', 'OPERATOR_FULFILLED') NOT NULL,
    `status` ENUM('DRAFT', 'PENDING_SETUP', 'PENDING_APPROVAL', 'APPROVED', 'CHANGES_REQUESTED', 'REJECTED', 'PAUSED', 'DISCONNECTED') NOT NULL DEFAULT 'DRAFT',
    `role` ENUM('PRIMARY', 'FALLBACK', 'ADDITIONAL') NOT NULL DEFAULT 'ADDITIONAL',
    `sellerCarrierConnectionId` CHAR(26) NULL,
    `logisticsPartnerId` CHAR(26) NULL,
    `publicDisplayName` VARCHAR(160) NOT NULL,
    `primaryForSellerAccountId` CHAR(26) NULL,
    `fallbackForSellerAccountId` CHAR(26) NULL,
    `methodKey` VARCHAR(96) NOT NULL,
    `submittedAt` DATETIME(3) NULL,
    `decidedByUserId` CHAR(26) NULL,
    `decidedAt` DATETIME(3) NULL,
    `statusReason` VARCHAR(512) NULL,
    `allowsInternational` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `archivedAt` DATETIME(3) NULL,

    INDEX `ix_seller_fulfilment_method_status`(`sellerAccountId`, `status`),
    INDEX `ix_seller_fulfilment_method_queue`(`status`, `submittedAt`),
    INDEX `ix_seller_fulfilment_method_partner`(`logisticsPartnerId`),
    INDEX `ix_seller_fulfilment_method_connection`(`sellerCarrierConnectionId`),
    UNIQUE INDEX `uq_seller_fulfilment_method`(`sellerAccountId`, `methodKey`),
    UNIQUE INDEX `uq_seller_fulfilment_primary`(`primaryForSellerAccountId`),
    UNIQUE INDEX `uq_seller_fulfilment_fallback`(`fallbackForSellerAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 8. WHICH METHOD CARRIES WHICH PARCEL.
--
--    `precedence` is derived from `scope` and stored so the picker is one
--    indexed ORDER BY rather than a CASE two callers could disagree about -
--    and the CHECK below is what stops the two drifting.
-- ---------------------------------------------------------------------------
CREATE TABLE `seller_fulfilment_rules` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `fulfilmentMethodId` CHAR(26) NOT NULL,
    `scope` ENUM('PRODUCT', 'WAREHOUSE', 'DESTINATION', 'SELLER_DEFAULT') NOT NULL,
    `precedence` INTEGER NOT NULL,
    `sellerOfferId` CHAR(26) NULL,
    `sellerLocationId` CHAR(26) NULL,
    `destinationCountry` CHAR(2) NULL,
    `destinationPostalPrefix` VARCHAR(16) NULL,
    `ruleKey` VARCHAR(120) NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `effectiveFrom` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `effectiveTo` DATETIME(3) NULL,
    `note` VARCHAR(255) NULL,
    `createdBySellerMemberId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `archivedAt` DATETIME(3) NULL,

    INDEX `ix_seller_fulfilment_rule_pick`(`sellerAccountId`, `isActive`, `precedence`),
    INDEX `ix_seller_fulfilment_rule_method`(`fulfilmentMethodId`),
    UNIQUE INDEX `uq_seller_fulfilment_rule`(`sellerAccountId`, `ruleKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 9. How goods leave one building under one method.
--
--    Thin on purpose. The address, the timezone, the dispatch cutoff, the
--    working days and the handling time are facts about the BUILDING and live
--    on `seller_locations`; what is here is what genuinely differs per method.
-- ---------------------------------------------------------------------------
CREATE TABLE `seller_logistics_pickup_profiles` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `fulfilmentMethodId` CHAR(26) NOT NULL,
    `sellerLocationId` CHAR(26) NOT NULL,
    `pickupDaysMask` INTEGER NOT NULL DEFAULT 31,
    `windowStart` VARCHAR(5) NULL,
    `windowEnd` VARCHAR(5) NULL,
    `cutoffOverride` VARCHAR(5) NULL,
    `handlingTimeDaysOverride` INTEGER NULL,
    `maxDailyShipments` INTEGER NULL,
    `blackoutDatesJson` JSON NULL,
    `contactName` VARCHAR(160) NULL,
    `contactPhone` VARCHAR(32) NULL,
    `contactEmail` VARCHAR(320) NULL,
    `instructions` TEXT NULL,
    `eligibleCategoryIdsJson` JSON NULL,
    `maxPackageWeightGrams` INTEGER NULL,
    `maxPackageLengthMm` INTEGER NULL,
    `maxPackageWidthMm` INTEGER NULL,
    `maxPackageHeightMm` INTEGER NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_pickup_profile_method`(`fulfilmentMethodId`, `isActive`),
    INDEX `ix_seller_pickup_profile_location`(`sellerLocationId`),
    UNIQUE INDEX `uq_seller_pickup_profile`(`sellerAccountId`, `fulfilmentMethodId`, `sellerLocationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 10. What a seller's own delivery operation charges.
--
--     VERSIONED. A republish makes version 2; it does not overwrite version 1,
--     because quotes point at the version they were priced from and a customer
--     disputing a charge six weeks later has to be shown the card as it stood
--     on the day.
--
--     Every amount is BIGINT minor units. No float anywhere in a money path.
-- ---------------------------------------------------------------------------
CREATE TABLE `seller_logistics_rate_cards` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `fulfilmentMethodId` CHAR(26) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `currency` CHAR(3) NOT NULL,
    `minimumChargeMinor` BIGINT NULL,
    `maximumChargeMinor` BIGINT NULL,
    `freeShippingThresholdMinor` BIGINT NULL,
    `remoteAreaSurchargeMinor` BIGINT NULL,
    `insuranceFeeMinor` BIGINT NULL,
    `codFeeMinor` BIGINT NULL,
    `taxInclusive` BOOLEAN NOT NULL DEFAULT false,
    `taxCategoryCode` VARCHAR(32) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT false,
    `effectiveFrom` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `effectiveTo` DATETIME(3) NULL,
    `createdBySellerMemberId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_rate_card_live`(`fulfilmentMethodId`, `isActive`, `effectiveFrom`),
    INDEX `ix_seller_rate_card_seller`(`sellerAccountId`),
    UNIQUE INDEX `uq_seller_rate_card_version`(`fulfilmentMethodId`, `name`, `version`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `seller_logistics_rate_bands` (
    `id` CHAR(26) NOT NULL,
    `rateCardId` CHAR(26) NOT NULL,
    `basis` ENUM('FLAT', 'WEIGHT', 'DISTANCE', 'POSTAL_ZONE', 'PACKAGE_SIZE') NOT NULL,
    `serviceType` ENUM('STANDARD', 'EXPRESS', 'SAME_DAY', 'ECONOMY', 'FREIGHT', 'WHITE_GLOVE') NOT NULL DEFAULT 'STANDARD',
    `minValue` INTEGER NOT NULL DEFAULT 0,
    `maxValue` INTEGER NULL,
    `postalPrefix` VARCHAR(16) NOT NULL DEFAULT '',
    `amountMinor` BIGINT NOT NULL,
    `perUnitMinor` BIGINT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_rate_band_order`(`rateCardId`, `sortOrder`),
    UNIQUE INDEX `uq_seller_rate_band`(`rateCardId`, `basis`, `serviceType`, `postalPrefix`, `minValue`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 11. What a carrier said a consignment would cost, at one moment.
--
--     `selectedForShipmentId` is the NULL-is-distinct idiom once more: one
--     SELECTED quote per consignment, enforced by the database, because two
--     selected quotes is two different numbers on one invoice.
-- ---------------------------------------------------------------------------
CREATE TABLE `carrier_rate_quotes` (
    `id` CHAR(26) NOT NULL,
    `shipmentId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `fulfilmentMethodId` CHAR(26) NOT NULL,
    `sellerCarrierConnectionId` CHAR(26) NULL,
    `rateCardId` CHAR(26) NULL,
    `provider` ENUM('MANUAL', 'CUSTOM', 'DHL', 'FEDEX', 'UPS', 'INDIA_POST') NOT NULL,
    `serviceCode` VARCHAR(48) NOT NULL,
    `serviceName` VARCHAR(120) NULL,
    `currency` CHAR(3) NOT NULL,
    `baseChargeMinor` BIGINT NOT NULL,
    `surchargesMinor` BIGINT NOT NULL DEFAULT 0,
    `taxMinor` BIGINT NOT NULL DEFAULT 0,
    `insuranceMinor` BIGINT NOT NULL DEFAULT 0,
    `dutiesEstimateMinor` BIGINT NULL,
    `totalMinor` BIGINT NOT NULL,
    `sellerChargeMinor` BIGINT NULL,
    `customerChargeMinor` BIGINT NULL,
    `estimatedDeliveryAt` DATETIME(3) NULL,
    `estimatedTransitDays` INTEGER NULL,
    `expiresAt` DATETIME(3) NULL,
    `providerQuoteReference` VARCHAR(128) NULL,
    `state` ENUM('OFFERED', 'SELECTED', 'EXPIRED', 'SUPERSEDED') NOT NULL DEFAULT 'OFFERED',
    `selectedForShipmentId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_carrier_quote_shipment`(`shipmentId`, `state`),
    INDEX `ix_carrier_quote_seller`(`sellerAccountId`, `createdAt`),
    INDEX `ix_carrier_quote_expiry`(`state`, `expiresAt`),
    UNIQUE INDEX `uq_carrier_quote_selected`(`selectedForShipmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 12. One attempt to buy one consignment at one provider.
--
--     THE RECORD THAT STOPS A SELLER BEING BILLED TWICE. Creating a shipment
--     at a carrier is a chargeable act that a retry, a double click or a
--     redelivered job repeats unless something refuses. `idempotencyKey` is
--     UNIQUE, so the second attempt collides and the first attempt's answer is
--     returned instead of a second consignment being booked.
-- ---------------------------------------------------------------------------
CREATE TABLE `shipment_purchases` (
    `id` CHAR(26) NOT NULL,
    `shipmentId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `idempotencyKey` VARCHAR(120) NOT NULL,
    `provider` ENUM('MANUAL', 'CUSTOM', 'DHL', 'FEDEX', 'UPS', 'INDIA_POST') NOT NULL,
    `sellerCarrierConnectionId` CHAR(26) NULL,
    `quoteId` CHAR(26) NULL,
    `state` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    `providerShipmentId` VARCHAR(128) NULL,
    `providerTrackingNumber` VARCHAR(128) NULL,
    `failureMessage` VARCHAR(512) NULL,
    `purchasedShipmentId` CHAR(26) NULL,
    `createdBySellerMemberId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    INDEX `ix_shipment_purchase_shipment`(`shipmentId`, `createdAt`),
    INDEX `ix_shipment_purchase_seller`(`sellerAccountId`, `state`),
    UNIQUE INDEX `uq_shipment_purchase_idempotency`(`idempotencyKey`),
    UNIQUE INDEX `uq_shipment_purchase_succeeded`(`purchasedShipmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 13. Every status a seller-to-carrier arrangement has held.
--
--     Append-only, and separate from the audit log: that answers "what did
--     this person do", this answers "how did this relationship get here",
--     which is the question asked during a dispute.
-- ---------------------------------------------------------------------------
CREATE TABLE `seller_logistics_relationship_events` (
    `id` CHAR(26) NOT NULL,
    `sellerLogisticsPartnerId` CHAR(26) NOT NULL,
    `fromStatus` ENUM('REQUESTED', 'APPROVED', 'REJECTED', 'SUSPENDED', 'ENDED', 'DRAFT', 'INVITED', 'PARTNER_ACCEPTANCE_PENDING', 'CHANGES_REQUESTED') NULL,
    `toStatus` ENUM('REQUESTED', 'APPROVED', 'REJECTED', 'SUSPENDED', 'ENDED', 'DRAFT', 'INVITED', 'PARTNER_ACCEPTANCE_PENDING', 'CHANGES_REQUESTED') NOT NULL,
    `reason` VARCHAR(512) NULL,
    `actorUserId` CHAR(26) NULL,
    `actorSellerMemberId` CHAR(26) NULL,
    `actorPartnerUserId` CHAR(26) NULL,
    `actorLabel` VARCHAR(160) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_seller_logistics_event_history`(`sellerLogisticsPartnerId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 14. A seller asking a delivery company it works with to join.
--
--     THE SELLER DOES NOT CREATE THE PARTNER'S ACCOUNT. `tokenHash` is the
--     SHA-256 of a single-use token that is emailed and never stored, exactly
--     as `auth_tokens` does it - a database read must not yield something
--     redeemable. The invited company verifies its own address and chooses its
--     own password.
-- ---------------------------------------------------------------------------
CREATE TABLE `seller_logistics_partner_invitations` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `state` ENUM('SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'REVOKED') NOT NULL DEFAULT 'SENT',
    `proposedLegalName` VARCHAR(255) NOT NULL,
    `proposedDisplayName` VARCHAR(160) NOT NULL,
    `businessEmail` VARCHAR(320) NOT NULL,
    `businessPhone` VARCHAR(32) NULL,
    `registrationNumber` VARCHAR(64) NULL,
    `countryCode` CHAR(2) NOT NULL,
    `addressJson` JSON NULL,
    `primaryContactName` VARCHAR(160) NULL,
    `expectedServiceCountriesJson` JSON NULL,
    `requiredCapabilitiesJson` JSON NULL,
    `relationshipDescription` TEXT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `logisticsPartnerId` CHAR(26) NULL,
    `sellerLogisticsPartnerId` CHAR(26) NULL,
    `invitedBySellerMemberId` CHAR(26) NULL,
    `acceptedAt` DATETIME(3) NULL,
    `declinedReason` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_partner_invitation_seller`(`sellerAccountId`, `state`),
    INDEX `ix_seller_partner_invitation_expiry`(`state`, `expiresAt`),
    INDEX `ix_seller_partner_invitation_email`(`businessEmail`),
    UNIQUE INDEX `uq_seller_partner_invitation_token`(`tokenHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 15. A consignment records how it came to be going this way.
--
--     Written once, when the method is chosen, and never rewritten when the
--     seller later changes their default - which is the whole reason it is
--     stored rather than derived. All nullable: a consignment raised before
--     this feature existed has no method and keeps working untouched.
--
--     Every foreign key here is ON DELETE SET NULL. A seller retiring a rule,
--     a method or a carrier account must not be blocked by the consignments it
--     once routed, and `fulfilmentSelectionReason` survives all three in
--     words.
-- ---------------------------------------------------------------------------
ALTER TABLE `logistics_shipments`
    ADD COLUMN `sellerFulfilmentMethodId` CHAR(26) NULL,
    ADD COLUMN `sellerCarrierConnectionId` CHAR(26) NULL,
    ADD COLUMN `fulfilmentSelectionSource` ENUM('AUTOMATIC_RULE', 'SELLER_DEFAULT', 'FALLBACK', 'SELLER_CHOICE', 'OPERATOR_CHOICE', 'MANUAL_REVIEW') NULL,
    ADD COLUMN `fulfilmentSelectionRuleId` CHAR(26) NULL,
    ADD COLUMN `fulfilmentSelectionReason` VARCHAR(512) NULL;

-- ---------------------------------------------------------------------------
-- 16. Foreign keys, last, once every table they point at exists.
-- ---------------------------------------------------------------------------
ALTER TABLE `seller_carrier_connections` ADD CONSTRAINT `seller_carrier_connections_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_carrier_credentials` ADD CONSTRAINT `seller_carrier_credentials_sellerCarrierConnectionId_fkey` FOREIGN KEY (`sellerCarrierConnectionId`) REFERENCES `seller_carrier_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_fulfilment_methods` ADD CONSTRAINT `seller_fulfilment_methods_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `seller_fulfilment_methods` ADD CONSTRAINT `seller_fulfilment_methods_sellerCarrierConnectionId_fkey` FOREIGN KEY (`sellerCarrierConnectionId`) REFERENCES `seller_carrier_connections`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE `seller_fulfilment_methods` ADD CONSTRAINT `seller_fulfilment_methods_logisticsPartnerId_fkey` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE `seller_fulfilment_rules` ADD CONSTRAINT `seller_fulfilment_rules_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `seller_fulfilment_rules` ADD CONSTRAINT `seller_fulfilment_rules_fulfilmentMethodId_fkey` FOREIGN KEY (`fulfilmentMethodId`) REFERENCES `seller_fulfilment_methods`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `seller_fulfilment_rules` ADD CONSTRAINT `seller_fulfilment_rules_sellerOfferId_fkey` FOREIGN KEY (`sellerOfferId`) REFERENCES `seller_offers`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
ALTER TABLE `seller_fulfilment_rules` ADD CONSTRAINT `seller_fulfilment_rules_sellerLocationId_fkey` FOREIGN KEY (`sellerLocationId`) REFERENCES `seller_locations`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE `seller_logistics_pickup_profiles` ADD CONSTRAINT `seller_logistics_pickup_profiles_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `seller_logistics_pickup_profiles` ADD CONSTRAINT `seller_logistics_pickup_profiles_fulfilmentMethodId_fkey` FOREIGN KEY (`fulfilmentMethodId`) REFERENCES `seller_fulfilment_methods`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `seller_logistics_pickup_profiles` ADD CONSTRAINT `seller_logistics_pickup_profiles_sellerLocationId_fkey` FOREIGN KEY (`sellerLocationId`) REFERENCES `seller_locations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_logistics_rate_cards` ADD CONSTRAINT `seller_logistics_rate_cards_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `seller_logistics_rate_cards` ADD CONSTRAINT `seller_logistics_rate_cards_fulfilmentMethodId_fkey` FOREIGN KEY (`fulfilmentMethodId`) REFERENCES `seller_fulfilment_methods`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_logistics_rate_bands` ADD CONSTRAINT `seller_logistics_rate_bands_rateCardId_fkey` FOREIGN KEY (`rateCardId`) REFERENCES `seller_logistics_rate_cards`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `carrier_rate_quotes` ADD CONSTRAINT `carrier_rate_quotes_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `logistics_shipments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `carrier_rate_quotes` ADD CONSTRAINT `carrier_rate_quotes_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `carrier_rate_quotes` ADD CONSTRAINT `carrier_rate_quotes_fulfilmentMethodId_fkey` FOREIGN KEY (`fulfilmentMethodId`) REFERENCES `seller_fulfilment_methods`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `carrier_rate_quotes` ADD CONSTRAINT `carrier_rate_quotes_sellerCarrierConnectionId_fkey` FOREIGN KEY (`sellerCarrierConnectionId`) REFERENCES `seller_carrier_connections`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `carrier_rate_quotes` ADD CONSTRAINT `carrier_rate_quotes_rateCardId_fkey` FOREIGN KEY (`rateCardId`) REFERENCES `seller_logistics_rate_cards`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `shipment_purchases` ADD CONSTRAINT `shipment_purchases_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `logistics_shipments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `shipment_purchases` ADD CONSTRAINT `shipment_purchases_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_logistics_relationship_events` ADD CONSTRAINT `seller_logistics_relationship_events_partner_fkey` FOREIGN KEY (`sellerLogisticsPartnerId`) REFERENCES `seller_logistics_partners`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_logistics_partner_invitations` ADD CONSTRAINT `seller_logistics_partner_invitations_sellerAccountId_fkey` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `seller_logistics_partner_invitations` ADD CONSTRAINT `seller_logistics_partner_invitations_logisticsPartnerId_fkey` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `logistics_shipments` ADD CONSTRAINT `logistics_shipments_sellerFulfilmentMethodId_fkey` FOREIGN KEY (`sellerFulfilmentMethodId`) REFERENCES `seller_fulfilment_methods`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `logistics_shipments` ADD CONSTRAINT `logistics_shipments_sellerCarrierConnectionId_fkey` FOREIGN KEY (`sellerCarrierConnectionId`) REFERENCES `seller_carrier_connections`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `logistics_shipments` ADD CONSTRAINT `logistics_shipments_fulfilmentSelectionRuleId_fkey` FOREIGN KEY (`fulfilmentSelectionRuleId`) REFERENCES `seller_fulfilment_rules`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 15. The invariants, last of all.
--
--    Declared here rather than beside the tables they guard, to match every
--    other migration in this repository. The ORDER is cosmetic. What is not
--    cosmetic is the `ON UPDATE RESTRICT` on four of the foreign keys above,
--    and this is the note that explains it.
--
--    From MariaDB 10.5 onwards, a CHECK constraint may not reference a column
--    that is the child of a foreign key declared ON UPDATE CASCADE:
--
--      Function or expression 'sellerCarrierConnectionId' cannot be used in
--      the CHECK clause of `chk_seller_fulfilment_method_single_target`
--
--    Whichever of the two is added second is the one that fails, so reordering
--    does not help - it only moves the error. The rule is about REWRITING:
--    ON UPDATE CASCADE copies a changed parent key down and ON DELETE SET NULL
--    writes a NULL, and either would leave a checked row holding a value the
--    check never saw. ON DELETE CASCADE and RESTRICT stay allowed, because
--    they remove the row or refuse the parent's change instead.
--
--    10.4, which development runs, allows it. So this migration applied
--    cleanly on every machine it had ever seen and failed on the first fresh
--    11.4 it met.
--
--    RESTRICT is free here. Every one of these parents is keyed by a ULID
--    generated once at insert and never updated, so CASCADE on update has
--    never had anything to cascade. Prisma emits it on every relation by
--    default, which is the only reason it was there; the four relations
--    concerned now say `onUpdate: Restrict` in schema.prisma so that the
--    schema and these migrations keep agreeing.
-- ---------------------------------------------------------------------------

-- A method points at one thing, never at two. True at every status, including
-- while the seller is still filling the configuration in.
ALTER TABLE `seller_fulfilment_methods`
    ADD CONSTRAINT `chk_seller_fulfilment_method_single_target`
    CHECK (`sellerCarrierConnectionId` IS NULL OR `logisticsPartnerId` IS NULL);

-- And once it is past setup, it points at the RIGHT thing for its mode.
--
-- DRAFT and PENDING_SETUP are exempt because that is precisely what they
-- mean: the seller chose a mode during onboarding and has not yet connected
-- the account or created the organisation. Requiring the target from the first
-- INSERT would make the onboarding step impossible to save halfway, which is
-- the one thing that step has to be able to do.
ALTER TABLE `seller_fulfilment_methods`
    ADD CONSTRAINT `chk_seller_fulfilment_method_target`
    CHECK (
        `status` IN ('DRAFT', 'PENDING_SETUP')
        OR (`mode` = 'INTEGRATED_CARRIER' AND `sellerCarrierConnectionId` IS NOT NULL)
        OR (`mode` IN ('SELF_MANAGED', 'DEDICATED_PARTNER') AND `logisticsPartnerId` IS NOT NULL)
        OR (`mode` = 'OPERATOR_FULFILLED' AND `sellerCarrierConnectionId` IS NULL AND `logisticsPartnerId` IS NULL)
    );

-- A rule matches on the column its scope names, and a default matches on none.
ALTER TABLE `seller_fulfilment_rules`
    ADD CONSTRAINT `chk_seller_fulfilment_rule_scope`
    CHECK (
        (`scope` = 'PRODUCT' AND `sellerOfferId` IS NOT NULL)
        OR (`scope` = 'WAREHOUSE' AND `sellerLocationId` IS NOT NULL)
        OR (`scope` = 'DESTINATION' AND `destinationCountry` IS NOT NULL)
        OR (
            `scope` = 'SELLER_DEFAULT'
            AND `sellerOfferId` IS NULL
            AND `sellerLocationId` IS NULL
            AND `destinationCountry` IS NULL
        )
    );

-- The stored precedence is the scope's, and cannot be written as anything
-- else. Without this, one bad write reorders a seller's whole routing table.
ALTER TABLE `seller_fulfilment_rules`
    ADD CONSTRAINT `chk_seller_fulfilment_rule_precedence`
    CHECK (
        `precedence` = CASE `scope`
            WHEN 'PRODUCT' THEN 10
            WHEN 'WAREHOUSE' THEN 20
            WHEN 'DESTINATION' THEN 30
            ELSE 40
        END
    );

-- A band spans upwards, or is open-ended. A maximum below its minimum is a
-- band that can never match and is always a typing mistake.
ALTER TABLE `seller_logistics_rate_bands`
    ADD CONSTRAINT `chk_seller_rate_band_span`
    CHECK (`maxValue` IS NULL OR `maxValue` > `minValue`);
