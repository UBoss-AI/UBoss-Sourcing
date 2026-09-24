-- Enterprise bulk preorders: a request for a quantity large enough that the
-- seller has to confirm capacity, price and a committed delivery date, and the
-- buyer then has to confirm what the seller said, before any order exists.
--
-- Additive only. No existing row is changed. `orders.source` and
-- `seller_notifications.kind` gain members at the END of their enums: MariaDB
-- stores an enum by position, so a member inserted in the middle would
-- renumber every existing row.
--
-- Foreign keys are added before the CHECK constraints, and every key here is
-- ON UPDATE RESTRICT: MariaDB 11.4 refuses a CHECK on a column a cascading key
-- may rewrite (error 1901), which 10.4 does not check.

-- AlterTable
ALTER TABLE `orders` MODIFY `source` ENUM('ONE_TIME', 'RECURRING', 'PREORDER') NOT NULL DEFAULT 'ONE_TIME';

-- AlterTable
ALTER TABLE `seller_notifications` MODIFY `kind` ENUM('APPLICATION_STATUS', 'LISTING_DECISION', 'NEW_ORDER', 'DISPATCH_SLA_WARNING', 'LOW_STOCK', 'ERP_SYNC_FAILURE', 'DOCUMENT_EXPIRING', 'PAYOUT_RESULT', 'RETURN_OR_DISPUTE', 'SECURITY_EVENT', 'BRAND_REQUEST_DECISION', 'CARRIER_ARRANGEMENT_DECISION', 'CARRIER_ACCEPTED', 'CARRIER_REJECTED', 'CARRIER_OFFER_EXPIRED', 'FULFILMENT_METHOD_DECISION', 'CARRIER_CONNECTION_FAILED', 'PARTNER_INVITATION_RESULT', 'CONSIGNMENT_AWAITING_METHOD', 'BULK_ORDER_RECEIVED', 'FREIGHT_QUOTE_REQUESTED', 'FREIGHT_QUOTE_AVAILABLE', 'PACKAGING_VALIDATION_FAILED', 'ERP_BRIDGE_OFFLINE', 'ERP_MAPPING_INCOMPLETE', 'ERP_SYNC_RECOVERED', 'ERP_INITIAL_SYNC_COMPLETE', 'CONSIGNMENT_NEEDS_CARRIER', 'CARRIER_BOOKING_INCOMPLETE', 'LOGISTICS_POLICY_UPDATE', 'LOGISTICS_PRICE_REQUIRED', 'LOGISTICS_UBOSS_PRICE_PUBLISHED', 'LOGISTICS_LEG_ASSIGNMENT_REQUIRED', 'LOGISTICS_LEG_UPDATE', 'SETTLEMENT_CALCULATED', 'PREORDER_REQUEST_RECEIVED', 'PREORDER_BUYER_RESPONSE', 'PREORDER_CONFIRMED', 'PREORDER_CLOSED', 'PREORDER_DELIVERY_RISK') NOT NULL;

-- CreateTable
CREATE TABLE `preorder_policies` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `scope` ENUM('OFFER', 'PRODUCT', 'SELLER_DEFAULT') NOT NULL,
    `scopeKey` VARCHAR(26) NOT NULL DEFAULT '',
    `offerId` CHAR(26) NULL,
    `productId` CHAR(26) NULL,
    `isEnabled` BOOLEAN NOT NULL DEFAULT false,
    `moqUnit` ENUM('PIECE', 'CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER') NOT NULL DEFAULT 'PIECE',
    `moqQuantity` INTEGER NULL,
    `incrementQuantity` INTEGER NOT NULL DEFAULT 1,
    `maxQuantity` INTEGER NULL,
    `capacityBaseUnits` INTEGER NULL,
    `capacityPeriod` ENUM('DAY', 'WEEK', 'MONTH') NOT NULL DEFAULT 'MONTH',
    `minLeadTimeDays` INTEGER NULL,
    `maxAdvanceDays` INTEGER NULL,
    `deliveryCountriesJson` JSON NULL,
    `eligibleLocationIdsJson` JSON NULL,
    `packagingTypesJson` JSON NULL,
    `pricingMode` ENUM('FIXED', 'QUOTE_REQUIRED') NOT NULL DEFAULT 'QUOTE_REQUIRED',
    `allowPartialFulfilment` BOOLEAN NOT NULL DEFAULT false,
    `allowSplitDelivery` BOOLEAN NOT NULL DEFAULT false,
    `requestExpiryHours` INTEGER NULL,
    `offerExpiryHours` INTEGER NULL,
    `cancellationTerms` VARCHAR(1000) NULL,
    `specialInstructions` VARCHAR(1000) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `updatedByLabel` VARCHAR(160) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_preorder_policy_seller`(`sellerAccountId`, `updatedAt`),
    UNIQUE INDEX `uq_preorder_policy_scope`(`sellerAccountId`, `scope`, `scopeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `preorder_price_tiers` (
    `id` CHAR(26) NOT NULL,
    `policyId` CHAR(26) NOT NULL,
    `minBaseUnits` INTEGER NOT NULL,
    `unitPriceMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_preorder_tier_band`(`policyId`, `minBaseUnits`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `preorder_capacity_buckets` (
    `id` CHAR(26) NOT NULL,
    `policyId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `periodKey` VARCHAR(16) NOT NULL,
    `reservedBaseUnits` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_preorder_capacity_seller`(`sellerAccountId`, `periodKey`),
    UNIQUE INDEX `uq_preorder_capacity_period`(`policyId`, `periodKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `preorder_requests` (
    `id` CHAR(26) NOT NULL,
    `requestNumber` VARCHAR(32) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `customerProfileId` CHAR(26) NOT NULL,
    `requestedByUserId` CHAR(26) NOT NULL,
    `productId` CHAR(26) NOT NULL,
    `variantId` CHAR(26) NULL,
    `variantKey` VARCHAR(26) NOT NULL DEFAULT '',
    `offerId` CHAR(26) NOT NULL,
    `policyId` CHAR(26) NULL,
    `policyVersion` INTEGER NOT NULL,
    `policySnapshotJson` JSON NOT NULL,
    `status` ENUM('SUBMITTED', 'SELLER_REVIEW_REQUIRED', 'SELLER_ACCEPTED', 'SELLER_COUNTERED', 'BUYER_CONFIRMED', 'PAYMENT_REQUIRED', 'CONFIRMED', 'IN_PRODUCTION', 'READY_FOR_FULFILLMENT', 'CONVERTED_TO_ORDER', 'REJECTED', 'CANCELLED', 'EXPIRED') NOT NULL DEFAULT 'SUBMITTED',
    `orderingUnit` ENUM('PIECE', 'CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER') NOT NULL,
    `unitQuantity` INTEGER NOT NULL,
    `unitsPerPackage` INTEGER NOT NULL,
    `requestedBaseUnits` INTEGER NOT NULL,
    `requestedDeliveryDate` DATE NOT NULL,
    `earliestDeliveryDate` DATE NOT NULL,
    `timezone` VARCHAR(64) NOT NULL,
    `shippingAddressId` CHAR(26) NULL,
    `shippingAddressJson` JSON NOT NULL,
    `destinationCountry` CHAR(2) NOT NULL,
    `destinationWarehouseLabel` VARCHAR(160) NULL,
    `packagingPreference` ENUM('PIECE', 'CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER') NULL,
    `transportPreference` ENUM('ANY', 'ROAD', 'AIR', 'SEA', 'RAIL') NOT NULL DEFAULT 'ANY',
    `allowPartialDelivery` BOOLEAN NOT NULL DEFAULT false,
    `purchaseOrderReference` VARCHAR(64) NULL,
    `customerNotes` VARCHAR(2000) NULL,
    `handlingInstructions` VARCHAR(1000) NULL,
    `termsAcceptedAt` DATETIME(3) NOT NULL,
    `pricingMode` ENUM('FIXED', 'QUOTE_REQUIRED') NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `indicativeUnitPriceMinor` BIGINT NULL,
    `indicativeTotalMinor` BIGINT NULL,
    `indicativeTierMinBaseUnits` INTEGER NULL,
    `displayCurrency` CHAR(3) NULL,
    `fxSnapshotId` CHAR(26) NULL,
    `fxRate` VARCHAR(40) NULL,
    `fxRateAsOf` DATETIME(3) NULL,
    `currentOfferId` CHAR(26) NULL,
    `acceptedOfferId` CHAR(26) NULL,
    `confirmedTermsJson` JSON NULL,
    `confirmedTermsHash` CHAR(64) NULL,
    `confirmedBaseUnits` INTEGER NULL,
    `confirmedUnitPriceMinor` BIGINT NULL,
    `confirmedFreightMinor` BIGINT NULL,
    `confirmedGoodsTotalMinor` BIGINT NULL,
    `committedDeliveryDate` DATE NULL,
    `convertedOrderId` CHAR(26) NULL,
    `capacityBucketId` CHAR(26) NULL,
    `capacityReservedBaseUnits` INTEGER NOT NULL DEFAULT 0,
    `expiresAt` DATETIME(3) NULL,
    `closedReason` VARCHAR(1000) NULL,
    `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sellerRespondedAt` DATETIME(3) NULL,
    `buyerConfirmedAt` DATETIME(3) NULL,
    `confirmedAt` DATETIME(3) NULL,
    `productionStartedAt` DATETIME(3) NULL,
    `readyAt` DATETIME(3) NULL,
    `convertedAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `deliveryRiskNotifiedAt` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_preorder_request_number`(`requestNumber`),
    UNIQUE INDEX `uq_preorder_request_accepted_offer`(`acceptedOfferId`),
    UNIQUE INDEX `uq_preorder_request_order`(`convertedOrderId`),
    INDEX `ix_preorder_request_seller`(`sellerAccountId`, `status`, `updatedAt`),
    INDEX `ix_preorder_request_customer`(`customerProfileId`, `createdAt`),
    INDEX `ix_preorder_request_expiry`(`status`, `expiresAt`),
    INDEX `ix_preorder_request_offer`(`offerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `preorder_offers` (
    `id` CHAR(26) NOT NULL,
    `requestId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `revision` INTEGER NOT NULL,
    `author` ENUM('BUYER', 'SELLER') NOT NULL,
    `kind` ENUM('ACCEPT_AS_REQUESTED', 'COUNTER') NOT NULL,
    `state` ENUM('PROPOSED', 'ACCEPTED', 'DECLINED', 'SUPERSEDED', 'EXPIRED', 'WITHDRAWN') NOT NULL DEFAULT 'PROPOSED',
    `quantityBaseUnits` INTEGER NOT NULL,
    `unitPriceMinor` BIGINT NOT NULL,
    `goodsTotalMinor` BIGINT NOT NULL,
    `freightMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `committedDeliveryDate` DATE NOT NULL,
    `deliverySplitsJson` JSON NULL,
    `originLocationId` CHAR(26) NULL,
    `note` VARCHAR(2000) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `termsHash` CHAR(64) NOT NULL,
    `createdByUserId` CHAR(26) NULL,
    `createdByLabel` VARCHAR(160) NOT NULL,
    `respondedAt` DATETIME(3) NULL,
    `respondedByLabel` VARCHAR(160) NULL,
    `responseNote` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_preorder_offer_seller`(`sellerAccountId`, `createdAt`),
    UNIQUE INDEX `uq_preorder_offer_revision`(`requestId`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `preorder_status_history` (
    `id` CHAR(26) NOT NULL,
    `requestId` CHAR(26) NOT NULL,
    `fromStatus` ENUM('SUBMITTED', 'SELLER_REVIEW_REQUIRED', 'SELLER_ACCEPTED', 'SELLER_COUNTERED', 'BUYER_CONFIRMED', 'PAYMENT_REQUIRED', 'CONFIRMED', 'IN_PRODUCTION', 'READY_FOR_FULFILLMENT', 'CONVERTED_TO_ORDER', 'REJECTED', 'CANCELLED', 'EXPIRED') NULL,
    `toStatus` ENUM('SUBMITTED', 'SELLER_REVIEW_REQUIRED', 'SELLER_ACCEPTED', 'SELLER_COUNTERED', 'BUYER_CONFIRMED', 'PAYMENT_REQUIRED', 'CONFIRMED', 'IN_PRODUCTION', 'READY_FOR_FULFILLMENT', 'CONVERTED_TO_ORDER', 'REJECTED', 'CANCELLED', 'EXPIRED') NOT NULL,
    `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER', 'LOGISTICS') NOT NULL,
    `actorUserId` CHAR(26) NULL,
    `actorLabel` VARCHAR(160) NOT NULL,
    `reason` VARCHAR(1000) NULL,
    `metaJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_preorder_history_request`(`requestId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `preorder_policies` ADD CONSTRAINT `fk_preorder_policy_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_price_tiers` ADD CONSTRAINT `fk_preorder_tier_policy` FOREIGN KEY (`policyId`) REFERENCES `preorder_policies`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_capacity_buckets` ADD CONSTRAINT `fk_preorder_capacity_policy` FOREIGN KEY (`policyId`) REFERENCES `preorder_policies`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_requests` ADD CONSTRAINT `fk_preorder_request_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_requests` ADD CONSTRAINT `fk_preorder_request_customer` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_requests` ADD CONSTRAINT `fk_preorder_request_offer` FOREIGN KEY (`offerId`) REFERENCES `seller_offers`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_requests` ADD CONSTRAINT `fk_preorder_request_order` FOREIGN KEY (`convertedOrderId`) REFERENCES `orders`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_offers` ADD CONSTRAINT `fk_preorder_offer_request` FOREIGN KEY (`requestId`) REFERENCES `preorder_requests`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_status_history` ADD CONSTRAINT `fk_preorder_history_request` FOREIGN KEY (`requestId`) REFERENCES `preorder_requests`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;


-- CHECK constraints. The service validates all of these first and says why;
-- these are the floor underneath it, so a bug cannot store a negative price or
-- a zero-piece request.
ALTER TABLE `preorder_policies`
  ADD CONSTRAINT `chk_preorder_policy_moq` CHECK (`moqQuantity` IS NULL OR `moqQuantity` > 0),
  ADD CONSTRAINT `chk_preorder_policy_increment` CHECK (`incrementQuantity` > 0),
  ADD CONSTRAINT `chk_preorder_policy_max` CHECK (`maxQuantity` IS NULL OR `maxQuantity` > 0),
  ADD CONSTRAINT `chk_preorder_policy_capacity` CHECK (`capacityBaseUnits` IS NULL OR `capacityBaseUnits` > 0),
  ADD CONSTRAINT `chk_preorder_policy_lead` CHECK (`minLeadTimeDays` IS NULL OR `minLeadTimeDays` >= 0);

ALTER TABLE `preorder_price_tiers`
  ADD CONSTRAINT `chk_preorder_tier_min` CHECK (`minBaseUnits` > 0),
  ADD CONSTRAINT `chk_preorder_tier_price` CHECK (`unitPriceMinor` > 0);

ALTER TABLE `preorder_capacity_buckets`
  ADD CONSTRAINT `chk_preorder_capacity_reserved` CHECK (`reservedBaseUnits` >= 0);

ALTER TABLE `preorder_requests`
  ADD CONSTRAINT `chk_preorder_request_quantity` CHECK (`unitQuantity` > 0 AND `unitsPerPackage` > 0 AND `requestedBaseUnits` > 0),
  ADD CONSTRAINT `chk_preorder_request_indicative` CHECK (`indicativeUnitPriceMinor` IS NULL OR `indicativeUnitPriceMinor` > 0),
  ADD CONSTRAINT `chk_preorder_request_reserved` CHECK (`capacityReservedBaseUnits` >= 0);

ALTER TABLE `preorder_offers`
  ADD CONSTRAINT `chk_preorder_offer_quantity` CHECK (`quantityBaseUnits` > 0),
  ADD CONSTRAINT `chk_preorder_offer_money` CHECK (`unitPriceMinor` > 0 AND `goodsTotalMinor` > 0 AND `freightMinor` >= 0);
