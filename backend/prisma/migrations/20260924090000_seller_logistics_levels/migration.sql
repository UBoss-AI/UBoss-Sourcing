-- Seller logistics policy: who controls each of the four delivery levels
-- (L1 first mile, L2 international haul, L3 destination inland, L4 last
-- mile), what each level costs on which route, the frozen per-order charge,
-- the four legs a confirmed seller order is carried in, versioned platform-fee
-- policies and the per-seller-order settlement they produce. Plus the
-- notification kinds for all of it, appended at the END of each enum: MariaDB
-- stores an enum by position, so a member inserted in the middle would
-- renumber every existing row.
--
-- Additive only. No existing row is changed or removed. The one data step at
-- the end copies the carriers a seller chose during onboarding (their
-- seller_fulfilment_methods rows, which are left exactly as they are) into
-- seller_logistics_providers, so what they chose then is what Seller Hub ->
-- Logistics shows now.
--
-- Foreign keys are added before the CHECK constraints, and no column a CHECK
-- names is rewritten by a foreign key (every key here is ON UPDATE RESTRICT):
-- MariaDB 11.4 refuses a CHECK on a column a cascading key may change (error
-- 1901), which 10.4 does not check.

-- AlterTable
ALTER TABLE `business_profile` ADD COLUMN `showLogisticsLevelBreakdown` BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE `logistics_notifications` MODIFY `kind` ENUM('SHIPMENT_ASSIGNED', 'DRIVER_ASSIGNED', 'DRIVER_REASSIGNED', 'ASSIGNMENT_ACCEPTED', 'ASSIGNMENT_REJECTED', 'PICKUP_SCHEDULED', 'PICKUP_COMPLETED', 'SHIPMENT_DISPATCHED', 'SHIPMENT_IN_TRANSIT', 'OUT_FOR_DELIVERY', 'SHIPMENT_DELIVERED', 'DELIVERY_ATTEMPTED', 'SHIPMENT_DELAYED', 'EXCEPTION_RAISED', 'SLA_AT_RISK', 'SLA_BREACHED', 'POD_AVAILABLE', 'RETURN_INITIATED', 'INTEGRATION_FAILURE', 'USER_INVITED', 'SECURITY_EVENT', 'LEG_ASSIGNED', 'LEG_WITHDRAWN') NOT NULL;

-- AlterTable
ALTER TABLE `seller_notifications` MODIFY `kind` ENUM('APPLICATION_STATUS', 'LISTING_DECISION', 'NEW_ORDER', 'DISPATCH_SLA_WARNING', 'LOW_STOCK', 'ERP_SYNC_FAILURE', 'DOCUMENT_EXPIRING', 'PAYOUT_RESULT', 'RETURN_OR_DISPUTE', 'SECURITY_EVENT', 'BRAND_REQUEST_DECISION', 'CARRIER_ARRANGEMENT_DECISION', 'CARRIER_ACCEPTED', 'CARRIER_REJECTED', 'CARRIER_OFFER_EXPIRED', 'FULFILMENT_METHOD_DECISION', 'CARRIER_CONNECTION_FAILED', 'PARTNER_INVITATION_RESULT', 'CONSIGNMENT_AWAITING_METHOD', 'BULK_ORDER_RECEIVED', 'FREIGHT_QUOTE_REQUESTED', 'FREIGHT_QUOTE_AVAILABLE', 'PACKAGING_VALIDATION_FAILED', 'ERP_BRIDGE_OFFLINE', 'ERP_MAPPING_INCOMPLETE', 'ERP_SYNC_RECOVERED', 'ERP_INITIAL_SYNC_COMPLETE', 'CONSIGNMENT_NEEDS_CARRIER', 'CARRIER_BOOKING_INCOMPLETE', 'LOGISTICS_POLICY_UPDATE', 'LOGISTICS_PRICE_REQUIRED', 'LOGISTICS_UBOSS_PRICE_PUBLISHED', 'LOGISTICS_LEG_ASSIGNMENT_REQUIRED', 'LOGISTICS_LEG_UPDATE', 'SETTLEMENT_CALCULATED') NOT NULL;

-- CreateTable
CREATE TABLE `seller_logistics_policies` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `mode` ENUM('SELF', 'UBOSS', 'HYBRID') NOT NULL DEFAULT 'SELF',
    `l2Owner` ENUM('SELLER', 'UBOSS') NOT NULL DEFAULT 'SELLER',
    `l3Owner` ENUM('SELLER', 'UBOSS') NOT NULL DEFAULT 'SELLER',
    `l4Owner` ENUM('SELLER', 'UBOSS') NOT NULL DEFAULT 'SELLER',
    `activeVersionId` CHAR(26) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `updatedByUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_seller_logistics_policy_seller`(`sellerAccountId`),
    UNIQUE INDEX `uq_seller_logistics_policy_active`(`activeVersionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_logistics_policy_versions` (
    `id` CHAR(26) NOT NULL,
    `policyId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `versionNumber` INTEGER NOT NULL,
    `mode` ENUM('SELF', 'UBOSS', 'HYBRID') NOT NULL,
    `l2Owner` ENUM('SELLER', 'UBOSS') NOT NULL,
    `l3Owner` ENUM('SELLER', 'UBOSS') NOT NULL,
    `l4Owner` ENUM('SELLER', 'UBOSS') NOT NULL,
    `changeNote` VARCHAR(512) NULL,
    `publishedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `publishedByUserId` CHAR(26) NULL,
    `supersededAt` DATETIME(3) NULL,

    INDEX `ix_logistics_policy_version_seller`(`sellerAccountId`, `publishedAt`),
    UNIQUE INDEX `uq_logistics_policy_version_number`(`policyId`, `versionNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_logistics_providers` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `provider` ENUM('MANUAL', 'CUSTOM', 'DHL', 'FEDEX', 'UPS', 'INDIA_POST') NOT NULL,
    `connectionMode` ENUM('MANUAL_ONLY', 'API') NOT NULL DEFAULT 'MANUAL_ONLY',
    `enabledAt` DATETIME(3) NULL,
    `disabledAt` DATETIME(3) NULL,
    `updatedByUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_seller_logistics_provider`(`sellerAccountId`, `provider`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_level_rates` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `level` ENUM('L1', 'L2', 'L3', 'L4') NOT NULL,
    `owner` ENUM('SELLER', 'UBOSS') NOT NULL,
    `originLocationId` CHAR(26) NULL,
    `originPortCode` VARCHAR(8) NULL,
    `destinationPortCode` VARCHAR(8) NULL,
    `destinationHubCode` VARCHAR(64) NULL,
    `destinationHubName` VARCHAR(160) NULL,
    `destinationCountry` CHAR(2) NULL,
    `destinationPostalPrefix` VARCHAR(16) NOT NULL DEFAULT '',
    `packageClass` VARCHAR(16) NULL,
    `minWeightGrams` INTEGER NULL,
    `maxWeightGrams` INTEGER NULL,
    `isWorldwideFlat` BOOLEAN NOT NULL DEFAULT false,
    `transportMode` ENUM('ROAD', 'AIR', 'SEA', 'RAIL', 'POSTAL') NOT NULL,
    `provider` ENUM('MANUAL', 'CUSTOM', 'DHL', 'FEDEX', 'UPS', 'INDIA_POST') NULL,
    `logisticsPartnerId` CHAR(26) NULL,
    `providerLabel` VARCHAR(160) NULL,
    `serviceName` VARCHAR(120) NULL,
    `trackingReferenceKind` VARCHAR(16) NULL,
    `requiresCustomsRelease` BOOLEAN NOT NULL DEFAULT false,
    `transitDaysMin` SMALLINT NULL,
    `transitDaysMax` SMALLINT NULL,
    `amountMinor` BIGINT NULL,
    `currency` CHAR(3) NOT NULL,
    `isFree` BOOLEAN NOT NULL DEFAULT false,
    `freeConfirmedAt` DATETIME(3) NULL,
    `taxInclusive` BOOLEAN NOT NULL DEFAULT false,
    `priceSource` ENUM('MANUAL', 'PROVIDER_QUOTE', 'UBOSS_RATE', 'RATE_CARD') NOT NULL,
    `status` ENUM('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'INACTIVE') NOT NULL DEFAULT 'DRAFT',
    `effectiveFrom` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `versionNumber` INTEGER NOT NULL DEFAULT 1,
    `supersedesRateId` CHAR(26) NULL,
    `publishedAt` DATETIME(3) NULL,
    `publishedByUserId` CHAR(26) NULL,
    `updatedByUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_level_rate_lookup`(`sellerAccountId`, `level`, `owner`, `status`),
    INDEX `ix_level_rate_origin`(`originLocationId`),
    INDEX `ix_level_rate_partner`(`logisticsPartnerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `order_logistics_legs` (
    `id` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `level` ENUM('L1', 'L2', 'L3', 'L4') NOT NULL,
    `owner` ENUM('SELLER', 'UBOSS') NOT NULL,
    `policyVersionId` CHAR(26) NOT NULL,
    `rateId` CHAR(26) NOT NULL,
    `rateVersionNumber` INTEGER NOT NULL,
    `transportMode` ENUM('ROAD', 'AIR', 'SEA', 'RAIL', 'POSTAL') NOT NULL,
    `provider` ENUM('MANUAL', 'CUSTOM', 'DHL', 'FEDEX', 'UPS', 'INDIA_POST') NULL,
    `logisticsPartnerId` CHAR(26) NULL,
    `providerLabel` VARCHAR(160) NULL,
    `serviceName` VARCHAR(120) NULL,
    `originLabel` VARCHAR(160) NOT NULL,
    `destinationLabel` VARCHAR(160) NOT NULL,
    `transitDaysMin` SMALLINT NULL,
    `transitDaysMax` SMALLINT NULL,
    `originalAmountMinor` BIGINT NOT NULL,
    `originalCurrency` CHAR(3) NOT NULL,
    `fxRate` DECIMAL(24, 12) NULL,
    `fxProvider` VARCHAR(64) NULL,
    `fxRateAsOf` DATETIME(3) NULL,
    `amountMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `isFree` BOOLEAN NOT NULL DEFAULT false,
    `taxInclusive` BOOLEAN NOT NULL DEFAULT false,
    `priceSource` ENUM('MANUAL', 'PROVIDER_QUOTE', 'UBOSS_RATE', 'RATE_CARD') NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_order_logistics_leg_seller`(`sellerAccountId`),
    INDEX `ix_order_logistics_leg_policy`(`policyVersionId`),
    UNIQUE INDEX `uq_order_logistics_leg`(`orderId`, `sellerAccountId`, `level`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipment_legs` (
    `id` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `orderLegId` CHAR(26) NULL,
    `logisticsShipmentId` CHAR(26) NULL,
    `level` ENUM('L1', 'L2', 'L3', 'L4') NOT NULL,
    `sequence` SMALLINT NOT NULL,
    `owner` ENUM('SELLER', 'UBOSS') NOT NULL,
    `status` ENUM('PENDING', 'AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `provider` ENUM('MANUAL', 'CUSTOM', 'DHL', 'FEDEX', 'UPS', 'INDIA_POST') NULL,
    `logisticsPartnerId` CHAR(26) NULL,
    `providerLabel` VARCHAR(160) NULL,
    `serviceName` VARCHAR(120) NULL,
    `connectionMode` ENUM('MANUAL_ONLY', 'API') NULL,
    `trackingNumber` VARCHAR(64) NULL,
    `trackingReferenceKind` VARCHAR(16) NULL,
    `pickupReference` VARCHAR(64) NULL,
    `expectedStartAt` DATETIME(3) NULL,
    `expectedCompleteAt` DATETIME(3) NULL,
    `driverProfileId` CHAR(26) NULL,
    `assignedAt` DATETIME(3) NULL,
    `assignedByUserId` CHAR(26) NULL,
    `assignedByRole` VARCHAR(8) NULL,
    `acceptedAt` DATETIME(3) NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_shipment_leg_owner_status`(`owner`, `status`),
    INDEX `ix_shipment_leg_partner`(`logisticsPartnerId`, `status`),
    INDEX `ix_shipment_leg_seller`(`sellerAccountId`, `status`),
    INDEX `ix_shipment_leg_order`(`orderId`),
    UNIQUE INDEX `uq_shipment_leg_group_level`(`sellerOrderGroupId`, `level`),
    UNIQUE INDEX `uq_shipment_leg_charge`(`orderLegId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `shipment_leg_events` (
    `id` CHAR(26) NOT NULL,
    `legId` CHAR(26) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `fromStatus` ENUM('PENDING', 'AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') NULL,
    `toStatus` ENUM('PENDING', 'AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED') NOT NULL,
    `actorRole` VARCHAR(8) NOT NULL,
    `performedByUserId` CHAR(26) NULL,
    `note` VARCHAR(512) NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `idempotencyKey` VARCHAR(80) NULL,

    INDEX `ix_shipment_leg_event_leg`(`legId`, `occurredAt`),
    UNIQUE INDEX `uq_shipment_leg_event_idem`(`idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `platform_fee_policies` (
    `id` CHAR(26) NOT NULL,
    `scope` ENUM('GLOBAL', 'MARKET', 'CATEGORY', 'SELLER') NOT NULL,
    `scopeKey` VARCHAR(64) NOT NULL,
    `sellerAccountId` CHAR(26) NULL,
    `categoryId` CHAR(26) NULL,
    `marketCountry` CHAR(2) NULL,
    `versionNumber` INTEGER NOT NULL,
    `status` ENUM('DRAFT', 'PUBLISHED', 'RETIRED') NOT NULL DEFAULT 'DRAFT',
    `activeScopeKey` VARCHAR(64) NULL,
    `name` VARCHAR(160) NOT NULL,
    `feeType` ENUM('PERCENT', 'FLAT', 'PERCENT_PLUS_FLAT') NOT NULL,
    `feeBasis` ENUM('PRODUCT_SUBTOTAL', 'PRODUCT_SUBTOTAL_PLUS_SELLER_DELIVERY') NOT NULL DEFAULT 'PRODUCT_SUBTOTAL',
    `percentRate` DECIMAL(9, 6) NOT NULL DEFAULT 0,
    `flatFeeMinor` BIGINT NOT NULL DEFAULT 0,
    `minFeeMinor` BIGINT NULL,
    `maxFeeMinor` BIGINT NULL,
    `currency` CHAR(3) NOT NULL,
    `taxRatePercent` DECIMAL(9, 6) NOT NULL DEFAULT 0,
    `taxLabel` VARCHAR(64) NOT NULL DEFAULT 'Tax on platform fee',
    `taxJurisdiction` CHAR(2) NULL,
    `isTaxRuleVerified` BOOLEAN NOT NULL DEFAULT false,
    `taxVerifiedByUserId` CHAR(26) NULL,
    `taxVerifiedAt` DATETIME(3) NULL,
    `taxVerificationNote` VARCHAR(512) NULL,
    `effectiveFrom` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `effectiveTo` DATETIME(3) NULL,
    `notes` VARCHAR(1024) NULL,
    `publishedAt` DATETIME(3) NULL,
    `publishedByUserId` CHAR(26) NULL,
    `retiredAt` DATETIME(3) NULL,
    `createdByUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_platform_fee_status`(`status`, `scope`),
    UNIQUE INDEX `uq_platform_fee_version`(`scopeKey`, `versionNumber`),
    UNIQUE INDEX `uq_platform_fee_active`(`activeScopeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_order_settlements` (
    `id` CHAR(26) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `grossProceedsMinor` BIGINT NOT NULL,
    `sellerDeliveryProceedsMinor` BIGINT NOT NULL DEFAULT 0,
    `ubossDeliveryMinor` BIGINT NOT NULL DEFAULT 0,
    `feeBasisMinor` BIGINT NOT NULL,
    `platformFeeMinor` BIGINT NOT NULL,
    `platformFeeTaxMinor` BIGINT NOT NULL,
    `refundsAdjustmentsMinor` BIGINT NOT NULL DEFAULT 0,
    `estimatedSettlementMinor` BIGINT NOT NULL,
    `platformFeePolicyId` CHAR(26) NULL,
    `platformFeePolicyVersion` INTEGER NULL,
    `feeTaxRatePercent` DECIMAL(9, 6) NOT NULL DEFAULT 0,
    `feeTaxLabel` VARCHAR(64) NOT NULL,
    `feeTaxVerified` BOOLEAN NOT NULL DEFAULT false,
    `breakdownJson` JSON NOT NULL,
    `computedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_order_settlement_seller`(`sellerAccountId`, `computedAt`),
    INDEX `ix_order_settlement_policy`(`platformFeePolicyId`),
    UNIQUE INDEX `uq_order_settlement_group`(`sellerOrderGroupId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `seller_logistics_policies` ADD CONSTRAINT `fk_seller_logistics_policy_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_logistics_policies` ADD CONSTRAINT `fk_seller_logistics_policy_active` FOREIGN KEY (`activeVersionId`) REFERENCES `seller_logistics_policy_versions`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_logistics_policy_versions` ADD CONSTRAINT `fk_logistics_policy_version_policy` FOREIGN KEY (`policyId`) REFERENCES `seller_logistics_policies`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_logistics_policy_versions` ADD CONSTRAINT `fk_logistics_policy_version_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_logistics_providers` ADD CONSTRAINT `fk_seller_logistics_provider_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `logistics_level_rates` ADD CONSTRAINT `fk_level_rate_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `logistics_level_rates` ADD CONSTRAINT `fk_level_rate_origin` FOREIGN KEY (`originLocationId`) REFERENCES `seller_locations`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `logistics_level_rates` ADD CONSTRAINT `fk_level_rate_partner` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `order_logistics_legs` ADD CONSTRAINT `fk_order_logistics_leg_order` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `order_logistics_legs` ADD CONSTRAINT `fk_order_logistics_leg_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `order_logistics_legs` ADD CONSTRAINT `fk_order_logistics_leg_policy` FOREIGN KEY (`policyVersionId`) REFERENCES `seller_logistics_policy_versions`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_legs` ADD CONSTRAINT `fk_shipment_leg_order` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_legs` ADD CONSTRAINT `fk_shipment_leg_group` FOREIGN KEY (`sellerOrderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_legs` ADD CONSTRAINT `fk_shipment_leg_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_legs` ADD CONSTRAINT `fk_shipment_leg_charge` FOREIGN KEY (`orderLegId`) REFERENCES `order_logistics_legs`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_legs` ADD CONSTRAINT `fk_shipment_leg_partner` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `shipment_leg_events` ADD CONSTRAINT `fk_shipment_leg_event_leg` FOREIGN KEY (`legId`) REFERENCES `shipment_legs`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_order_settlements` ADD CONSTRAINT `fk_order_settlement_group` FOREIGN KEY (`sellerOrderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_order_settlements` ADD CONSTRAINT `fk_order_settlement_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `seller_order_settlements` ADD CONSTRAINT `fk_order_settlement_policy` FOREIGN KEY (`platformFeePolicyId`) REFERENCES `platform_fee_policies`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- CheckConstraints ----------------------------------------------------------

-- L1 is the seller's in every mode, so it is not stored. SELF gives the seller
-- L2-L4, UBOSS gives UBOSS L2-L4, and HYBRID lets the seller choose each one -
-- but not all three, which is SELF under another name.
ALTER TABLE `seller_logistics_policies` ADD CONSTRAINT `chk_logistics_policy_mode_owners` CHECK (
  (`mode` = 'SELF'  AND `l2Owner` = 'SELLER' AND `l3Owner` = 'SELLER' AND `l4Owner` = 'SELLER')
  OR (`mode` = 'UBOSS' AND `l2Owner` = 'UBOSS'  AND `l3Owner` = 'UBOSS'  AND `l4Owner` = 'UBOSS')
  OR (`mode` = 'HYBRID' AND NOT (`l2Owner` = 'SELLER' AND `l3Owner` = 'SELLER' AND `l4Owner` = 'SELLER'))
);

ALTER TABLE `seller_logistics_policy_versions` ADD CONSTRAINT `chk_logistics_policy_version_mode_owners` CHECK (
  (`mode` = 'SELF'  AND `l2Owner` = 'SELLER' AND `l3Owner` = 'SELLER' AND `l4Owner` = 'SELLER')
  OR (`mode` = 'UBOSS' AND `l2Owner` = 'UBOSS'  AND `l3Owner` = 'UBOSS'  AND `l4Owner` = 'UBOSS')
  OR (`mode` = 'HYBRID' AND NOT (`l2Owner` = 'SELLER' AND `l3Owner` = 'SELLER' AND `l4Owner` = 'SELLER'))
);

ALTER TABLE `logistics_level_rates` ADD CONSTRAINT `chk_level_rate_l1_seller` CHECK (`level` <> 'L1' OR `owner` = 'SELLER');

-- Empty is not zero. A price is NULL until somebody enters one; zero is only
-- ever an explicit, confirmed free level.
ALTER TABLE `logistics_level_rates` ADD CONSTRAINT `chk_level_rate_free` CHECK (
  (`isFree` = 0 AND (`amountMinor` IS NULL OR `amountMinor` > 0))
  OR (`isFree` = 1 AND `amountMinor` = 0 AND `freeConfirmedAt` IS NOT NULL)
);

ALTER TABLE `logistics_level_rates` ADD CONSTRAINT `chk_level_rate_published_priced` CHECK (`status` <> 'PUBLISHED' OR `amountMinor` IS NOT NULL);

ALTER TABLE `logistics_level_rates` ADD CONSTRAINT `chk_level_rate_weight` CHECK (
  `minWeightGrams` IS NULL OR `maxWeightGrams` IS NULL OR `minWeightGrams` <= `maxWeightGrams`
);

ALTER TABLE `logistics_level_rates` ADD CONSTRAINT `chk_level_rate_transit` CHECK (
  `transitDaysMin` IS NULL OR `transitDaysMax` IS NULL OR `transitDaysMin` <= `transitDaysMax`
);

ALTER TABLE `order_logistics_legs` ADD CONSTRAINT `chk_order_logistics_leg_l1_seller` CHECK (`level` <> 'L1' OR `owner` = 'SELLER');
ALTER TABLE `order_logistics_legs` ADD CONSTRAINT `chk_order_logistics_leg_amount` CHECK (`amountMinor` >= 0 AND `originalAmountMinor` >= 0);

ALTER TABLE `shipment_legs` ADD CONSTRAINT `chk_shipment_leg_l1_seller` CHECK (`level` <> 'L1' OR `owner` = 'SELLER');
ALTER TABLE `shipment_legs` ADD CONSTRAINT `chk_shipment_leg_sequence` CHECK (`sequence` BETWEEN 1 AND 4);

ALTER TABLE `platform_fee_policies` ADD CONSTRAINT `chk_platform_fee_rates` CHECK (
  `percentRate` >= 0 AND `percentRate` <= 100 AND `taxRatePercent` >= 0 AND `taxRatePercent` <= 100
  AND `flatFeeMinor` >= 0
  AND (`minFeeMinor` IS NULL OR `minFeeMinor` >= 0)
  AND (`minFeeMinor` IS NULL OR `maxFeeMinor` IS NULL OR `minFeeMinor` <= `maxFeeMinor`)
);

-- Exactly one live version per scope: the key is held while PUBLISHED and
-- released otherwise, under uq_platform_fee_active.
ALTER TABLE `platform_fee_policies` ADD CONSTRAINT `chk_platform_fee_active_key` CHECK (
  (`status` = 'PUBLISHED' AND `activeScopeKey` = `scopeKey`)
  OR (`status` <> 'PUBLISHED' AND `activeScopeKey` IS NULL)
);

-- Data: the carriers a seller already chose ----------------------------------

-- A DHL, FedEx or India Post delivery method a seller set up during onboarding
-- becomes an enabled carrier under Seller Hub -> Logistics. API when an
-- account was joined to it, MANUAL_ONLY otherwise - which is never a claim that
-- anything is connected; that is still decided by carrierSetupStatus alone.
INSERT IGNORE INTO `seller_logistics_providers`
  (`id`, `sellerAccountId`, `provider`, `connectionMode`, `enabledAt`, `createdAt`, `updatedAt`)
SELECT
  UPPER(LEFT(CONCAT('01LP', SHA2(CONCAT(m.`sellerAccountId`, ':', SUBSTRING_INDEX(SUBSTRING_INDEX(m.`methodKey`, ':', 2), ':', -1)), 256)), 26)),
  m.`sellerAccountId`,
  SUBSTRING_INDEX(SUBSTRING_INDEX(m.`methodKey`, ':', 2), ':', -1),
  CASE WHEN MAX(m.`sellerCarrierConnectionId`) IS NULL THEN 'MANUAL_ONLY' ELSE 'API' END,
  MIN(m.`createdAt`),
  CURRENT_TIMESTAMP(3),
  CURRENT_TIMESTAMP(3)
FROM `seller_fulfilment_methods` m
WHERE m.`mode` = 'INTEGRATED_CARRIER'
  AND m.`archivedAt` IS NULL
  AND SUBSTRING_INDEX(SUBSTRING_INDEX(m.`methodKey`, ':', 2), ':', -1) IN ('DHL', 'FEDEX', 'INDIA_POST')
GROUP BY m.`sellerAccountId`, SUBSTRING_INDEX(SUBSTRING_INDEX(m.`methodKey`, ':', 2), ':', -1);
