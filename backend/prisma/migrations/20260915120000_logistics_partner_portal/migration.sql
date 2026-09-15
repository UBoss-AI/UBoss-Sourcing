-- The Logistics Partner Portal: third-party carriers on the marketplace.
--
-- Twenty-six new tables, two new columns on `users`, one on `sessions`, and a
-- third member on the `UserType` enum. Nothing is dropped, nothing is
-- narrowed, and every added column is nullable or defaulted - so a running
-- deployment that never creates a logistics partner behaves exactly as it did
-- the day before this ran.
--
-- WHY THIS IS ONE MIGRATION AND NOT SIX
--
-- The tables are mutually dependent through foreign keys: an assignment needs
-- a shipment and a partner, a driver profile needs a partner user, a location
-- ping needs a trip, a webhook event needs an integration. Splitting them
-- would produce intermediate states where half the graph exists and the other
-- half's constraints cannot be added, and every one of those states is a
-- deploy that can fail halfway.
--
-- THE THREE CHANGES TO EXISTING TABLES
--
--   * `users.type` and `login_attempts.userType` gain LOGISTICS. A MySQL ENUM
--     widened by appending a member rewrites no row and invalidates no index;
--     every existing row stays ADMIN or CUSTOMER. This is what makes a
--     logistics partner a third AUDIENCE of the existing session machinery
--     rather than a second authentication system.
--   * `users` gains `mfaLastCounter` and `mfaRecoveryCodeHashesJson`. Both
--     NULL. The first is what stops a one-time password being a
--     thirty-second password; the second holds hashes, never codes.
--   * `sessions` gains `mfaVerifiedAt`. NULL. Per session rather than per
--     account, because `users.mfaEnabledAt` says the account HAS a second
--     factor and this says the browser in front of us has presented it.
--
-- WHAT MARIADB 10.4 FORCED
--
--   * No native UUID. Every id is a ULID in CHAR(26), like the rest of this
--     schema.
--   * A UNIQUE index treats every NULL as distinct. Three places would have
--     been silently broken by that and each carries a NOT NULL surrogate:
--     `logistics_shipment_events.externalEventKey` and `.idempotencyKey` (the
--     event's own ULID where no carrier supplied one), and
--     `carrier_webhook_events.providerEventId` (the row's own ULID). Without
--     them a redelivered webhook would write a second event and a hospital
--     would be told twice that its consignment arrived.
--   * No SKIP LOCKED. Nothing here claims work in a loop; the carrier poller
--     leases through `JobQueue`, which already solves it.
--
-- MONEY is BigInt minor units (`logistics_shipments.declaredValueMinor`), as
-- everywhere in this schema. COORDINATES are DECIMAL(9,6) and never DOUBLE,
-- for the same reason money is not a float: a stored fact has to read back
-- exactly as it was written.
--
-- ROLLBACK
--
-- This migration only ADDS. To reverse it on a deployment that has not
-- invited a partner, in this order:
--
--   1. DROP TABLE, children first:
--        logistics_location_pings, logistics_active_trips,
--        logistics_driver_assignments, logistics_dispatch_manifest_entries,
--        logistics_dispatch_manifests, logistics_pickup_requests,
--        logistics_proof_of_delivery, logistics_shipment_documents,
--        logistics_shipment_exceptions, logistics_shipment_events,
--        logistics_shipment_assignments, logistics_shipment_packages,
--        logistics_notifications, logistics_audit_logs,
--        logistics_shipments, logistics_driver_profiles,
--        logistics_vehicles, logistics_sla_policies,
--        logistics_capabilities, logistics_service_regions,
--        logistics_partner_invitations, logistics_partner_users,
--        logistics_partners, carrier_webhook_events,
--        carrier_status_mappings, carrier_integrations;
--   2. ALTER TABLE `sessions` DROP COLUMN `mfaVerifiedAt`;
--   3. ALTER TABLE `users` DROP COLUMN `mfaLastCounter`,
--        DROP COLUMN `mfaRecoveryCodeHashesJson`;
--   4. ALTER TABLE `users` MODIFY `type` ENUM('ADMIN','CUSTOMER') NOT NULL;
--      ALTER TABLE `login_attempts`
--        MODIFY `userType` ENUM('ADMIN','CUSTOMER') NOT NULL;
--
-- Step 4 fails if any LOGISTICS user row survives, which is the correct
-- behaviour: it refuses rather than silently rewriting somebody's account
-- type.

-- === ALTER (existing tables) ===

-- AlterTable
ALTER TABLE `login_attempts` MODIFY `userType` ENUM('ADMIN', 'CUSTOMER', 'LOGISTICS') NOT NULL;

-- AlterTable
ALTER TABLE `sessions` ADD COLUMN `mfaVerifiedAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `users` ADD COLUMN `mfaLastCounter` BIGINT NULL,
    ADD COLUMN `mfaRecoveryCodeHashesJson` JSON NULL,
    MODIFY `type` ENUM('ADMIN', 'CUSTOMER', 'LOGISTICS') NOT NULL;



-- === CREATE ===

-- CreateTable
CREATE TABLE `logistics_partners` (
    `id` CHAR(26) NOT NULL,
    `partnerCode` VARCHAR(32) NOT NULL,
    `legalName` VARCHAR(255) NOT NULL,
    `displayName` VARCHAR(160) NOT NULL,
    `displayNameNormalized` VARCHAR(160) NOT NULL,
    `registrationNumber` VARCHAR(64) NULL,
    `taxNumber` VARCHAR(64) NULL,
    `licenceNumber` VARCHAR(64) NULL,
    `licenceExpiresAt` DATE NULL,
    `registrationCountry` CHAR(2) NOT NULL,
    `contactEmail` VARCHAR(320) NOT NULL,
    `contactPhone` VARCHAR(32) NULL,
    `emergencyPhone` VARCHAR(32) NULL,
    `websiteUrl` VARCHAR(512) NULL,
    `addressJson` JSON NULL,
    `status` ENUM('PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED') NOT NULL DEFAULT 'PENDING_ACTIVATION',
    `contractStatus` ENUM('DRAFT', 'ACTIVE', 'EXPIRED', 'TERMINATED') NOT NULL DEFAULT 'DRAFT',
    `contractReference` VARCHAR(64) NULL,
    `contractStartsAt` DATE NULL,
    `contractEndsAt` DATE NULL,
    `suspensionReason` VARCHAR(512) NULL,
    `suspendedAt` DATETIME(3) NULL,
    `maxOpenShipments` INTEGER NULL,
    `maxDailyAssignments` INTEGER NULL,
    `autoAssignEnabled` BOOLEAN NOT NULL DEFAULT false,
    `carrierIntegrationId` CHAR(26) NULL,
    `internalNotes` TEXT NULL,
    `createdById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `archivedAt` DATETIME(3) NULL,

    UNIQUE INDEX `uq_logistics_partner_code`(`partnerCode`),
    UNIQUE INDEX `uq_logistics_partner_name`(`displayNameNormalized`),
    INDEX `ix_logistics_partner_status`(`status`, `createdAt`),
    INDEX `ix_logistics_partner_country`(`registrationCountry`),
    INDEX `ix_logistics_partner_integration`(`carrierIntegrationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_partner_users` (
    `id` CHAR(26) NOT NULL,
    `logisticsPartnerId` CHAR(26) NOT NULL,
    `userId` CHAR(26) NOT NULL,
    `role` ENUM('LOGISTICS_PARTNER_OWNER', 'LOGISTICS_PARTNER_ADMIN', 'DISPATCHER', 'DRIVER', 'OPERATIONS_AGENT', 'READ_ONLY_TRACKING_USER') NOT NULL,
    `status` ENUM('INVITED', 'ACTIVE', 'DISABLED') NOT NULL DEFAULT 'INVITED',
    `fullName` VARCHAR(160) NOT NULL,
    `jobTitle` VARCHAR(120) NULL,
    `phone` VARCHAR(32) NULL,
    `regionScopeJson` JSON NULL,
    `disabledAt` DATETIME(3) NULL,
    `disabledReason` VARCHAR(255) NULL,
    `lastActiveAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_logistics_partner_user_account`(`userId`),
    INDEX `ix_logistics_partner_user_status`(`logisticsPartnerId`, `status`),
    INDEX `ix_logistics_partner_user_role`(`logisticsPartnerId`, `role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_partner_invitations` (
    `id` CHAR(26) NOT NULL,
    `logisticsPartnerId` CHAR(26) NOT NULL,
    `email` VARCHAR(320) NOT NULL,
    `emailNormalized` VARCHAR(320) NOT NULL,
    `fullName` VARCHAR(160) NOT NULL,
    `role` ENUM('LOGISTICS_PARTNER_OWNER', 'LOGISTICS_PARTNER_ADMIN', 'DISPATCHER', 'DRIVER', 'OPERATIONS_AGENT', 'READ_ONLY_TRACKING_USER') NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `acceptedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `invitedByPartnerUserId` CHAR(26) NULL,
    `invitedByAdminUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_logistics_invitation_token`(`tokenHash`),
    INDEX `ix_logistics_invitation_email`(`logisticsPartnerId`, `emailNormalized`),
    INDEX `ix_logistics_invitation_expiry`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_service_regions` (
    `id` CHAR(26) NOT NULL,
    `logisticsPartnerId` CHAR(26) NOT NULL,
    `scope` ENUM('COUNTRY', 'STATE', 'CITY', 'POSTCODE_PREFIX') NOT NULL,
    `countryCode` CHAR(2) NOT NULL,
    `regionValue` VARCHAR(120) NOT NULL DEFAULT '',
    `supportsPickup` BOOLEAN NOT NULL DEFAULT true,
    `supportsDelivery` BOOLEAN NOT NULL DEFAULT true,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_logistics_region_country`(`countryCode`, `isActive`),
    UNIQUE INDEX `uq_logistics_region`(`logisticsPartnerId`, `scope`, `countryCode`, `regionValue`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_capabilities` (
    `id` CHAR(26) NOT NULL,
    `logisticsPartnerId` CHAR(26) NOT NULL,
    `kind` ENUM('TEMPERATURE_CONTROLLED', 'COLD_CHAIN_2_8', 'FROZEN', 'STERILE_HANDLING', 'DANGEROUS_GOODS', 'FRAGILE_HANDLING', 'OVERSIZED', 'PALLET', 'TAIL_LIFT', 'WHITE_GLOVE', 'SAME_DAY', 'NEXT_DAY', 'INTERNATIONAL', 'CUSTOMS_BROKERAGE', 'PROOF_OF_DELIVERY_PHOTO', 'PROOF_OF_DELIVERY_OTP') NOT NULL,
    `state` ENUM('REQUESTED', 'APPROVED', 'REJECTED', 'SUSPENDED') NOT NULL DEFAULT 'REQUESTED',
    `evidenceReference` VARCHAR(255) NULL,
    `evidenceExpiresAt` DATE NULL,
    `temperatureMinC` DECIMAL(5, 2) NULL,
    `temperatureMaxC` DECIMAL(5, 2) NULL,
    `decidedByUserId` CHAR(26) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_logistics_capability_kind`(`kind`, `state`),
    UNIQUE INDEX `uq_logistics_capability`(`logisticsPartnerId`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_sla_policies` (
    `id` CHAR(26) NOT NULL,
    `logisticsPartnerId` CHAR(26) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `serviceType` ENUM('STANDARD', 'EXPRESS', 'SAME_DAY', 'ECONOMY', 'FREIGHT', 'WHITE_GLOVE') NOT NULL DEFAULT 'STANDARD',
    `pickupHours` INTEGER NULL,
    `deliveryHours` INTEGER NULL,
    `riskWindowMinutes` INTEGER NOT NULL DEFAULT 120,
    `podRequiresRecipientName` BOOLEAN NOT NULL DEFAULT true,
    `podRequiresSignature` BOOLEAN NOT NULL DEFAULT false,
    `podRequiresPhoto` BOOLEAN NOT NULL DEFAULT false,
    `podRequiresOtp` BOOLEAN NOT NULL DEFAULT false,
    `podRequiresDesignation` BOOLEAN NOT NULL DEFAULT false,
    `maxDeliveryAttempts` INTEGER NOT NULL DEFAULT 3,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_logistics_sla_default`(`logisticsPartnerId`, `isDefault`),
    UNIQUE INDEX `uq_logistics_sla_policy`(`logisticsPartnerId`, `serviceType`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_shipments` (
    `id` CHAR(26) NOT NULL,
    `shipmentReference` VARCHAR(32) NOT NULL,
    `orderId` CHAR(26) NULL,
    `sellerOrderGroupId` CHAR(26) NULL,
    `operatorShipmentId` CHAR(26) NULL,
    `originLocationId` CHAR(26) NULL,
    `assignedPartnerId` CHAR(26) NULL,
    `status` ENUM('CREATED', 'AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTANCE_PENDING', 'ACCEPTED', 'PICKUP_SCHEDULED', 'READY_FOR_PICKUP', 'PICKED_UP', 'DISPATCHED', 'AT_ORIGIN_HUB', 'IN_TRANSIT', 'AT_DESTINATION_HUB', 'OUT_FOR_DELIVERY', 'DELIVERY_ATTEMPTED', 'DELIVERED', 'DELAYED', 'ON_HOLD', 'ADDRESS_ISSUE', 'CUSTOMS_HOLD', 'DAMAGED', 'TEMPERATURE_EXCEPTION', 'DELIVERY_FAILED', 'RETURN_REQUESTED', 'RETURN_IN_TRANSIT', 'RETURNED', 'LOST', 'CANCELLED') NOT NULL DEFAULT 'CREATED',
    `serviceType` ENUM('STANDARD', 'EXPRESS', 'SAME_DAY', 'ECONOMY', 'FREIGHT', 'WHITE_GLOVE') NOT NULL DEFAULT 'STANDARD',
    `trackingNumber` VARCHAR(64) NOT NULL,
    `carrierIntegrationId` CHAR(26) NULL,
    `carrierTrackingNumber` VARCHAR(128) NULL,
    `carrierTrackingUrl` VARCHAR(1024) NULL,
    `sellerAccountId` CHAR(26) NULL,
    `sellerCompanyName` VARCHAR(255) NOT NULL,
    `receivingCustomerProfileId` CHAR(26) NULL,
    `receivingCompanyName` VARCHAR(255) NOT NULL,
    `pickupAddressJson` JSON NOT NULL,
    `deliveryAddressJson` JSON NOT NULL,
    `pickupContactName` VARCHAR(160) NULL,
    `pickupContactPhone` VARCHAR(32) NULL,
    `pickupContactEmail` VARCHAR(320) NULL,
    `deliveryContactName` VARCHAR(160) NULL,
    `deliveryContactPhone` VARCHAR(32) NULL,
    `deliveryContactEmail` VARCHAR(320) NULL,
    `originCountry` CHAR(2) NOT NULL,
    `destinationCountry` CHAR(2) NOT NULL,
    `destinationCity` VARCHAR(120) NULL,
    `destinationPostalCode` VARCHAR(24) NULL,
    `distanceKm` DECIMAL(9, 2) NULL,
    `packageCount` INTEGER NOT NULL DEFAULT 1,
    `totalWeightGrams` INTEGER NOT NULL DEFAULT 0,
    `totalVolumeCm3` INTEGER NULL,
    `productCategorySummary` VARCHAR(512) NULL,
    `requiresColdChain` BOOLEAN NOT NULL DEFAULT false,
    `requiresTemperatureRange` BOOLEAN NOT NULL DEFAULT false,
    `temperatureMinC` DECIMAL(5, 2) NULL,
    `temperatureMaxC` DECIMAL(5, 2) NULL,
    `requiresSterileHandling` BOOLEAN NOT NULL DEFAULT false,
    `isFragile` BOOLEAN NOT NULL DEFAULT false,
    `isDangerousGoods` BOOLEAN NOT NULL DEFAULT false,
    `dangerousGoodsClass` VARCHAR(24) NULL,
    `handlingNotes` VARCHAR(1024) NULL,
    `declaredValueMinor` BIGINT NULL,
    `currency` CHAR(3) NULL,
    `slaPolicyId` CHAR(26) NULL,
    `expectedPickupAt` DATETIME(3) NULL,
    `pickupDueAt` DATETIME(3) NULL,
    `estimatedDeliveryAt` DATETIME(3) NULL,
    `deliveryDueAt` DATETIME(3) NULL,
    `slaState` ENUM('NOT_APPLICABLE', 'ON_TRACK', 'AT_RISK', 'BREACHED') NOT NULL DEFAULT 'NOT_APPLICABLE',
    `slaEvaluatedAt` DATETIME(3) NULL,
    `acceptedAt` DATETIME(3) NULL,
    `pickedUpAt` DATETIME(3) NULL,
    `dispatchedAt` DATETIME(3) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `deliveryAttemptCount` INTEGER NOT NULL DEFAULT 0,
    `lastEventAt` DATETIME(3) NULL,
    `lastCarrierSyncAt` DATETIME(3) NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_logistics_shipment_reference`(`shipmentReference`),
    UNIQUE INDEX `uq_logistics_shipment_tracking`(`trackingNumber`),
    INDEX `ix_logistics_shipment_partner_status`(`assignedPartnerId`, `status`, `createdAt`),
    INDEX `ix_logistics_shipment_sla`(`assignedPartnerId`, `slaState`, `deliveryDueAt`),
    INDEX `ix_logistics_shipment_pickup_due`(`assignedPartnerId`, `expectedPickupAt`),
    INDEX `ix_logistics_shipment_delivery_due`(`assignedPartnerId`, `estimatedDeliveryAt`),
    INDEX `ix_logistics_shipment_status`(`status`, `createdAt`),
    INDEX `ix_logistics_shipment_order`(`orderId`),
    INDEX `ix_logistics_shipment_seller_group`(`sellerOrderGroupId`),
    INDEX `ix_logistics_shipment_origin`(`originLocationId`),
    INDEX `ix_logistics_shipment_receiver`(`receivingCustomerProfileId`),
    INDEX `ix_logistics_shipment_seller`(`sellerAccountId`),
    INDEX `ix_logistics_shipment_destination`(`destinationCountry`, `destinationCity`),
    INDEX `ix_logistics_shipment_carrier_sync`(`carrierIntegrationId`, `lastCarrierSyncAt`),
    INDEX `ix_logistics_shipment_carrier_tracking`(`carrierIntegrationId`, `carrierTrackingNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_shipment_packages` (
    `id` CHAR(26) NOT NULL,
    `shipmentId` CHAR(26) NOT NULL,
    `packageReference` VARCHAR(64) NOT NULL,
    `sequence` INTEGER NOT NULL DEFAULT 1,
    `weightGrams` INTEGER NOT NULL DEFAULT 0,
    `lengthMm` INTEGER NULL,
    `widthMm` INTEGER NULL,
    `heightMm` INTEGER NULL,
    `packagingType` VARCHAR(64) NULL,
    `isFragile` BOOLEAN NOT NULL DEFAULT false,
    `requiresColdChain` BOOLEAN NOT NULL DEFAULT false,
    `batchReference` VARCHAR(64) NULL,
    `scannedOutAt` DATETIME(3) NULL,
    `scannedInAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_logistics_package_reference`(`packageReference`),
    INDEX `ix_logistics_package_shipment`(`shipmentId`),
    UNIQUE INDEX `uq_logistics_package_sequence`(`shipmentId`, `sequence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_shipment_assignments` (
    `id` CHAR(26) NOT NULL,
    `shipmentId` CHAR(26) NOT NULL,
    `logisticsPartnerId` CHAR(26) NOT NULL,
    `state` ENUM('OFFERED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED', 'COMPLETED') NOT NULL DEFAULT 'OFFERED',
    `assignedAutomatically` BOOLEAN NOT NULL DEFAULT false,
    `offeredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `respondBy` DATETIME(3) NULL,
    `respondedAt` DATETIME(3) NULL,
    `responseReason` VARCHAR(512) NULL,
    `withdrawnAt` DATETIME(3) NULL,
    `withdrawnReason` VARCHAR(512) NULL,
    `completedAt` DATETIME(3) NULL,
    `offeredByUserId` CHAR(26) NULL,
    `respondedByPartnerUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_logistics_assignment_authz`(`logisticsPartnerId`, `state`, `shipmentId`),
    INDEX `ix_logistics_assignment_shipment`(`shipmentId`, `state`),
    INDEX `ix_logistics_assignment_expiry`(`state`, `respondBy`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_shipment_events` (
    `id` CHAR(26) NOT NULL,
    `shipmentId` CHAR(26) NOT NULL,
    `previousStatus` ENUM('CREATED', 'AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTANCE_PENDING', 'ACCEPTED', 'PICKUP_SCHEDULED', 'READY_FOR_PICKUP', 'PICKED_UP', 'DISPATCHED', 'AT_ORIGIN_HUB', 'IN_TRANSIT', 'AT_DESTINATION_HUB', 'OUT_FOR_DELIVERY', 'DELIVERY_ATTEMPTED', 'DELIVERED', 'DELAYED', 'ON_HOLD', 'ADDRESS_ISSUE', 'CUSTOMS_HOLD', 'DAMAGED', 'TEMPERATURE_EXCEPTION', 'DELIVERY_FAILED', 'RETURN_REQUESTED', 'RETURN_IN_TRANSIT', 'RETURNED', 'LOST', 'CANCELLED') NULL,
    `status` ENUM('CREATED', 'AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTANCE_PENDING', 'ACCEPTED', 'PICKUP_SCHEDULED', 'READY_FOR_PICKUP', 'PICKED_UP', 'DISPATCHED', 'AT_ORIGIN_HUB', 'IN_TRANSIT', 'AT_DESTINATION_HUB', 'OUT_FOR_DELIVERY', 'DELIVERY_ATTEMPTED', 'DELIVERED', 'DELAYED', 'ON_HOLD', 'ADDRESS_ISSUE', 'CUSTOMS_HOLD', 'DAMAGED', 'TEMPERATURE_EXCEPTION', 'DELIVERY_FAILED', 'RETURN_REQUESTED', 'RETURN_IN_TRANSIT', 'RETURNED', 'LOST', 'CANCELLED') NOT NULL,
    `publicDescription` VARCHAR(512) NULL,
    `internalNote` TEXT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `locationLabel` VARCHAR(255) NULL,
    `locationCountry` CHAR(2) NULL,
    `locationLatitude` DECIMAL(9, 6) NULL,
    `locationLongitude` DECIMAL(9, 6) NULL,
    `source` ENUM('LOGISTICS_PORTAL', 'DRIVER_APP', 'UBOSS_ADMIN', 'CARRIER_API', 'INBOUND_WEBHOOK', 'SYSTEM_AUTOMATION') NOT NULL,
    `actorUserId` CHAR(26) NULL,
    `actorLogisticsPartnerId` CHAR(26) NULL,
    `externalEventId` VARCHAR(128) NULL,
    `externalStatusCode` VARCHAR(64) NULL,
    `carrierIntegrationId` CHAR(26) NULL,
    `externalEventKey` VARCHAR(200) NOT NULL,
    `idempotencyKey` CHAR(64) NOT NULL,
    `isCorrection` BOOLEAN NOT NULL DEFAULT false,
    `reason` VARCHAR(512) NULL,
    `exceptionId` CHAR(26) NULL,
    `documentId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_logistics_event_external`(`externalEventKey`),
    INDEX `ix_logistics_event_timeline`(`shipmentId`, `occurredAt`),
    INDEX `ix_logistics_event_recorded`(`shipmentId`, `recordedAt`),
    INDEX `ix_logistics_event_source`(`source`, `recordedAt`),
    INDEX `ix_logistics_event_carrier`(`carrierIntegrationId`, `recordedAt`),
    UNIQUE INDEX `uq_logistics_event_idempotency`(`shipmentId`, `idempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_shipment_exceptions` (
    `id` CHAR(26) NOT NULL,
    `shipmentId` CHAR(26) NOT NULL,
    `logisticsPartnerId` CHAR(26) NULL,
    `type` ENUM('PICKUP_MISSED', 'PACKAGE_NOT_READY', 'ADDRESS_INCORRECT', 'RECIPIENT_UNAVAILABLE', 'CUSTOMS_DELAY', 'WEATHER_DELAY', 'VEHICLE_BREAKDOWN', 'PRODUCT_DAMAGED', 'PACKAGE_LOST', 'TEMPERATURE_EXCURSION', 'DELIVERY_ATTEMPT_FAILED', 'DOCUMENTATION_MISSING', 'SLA_RISK', 'SLA_BREACH', 'UNMAPPED_EXTERNAL_EVENT') NOT NULL,
    `severity` ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL') NOT NULL DEFAULT 'MEDIUM',
    `state` ENUM('OPEN', 'ACKNOWLEDGED', 'IN_PROGRESS', 'ESCALATED', 'RESOLVED', 'CLOSED') NOT NULL DEFAULT 'OPEN',
    `reason` VARCHAR(512) NOT NULL,
    `detail` TEXT NULL,
    `ownerPartnerUserId` CHAR(26) NULL,
    `ownerAdminUserId` CHAR(26) NULL,
    `resolutionDueAt` DATETIME(3) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `resolutionNotes` TEXT NULL,
    `escalatedAt` DATETIME(3) NULL,
    `escalationNote` VARCHAR(512) NULL,
    `revisedEtaAt` DATETIME(3) NULL,
    `customerNotifiedAt` DATETIME(3) NULL,
    `externalPayloadJson` JSON NULL,
    `raisedByUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_logistics_exception_queue`(`logisticsPartnerId`, `state`, `severity`),
    INDEX `ix_logistics_exception_shipment`(`shipmentId`, `state`),
    INDEX `ix_logistics_exception_operator`(`state`, `severity`, `createdAt`),
    INDEX `ix_logistics_exception_due`(`state`, `resolutionDueAt`),
    INDEX `ix_logistics_exception_type`(`type`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_shipment_documents` (
    `id` CHAR(26) NOT NULL,
    `shipmentId` CHAR(26) NOT NULL,
    `kind` ENUM('SHIPPING_LABEL', 'PACKING_LIST', 'COMMERCIAL_INVOICE', 'CUSTOMS_DOCUMENT', 'DELIVERY_INSTRUCTIONS', 'PROOF_OF_DELIVERY', 'DELIVERY_SIGNATURE', 'DELIVERY_PHOTO', 'DAMAGE_EVIDENCE', 'RETURN_DOCUMENT', 'MANIFEST', 'OTHER') NOT NULL,
    `audience` ENUM('PARTNER', 'OPERATOR', 'BOTH') NOT NULL DEFAULT 'PARTNER',
    `fileName` VARCHAR(255) NOT NULL,
    `contentType` VARCHAR(128) NOT NULL,
    `sizeBytes` INTEGER NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `contentHash` CHAR(64) NULL,
    `scanState` ENUM('PENDING', 'CLEAN', 'INFECTED', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'PENDING',
    `scannedAt` DATETIME(3) NULL,
    `scanDetail` VARCHAR(255) NULL,
    `uploadedByUserId` CHAR(26) NULL,
    `uploadedBySource` ENUM('LOGISTICS_PORTAL', 'DRIVER_APP', 'UBOSS_ADMIN', 'CARRIER_API', 'INBOUND_WEBHOOK', 'SYSTEM_AUTOMATION') NOT NULL DEFAULT 'LOGISTICS_PORTAL',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deletedAt` DATETIME(3) NULL,

    INDEX `ix_logistics_document_shipment`(`shipmentId`, `kind`),
    INDEX `ix_logistics_document_scan`(`scanState`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_proof_of_delivery` (
    `id` CHAR(26) NOT NULL,
    `shipmentId` CHAR(26) NOT NULL,
    `recipientName` VARCHAR(160) NULL,
    `recipientDesignation` VARCHAR(120) NULL,
    `deliveredAt` DATETIME(3) NOT NULL,
    `deliveryLatitude` DECIMAL(9, 6) NULL,
    `deliveryLongitude` DECIMAL(9, 6) NULL,
    `deliveryLocationLabel` VARCHAR(255) NULL,
    `hasSignature` BOOLEAN NOT NULL DEFAULT false,
    `hasPhoto` BOOLEAN NOT NULL DEFAULT false,
    `otpVerified` BOOLEAN NOT NULL DEFAULT false,
    `businessStamped` BOOLEAN NOT NULL DEFAULT false,
    `signatureDocumentId` CHAR(26) NULL,
    `photoDocumentId` CHAR(26) NULL,
    `exceptionNote` VARCHAR(512) NULL,
    `capturedByPartnerUserId` CHAR(26) NULL,
    `capturedBySource` ENUM('LOGISTICS_PORTAL', 'DRIVER_APP', 'UBOSS_ADMIN', 'CARRIER_API', 'INBOUND_WEBHOOK', 'SYSTEM_AUTOMATION') NOT NULL DEFAULT 'DRIVER_APP',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_logistics_pod_shipment`(`shipmentId`),
    INDEX `ix_logistics_pod_delivered`(`deliveredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_pickup_requests` (
    `id` CHAR(26) NOT NULL,
    `logisticsPartnerId` CHAR(26) NOT NULL,
    `shipmentId` CHAR(26) NULL,
    `locationId` CHAR(26) NULL,
    `state` ENUM('REQUESTED', 'SCHEDULED', 'CONFIRMED', 'COMPLETED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'REQUESTED',
    `windowStartAt` DATETIME(3) NOT NULL,
    `windowEndAt` DATETIME(3) NOT NULL,
    `timezone` VARCHAR(64) NULL,
    `warehouseInstructions` VARCHAR(1024) NULL,
    `readinessConfirmedAt` DATETIME(3) NULL,
    `driverProfileId` CHAR(26) NULL,
    `vehicleId` CHAR(26) NULL,
    `scheduledAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `failedAt` DATETIME(3) NULL,
    `failureReason` VARCHAR(512) NULL,
    `packagesCollected` INTEGER NULL,
    `completionIdempotencyKey` VARCHAR(64) NULL,
    `createdByUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_logistics_pickup_board`(`logisticsPartnerId`, `state`, `windowStartAt`),
    INDEX `ix_logistics_pickup_shipment`(`shipmentId`),
    INDEX `ix_logistics_pickup_location`(`locationId`, `windowStartAt`),
    INDEX `ix_logistics_pickup_driver`(`driverProfileId`, `windowStartAt`),
    UNIQUE INDEX `uq_logistics_pickup_idempotency`(`logisticsPartnerId`, `completionIdempotencyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_dispatch_manifests` (
    `id` CHAR(26) NOT NULL,
    `logisticsPartnerId` CHAR(26) NOT NULL,
    `manifestNumber` VARCHAR(32) NOT NULL,
    `state` ENUM('OPEN', 'CLOSED', 'HANDED_OVER', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
    `driverProfileId` CHAR(26) NULL,
    `vehicleId` CHAR(26) NULL,
    `originLabel` VARCHAR(160) NULL,
    `destinationLabel` VARCHAR(160) NULL,
    `plannedDepartureAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `handedOverAt` DATETIME(3) NULL,
    `handoverSignedBy` VARCHAR(160) NULL,
    `notes` VARCHAR(1024) NULL,
    `createdByPartnerUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_logistics_manifest_board`(`logisticsPartnerId`, `state`, `plannedDepartureAt`),
    UNIQUE INDEX `uq_logistics_manifest_number`(`logisticsPartnerId`, `manifestNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_dispatch_manifest_entries` (
    `id` CHAR(26) NOT NULL,
    `manifestId` CHAR(26) NOT NULL,
    `shipmentId` CHAR(26) NOT NULL,
    `packageCount` INTEGER NOT NULL DEFAULT 0,
    `addedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `removedAt` DATETIME(3) NULL,

    INDEX `ix_logistics_manifest_entry_shipment`(`shipmentId`),
    UNIQUE INDEX `uq_logistics_manifest_entry`(`manifestId`, `shipmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_driver_profiles` (
    `id` CHAR(26) NOT NULL,
    `logisticsPartnerId` CHAR(26) NOT NULL,
    `partnerUserId` CHAR(26) NOT NULL,
    `state` ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED') NOT NULL DEFAULT 'ACTIVE',
    `employeeReference` VARCHAR(64) NULL,
    `licenceNumber` VARCHAR(64) NULL,
    `licenceExpiresAt` DATE NULL,
    `canCarryDangerousGoods` BOOLEAN NOT NULL DEFAULT false,
    `canCarryColdChain` BOOLEAN NOT NULL DEFAULT false,
    `canCarrySterile` BOOLEAN NOT NULL DEFAULT false,
    `regionScopeJson` JSON NULL,
    `locationConsentAt` DATETIME(3) NULL,
    `locationConsentWithdrawnAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_logistics_driver_user`(`partnerUserId`),
    INDEX `ix_logistics_driver_state`(`logisticsPartnerId`, `state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_vehicles` (
    `id` CHAR(26) NOT NULL,
    `logisticsPartnerId` CHAR(26) NOT NULL,
    `registration` VARCHAR(32) NOT NULL,
    `kind` ENUM('VAN', 'TRUCK', 'BIKE', 'CAR', 'REFRIGERATED_VAN', 'REFRIGERATED_TRUCK') NOT NULL DEFAULT 'VAN',
    `hasRefrigeration` BOOLEAN NOT NULL DEFAULT false,
    `hasTailLift` BOOLEAN NOT NULL DEFAULT false,
    `temperatureMinC` DECIMAL(5, 2) NULL,
    `temperatureMaxC` DECIMAL(5, 2) NULL,
    `maxWeightGrams` INTEGER NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_logistics_vehicle_active`(`logisticsPartnerId`, `isActive`),
    UNIQUE INDEX `uq_logistics_vehicle_registration`(`logisticsPartnerId`, `registration`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_driver_assignments` (
    `id` CHAR(26) NOT NULL,
    `shipmentId` CHAR(26) NOT NULL,
    `driverProfileId` CHAR(26) NOT NULL,
    `vehicleId` CHAR(26) NULL,
    `isPickupLeg` BOOLEAN NOT NULL DEFAULT false,
    `isDeliveryLeg` BOOLEAN NOT NULL DEFAULT true,
    `routeSequence` INTEGER NULL,
    `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `unassignedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `assignedByPartnerUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_logistics_driver_task`(`driverProfileId`, `unassignedAt`, `routeSequence`),
    INDEX `ix_logistics_driver_assignment_shipment`(`shipmentId`, `unassignedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_active_trips` (
    `id` CHAR(26) NOT NULL,
    `driverProfileId` CHAR(26) NOT NULL,
    `vehicleId` CHAR(26) NULL,
    `shipmentId` CHAR(26) NULL,
    `state` ENUM('ACTIVE', 'PAUSED', 'COMPLETED', 'ABANDONED') NOT NULL DEFAULT 'ACTIVE',
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `endedAt` DATETIME(3) NULL,
    `deviceTokenHash` CHAR(64) NOT NULL,
    `deviceTokenExpiresAt` DATETIME(3) NOT NULL,
    `pingIntervalSeconds` INTEGER NOT NULL DEFAULT 60,
    `lastLatitude` DECIMAL(9, 6) NULL,
    `lastLongitude` DECIMAL(9, 6) NULL,
    `lastAccuracyM` INTEGER NULL,
    `lastPingAt` DATETIME(3) NULL,
    `lastSequence` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_logistics_trip_device_token`(`deviceTokenHash`),
    INDEX `ix_logistics_trip_driver`(`driverProfileId`, `state`),
    INDEX `ix_logistics_trip_sweep`(`state`, `startedAt`),
    INDEX `ix_logistics_trip_shipment`(`shipmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_location_pings` (
    `id` CHAR(26) NOT NULL,
    `tripId` CHAR(26) NOT NULL,
    `driverProfileId` CHAR(26) NOT NULL,
    `driverUserId` CHAR(26) NULL,
    `latitude` DECIMAL(9, 6) NOT NULL,
    `longitude` DECIMAL(9, 6) NOT NULL,
    `accuracyM` INTEGER NULL,
    `headingDeg` INTEGER NULL,
    `speedMps` DECIMAL(6, 2) NULL,
    `deviceTimestamp` DATETIME(3) NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sequence` INTEGER NOT NULL,
    `idempotencyKey` VARCHAR(64) NOT NULL,

    INDEX `ix_logistics_ping_trip_time`(`tripId`, `deviceTimestamp`),
    INDEX `ix_logistics_ping_driver_time`(`driverProfileId`, `deviceTimestamp`),
    INDEX `ix_logistics_ping_retention`(`receivedAt`),
    UNIQUE INDEX `uq_logistics_ping_idempotency`(`tripId`, `idempotencyKey`),
    UNIQUE INDEX `uq_logistics_ping_sequence`(`tripId`, `sequence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `carrier_integrations` (
    `id` CHAR(26) NOT NULL,
    `provider` ENUM('MANUAL', 'CUSTOM', 'DHL', 'FEDEX', 'UPS') NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `state` ENUM('UNCONFIGURED', 'CONFIGURED', 'ACTIVE', 'ERROR', 'DISABLED') NOT NULL DEFAULT 'UNCONFIGURED',
    `baseUrl` VARCHAR(512) NOT NULL DEFAULT '',
    `credentialsEnc` TEXT NULL,
    `webhookSecretEnc` TEXT NULL,
    `webhookSignatureHeader` VARCHAR(64) NOT NULL DEFAULT 'x-signature',
    `webhookTimestampHeader` VARCHAR(64) NOT NULL DEFAULT 'x-timestamp',
    `webhookAlgorithm` VARCHAR(24) NOT NULL DEFAULT 'sha256',
    `webhookToleranceSeconds` INTEGER NOT NULL DEFAULT 300,
    `webhookPathToken` CHAR(32) NOT NULL,
    `pollingEnabled` BOOLEAN NOT NULL DEFAULT false,
    `pollingIntervalMinutes` INTEGER NOT NULL DEFAULT 30,
    `nextPollAt` DATETIME(3) NULL,
    `lastPollAt` DATETIME(3) NULL,
    `rateLimitPerMinute` INTEGER NOT NULL DEFAULT 60,
    `consecutiveFailures` INTEGER NOT NULL DEFAULT 0,
    `lastSuccessAt` DATETIME(3) NULL,
    `lastFailureAt` DATETIME(3) NULL,
    `lastFailureMessage` VARCHAR(512) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_carrier_integration_name`(`name`),
    UNIQUE INDEX `uq_carrier_integration_webhook_path`(`webhookPathToken`),
    INDEX `ix_carrier_integration_provider`(`provider`, `state`),
    INDEX `ix_carrier_integration_poll`(`pollingEnabled`, `nextPollAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `carrier_status_mappings` (
    `id` CHAR(26) NOT NULL,
    `carrierIntegrationId` CHAR(26) NOT NULL,
    `providerCode` VARCHAR(64) NOT NULL,
    `canonicalStatus` ENUM('CREATED', 'AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTANCE_PENDING', 'ACCEPTED', 'PICKUP_SCHEDULED', 'READY_FOR_PICKUP', 'PICKED_UP', 'DISPATCHED', 'AT_ORIGIN_HUB', 'IN_TRANSIT', 'AT_DESTINATION_HUB', 'OUT_FOR_DELIVERY', 'DELIVERY_ATTEMPTED', 'DELIVERED', 'DELAYED', 'ON_HOLD', 'ADDRESS_ISSUE', 'CUSTOMS_HOLD', 'DAMAGED', 'TEMPERATURE_EXCEPTION', 'DELIVERY_FAILED', 'RETURN_REQUESTED', 'RETURN_IN_TRANSIT', 'RETURNED', 'LOST', 'CANCELLED') NULL,
    `raisesExceptionType` ENUM('PICKUP_MISSED', 'PACKAGE_NOT_READY', 'ADDRESS_INCORRECT', 'RECIPIENT_UNAVAILABLE', 'CUSTOMS_DELAY', 'WEATHER_DELAY', 'VEHICLE_BREAKDOWN', 'PRODUCT_DAMAGED', 'PACKAGE_LOST', 'TEMPERATURE_EXCURSION', 'DELIVERY_ATTEMPT_FAILED', 'DOCUMENTATION_MISSING', 'SLA_RISK', 'SLA_BREACH', 'UNMAPPED_EXTERNAL_EVENT') NULL,
    `publicDescription` VARCHAR(255) NULL,
    `note` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_carrier_status_mapping`(`carrierIntegrationId`, `providerCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `carrier_webhook_events` (
    `id` CHAR(26) NOT NULL,
    `carrierIntegrationId` CHAR(26) NOT NULL,
    `providerEventId` VARCHAR(160) NOT NULL,
    `state` ENUM('RECEIVED', 'PROCESSED', 'FAILED', 'DEAD_LETTER', 'IGNORED') NOT NULL DEFAULT 'RECEIVED',
    `trackingNumber` VARCHAR(128) NULL,
    `shipmentId` CHAR(26) NULL,
    `providerStatusCode` VARCHAR(64) NULL,
    `resolvedStatus` ENUM('CREATED', 'AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTANCE_PENDING', 'ACCEPTED', 'PICKUP_SCHEDULED', 'READY_FOR_PICKUP', 'PICKED_UP', 'DISPATCHED', 'AT_ORIGIN_HUB', 'IN_TRANSIT', 'AT_DESTINATION_HUB', 'OUT_FOR_DELIVERY', 'DELIVERY_ATTEMPTED', 'DELIVERED', 'DELAYED', 'ON_HOLD', 'ADDRESS_ISSUE', 'CUSTOMS_HOLD', 'DAMAGED', 'TEMPERATURE_EXCEPTION', 'DELIVERY_FAILED', 'RETURN_REQUESTED', 'RETURN_IN_TRANSIT', 'RETURNED', 'LOST', 'CANCELLED') NULL,
    `payloadJson` JSON NOT NULL,
    `signatureVerified` BOOLEAN NOT NULL DEFAULT false,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `nextRetryAt` DATETIME(3) NULL,
    `lastError` VARCHAR(512) NULL,
    `processedAt` DATETIME(3) NULL,
    `deadLetteredAt` DATETIME(3) NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_carrier_webhook_retry`(`state`, `nextRetryAt`),
    INDEX `ix_carrier_webhook_recent`(`carrierIntegrationId`, `receivedAt`),
    INDEX `ix_carrier_webhook_tracking`(`trackingNumber`),
    UNIQUE INDEX `uq_carrier_webhook_event`(`carrierIntegrationId`, `providerEventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_notifications` (
    `id` CHAR(26) NOT NULL,
    `logisticsPartnerId` CHAR(26) NOT NULL,
    `partnerUserId` CHAR(26) NULL,
    `shipmentId` CHAR(26) NULL,
    `kind` ENUM('SHIPMENT_ASSIGNED', 'ASSIGNMENT_ACCEPTED', 'ASSIGNMENT_REJECTED', 'PICKUP_SCHEDULED', 'PICKUP_COMPLETED', 'SHIPMENT_DISPATCHED', 'SHIPMENT_IN_TRANSIT', 'OUT_FOR_DELIVERY', 'SHIPMENT_DELIVERED', 'DELIVERY_ATTEMPTED', 'SHIPMENT_DELAYED', 'EXCEPTION_RAISED', 'SLA_AT_RISK', 'SLA_BREACHED', 'POD_AVAILABLE', 'RETURN_INITIATED', 'INTEGRATION_FAILURE', 'USER_INVITED', 'SECURITY_EVENT') NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `body` VARCHAR(1000) NULL,
    `variablesJson` JSON NULL,
    `dedupeKey` VARCHAR(120) NOT NULL,
    `readAt` DATETIME(3) NULL,
    `emailedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_logistics_notification_feed`(`logisticsPartnerId`, `readAt`, `createdAt`),
    INDEX `ix_logistics_notification_user`(`partnerUserId`, `readAt`),
    UNIQUE INDEX `uq_logistics_notification_dedupe`(`logisticsPartnerId`, `kind`, `dedupeKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `logistics_audit_logs` (
    `id` CHAR(26) NOT NULL,
    `logisticsPartnerId` CHAR(26) NOT NULL,
    `actorUserId` CHAR(26) NULL,
    `actorLabel` VARCHAR(160) NOT NULL,
    `action` VARCHAR(64) NOT NULL,
    `resourceType` VARCHAR(48) NOT NULL,
    `resourceId` CHAR(26) NULL,
    `beforeJson` JSON NULL,
    `afterJson` JSON NULL,
    `summary` VARCHAR(512) NULL,
    `isContactReveal` BOOLEAN NOT NULL DEFAULT false,
    `ipAddress` VARCHAR(45) NULL,
    `correlationId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_logistics_audit_time`(`logisticsPartnerId`, `createdAt`),
    INDEX `ix_logistics_audit_action`(`logisticsPartnerId`, `action`),
    INDEX `ix_logistics_audit_reveal`(`logisticsPartnerId`, `isContactReveal`, `createdAt`),
    INDEX `ix_logistics_audit_resource`(`resourceType`, `resourceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;



-- === FOREIGN KEYS ===

-- AddForeignKey
ALTER TABLE `logistics_partners` ADD CONSTRAINT `logistics_partners_carrierIntegrationId_fkey` FOREIGN KEY (`carrierIntegrationId`) REFERENCES `carrier_integrations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_partner_users` ADD CONSTRAINT `logistics_partner_users_logisticsPartnerId_fkey` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_partner_users` ADD CONSTRAINT `logistics_partner_users_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_partner_invitations` ADD CONSTRAINT `logistics_partner_invitations_logisticsPartnerId_fkey` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_partner_invitations` ADD CONSTRAINT `logistics_partner_invitations_invitedByPartnerUserId_fkey` FOREIGN KEY (`invitedByPartnerUserId`) REFERENCES `logistics_partner_users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_service_regions` ADD CONSTRAINT `logistics_service_regions_logisticsPartnerId_fkey` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_capabilities` ADD CONSTRAINT `logistics_capabilities_logisticsPartnerId_fkey` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_sla_policies` ADD CONSTRAINT `logistics_sla_policies_logisticsPartnerId_fkey` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_shipments` ADD CONSTRAINT `logistics_shipments_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_shipments` ADD CONSTRAINT `logistics_shipments_sellerOrderGroupId_fkey` FOREIGN KEY (`sellerOrderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_shipments` ADD CONSTRAINT `logistics_shipments_originLocationId_fkey` FOREIGN KEY (`originLocationId`) REFERENCES `inventory_locations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_shipments` ADD CONSTRAINT `logistics_shipments_assignedPartnerId_fkey` FOREIGN KEY (`assignedPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_shipments` ADD CONSTRAINT `logistics_shipments_slaPolicyId_fkey` FOREIGN KEY (`slaPolicyId`) REFERENCES `logistics_sla_policies`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_shipments` ADD CONSTRAINT `logistics_shipments_carrierIntegrationId_fkey` FOREIGN KEY (`carrierIntegrationId`) REFERENCES `carrier_integrations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_shipment_packages` ADD CONSTRAINT `logistics_shipment_packages_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `logistics_shipments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_shipment_assignments` ADD CONSTRAINT `logistics_shipment_assignments_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `logistics_shipments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_shipment_assignments` ADD CONSTRAINT `logistics_shipment_assignments_logisticsPartnerId_fkey` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_shipment_events` ADD CONSTRAINT `logistics_shipment_events_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `logistics_shipments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_shipment_exceptions` ADD CONSTRAINT `logistics_shipment_exceptions_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `logistics_shipments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_shipment_exceptions` ADD CONSTRAINT `logistics_shipment_exceptions_logisticsPartnerId_fkey` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_shipment_documents` ADD CONSTRAINT `logistics_shipment_documents_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `logistics_shipments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_proof_of_delivery` ADD CONSTRAINT `logistics_proof_of_delivery_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `logistics_shipments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_pickup_requests` ADD CONSTRAINT `logistics_pickup_requests_logisticsPartnerId_fkey` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_pickup_requests` ADD CONSTRAINT `logistics_pickup_requests_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `logistics_shipments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_pickup_requests` ADD CONSTRAINT `logistics_pickup_requests_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `inventory_locations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_pickup_requests` ADD CONSTRAINT `logistics_pickup_requests_driverProfileId_fkey` FOREIGN KEY (`driverProfileId`) REFERENCES `logistics_driver_profiles`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_pickup_requests` ADD CONSTRAINT `logistics_pickup_requests_vehicleId_fkey` FOREIGN KEY (`vehicleId`) REFERENCES `logistics_vehicles`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_dispatch_manifests` ADD CONSTRAINT `logistics_dispatch_manifests_logisticsPartnerId_fkey` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_dispatch_manifests` ADD CONSTRAINT `logistics_dispatch_manifests_driverProfileId_fkey` FOREIGN KEY (`driverProfileId`) REFERENCES `logistics_driver_profiles`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_dispatch_manifests` ADD CONSTRAINT `logistics_dispatch_manifests_vehicleId_fkey` FOREIGN KEY (`vehicleId`) REFERENCES `logistics_vehicles`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_dispatch_manifest_entries` ADD CONSTRAINT `logistics_dispatch_manifest_entries_manifestId_fkey` FOREIGN KEY (`manifestId`) REFERENCES `logistics_dispatch_manifests`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_dispatch_manifest_entries` ADD CONSTRAINT `logistics_dispatch_manifest_entries_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `logistics_shipments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_driver_profiles` ADD CONSTRAINT `logistics_driver_profiles_logisticsPartnerId_fkey` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_driver_profiles` ADD CONSTRAINT `logistics_driver_profiles_partnerUserId_fkey` FOREIGN KEY (`partnerUserId`) REFERENCES `logistics_partner_users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_vehicles` ADD CONSTRAINT `logistics_vehicles_logisticsPartnerId_fkey` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_driver_assignments` ADD CONSTRAINT `logistics_driver_assignments_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `logistics_shipments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_driver_assignments` ADD CONSTRAINT `logistics_driver_assignments_driverProfileId_fkey` FOREIGN KEY (`driverProfileId`) REFERENCES `logistics_driver_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_driver_assignments` ADD CONSTRAINT `logistics_driver_assignments_vehicleId_fkey` FOREIGN KEY (`vehicleId`) REFERENCES `logistics_vehicles`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_active_trips` ADD CONSTRAINT `logistics_active_trips_driverProfileId_fkey` FOREIGN KEY (`driverProfileId`) REFERENCES `logistics_driver_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_active_trips` ADD CONSTRAINT `logistics_active_trips_vehicleId_fkey` FOREIGN KEY (`vehicleId`) REFERENCES `logistics_vehicles`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_active_trips` ADD CONSTRAINT `logistics_active_trips_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `logistics_shipments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_location_pings` ADD CONSTRAINT `logistics_location_pings_tripId_fkey` FOREIGN KEY (`tripId`) REFERENCES `logistics_active_trips`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_location_pings` ADD CONSTRAINT `logistics_location_pings_driverProfileId_fkey` FOREIGN KEY (`driverProfileId`) REFERENCES `logistics_driver_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_location_pings` ADD CONSTRAINT `logistics_location_pings_driverUserId_fkey` FOREIGN KEY (`driverUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `carrier_status_mappings` ADD CONSTRAINT `carrier_status_mappings_carrierIntegrationId_fkey` FOREIGN KEY (`carrierIntegrationId`) REFERENCES `carrier_integrations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `carrier_webhook_events` ADD CONSTRAINT `carrier_webhook_events_carrierIntegrationId_fkey` FOREIGN KEY (`carrierIntegrationId`) REFERENCES `carrier_integrations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_notifications` ADD CONSTRAINT `logistics_notifications_logisticsPartnerId_fkey` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_notifications` ADD CONSTRAINT `logistics_notifications_partnerUserId_fkey` FOREIGN KEY (`partnerUserId`) REFERENCES `logistics_partner_users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_notifications` ADD CONSTRAINT `logistics_notifications_shipmentId_fkey` FOREIGN KEY (`shipmentId`) REFERENCES `logistics_shipments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_audit_logs` ADD CONSTRAINT `logistics_audit_logs_logisticsPartnerId_fkey` FOREIGN KEY (`logisticsPartnerId`) REFERENCES `logistics_partners`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `logistics_audit_logs` ADD CONSTRAINT `logistics_audit_logs_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

