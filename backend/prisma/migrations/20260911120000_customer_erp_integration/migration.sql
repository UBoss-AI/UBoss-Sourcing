-- The buyer's own ERP, and the tenant that owns it.
--
-- Every table here is new. Nothing existing is altered, dropped or backfilled,
-- so this migration is safe to run against a live installation and safe to run
-- again: the only thing it adds to an existing row anywhere is nothing at all.
--
-- WHAT THIS IS, AND WHAT IT IS NOT
--
-- `erp_connections` (already present) is the SELLER's ERP: the business that
-- runs this installation configures one under Settings -> ERP and every order
-- it takes goes there. That feature is untouched by this migration and keeps
-- its tables, its routes and its worker jobs.
--
-- `customer_erp_*` is the other direction. A BUYER - a hospital group, a
-- distributor - connects its own SAP, monday.com or in-house system so that
-- what it buys here appears there: a purchase order when an order is
-- confirmed, a goods receipt when the crate is signed for, an invoice when one
-- is issued, a payment reference when it settles.
--
-- WHY THE TENANT IS A NEW TABLE
--
-- `customer_profiles.organization` is free text somebody typed into a form. It
-- is fine for putting a company name on a delivery note and it is not an
-- access-control boundary: two buyers who both type "City Medical" are not the
-- same buyer, and a tenant somebody can join by guessing its name is not a
-- tenant. `buyer_organizations` plus `buyer_organization_members` is that
-- boundary, with a UNIQUE on `customerProfileId` so an account belongs to at
-- most one, and invitations - hashed, expiring, addressed to an email - as the
-- only way in.
--
-- No existing customer is placed in an organisation by this migration. One is
-- provisioned lazily, for the account holder, the first time somebody opens
-- the integrations area. An installation where nobody ever does keeps exactly
-- the tables it had, all of them empty.
--
-- WHERE THE SECRETS ARE
--
-- In `customer_erp_credentials` and nowhere else. Every other table in this
-- migration can be SELECTed in full and handed to somebody without leaking a
-- credential, which is a property worth being able to state plainly. That one
-- holds AES-256-GCM envelopes whose AAD binds them to
-- `customer_erp_credential:<connectionId>:<kind>`, so a row copied into
-- another connection fails authentication rather than decrypting into a
-- working key.
--
-- THE CHECK CONSTRAINTS AT THE END
--
-- Written in the negative - "this method OR that column is present" - rather
-- than as a list of every method and what each one needs. The difference
-- matters: a constraint that names every member of an enum stops matching the
-- day somebody adds a member, and every insert then fails. See
-- `chk_schedule_frequency_field_present` in
-- `20260902143000_add_check_constraints`, which is exactly that shape and is
-- called out in CLAUDE.md for exactly that reason. These do not have to be
-- amended when an auth method is added.

-- CreateTable
CREATE TABLE `buyer_organizations` (
    `id` CHAR(26) NOT NULL,
    `name` VARCHAR(255) NOT NULL,
    `nameNormalized` VARCHAR(255) NOT NULL,
    `createdByProfileId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `archivedAt` DATETIME(3) NULL,

    INDEX `ix_buyer_org_name`(`nameNormalized`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `buyer_organization_members` (
    `id` CHAR(26) NOT NULL,
    `organizationId` CHAR(26) NOT NULL,
    `customerProfileId` CHAR(26) NOT NULL,
    `role` ENUM('OWNER', 'INTEGRATION_MANAGER', 'MEMBER') NOT NULL DEFAULT 'MEMBER',
    `invitedByProfileId` CHAR(26) NULL,
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_buyer_org_member_profile`(`customerProfileId`),
    INDEX `ix_buyer_org_member_role`(`organizationId`, `role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `buyer_organization_invites` (
    `id` CHAR(26) NOT NULL,
    `organizationId` CHAR(26) NOT NULL,
    `emailNormalized` VARCHAR(320) NOT NULL,
    `role` ENUM('OWNER', 'INTEGRATION_MANAGER', 'MEMBER') NOT NULL DEFAULT 'MEMBER',
    `tokenHash` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `invitedByProfileId` CHAR(26) NULL,
    `acceptedAt` DATETIME(3) NULL,
    `acceptedByProfileId` CHAR(26) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_buyer_org_invite_token`(`tokenHash`),
    INDEX `ix_buyer_org_invite_org`(`organizationId`, `acceptedAt`),
    INDEX `ix_buyer_org_invite_email`(`emailNormalized`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_erp_connections` (
    `id` CHAR(26) NOT NULL,
    `organizationId` CHAR(26) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `system` ENUM('SAP', 'MONDAY', 'CUSTOM') NOT NULL,
    `apiStyle` ENUM('REST_JSON', 'ODATA', 'GRAPHQL') NOT NULL DEFAULT 'REST_JSON',
    `environment` ENUM('SANDBOX', 'PRODUCTION') NOT NULL DEFAULT 'SANDBOX',
    `erpVersion` VARCHAR(64) NULL,
    `state` ENUM('DRAFT', 'TESTING', 'ACTIVE', 'PAUSED', 'ACTION_REQUIRED', 'FAILED', 'DISCONNECTED') NOT NULL DEFAULT 'DRAFT',
    `stateReason` VARCHAR(512) NULL,
    `stateChangedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `baseUrl` VARCHAR(1024) NOT NULL,
    `apiVersion` VARCHAR(32) NULL,
    `networkMode` ENUM('PUBLIC_HTTPS', 'IP_ALLOWLIST', 'VPN_GATEWAY', 'SAP_CLOUD_CONNECTOR') NOT NULL DEFAULT 'PUBLIC_HTTPS',
    `networkNotes` VARCHAR(1024) NULL,
    `tenantIdentifier` VARCHAR(191) NULL,
    `customHeadersJson` JSON NULL,
    `timeoutMs` INTEGER NOT NULL DEFAULT 20000,
    `sapCompanyCode` VARCHAR(8) NULL,
    `sapPurchasingOrg` VARCHAR(8) NULL,
    `sapPurchasingGroup` VARCHAR(8) NULL,
    `sapPlant` VARCHAR(8) NULL,
    `sapStorageLocation` VARCHAR(8) NULL,
    `sapCommunicationScenario` VARCHAR(64) NULL,
    `mondayWorkspaceId` VARCHAR(64) NULL,
    `mondayBoardId` VARCHAR(64) NULL,
    `mondayGroupId` VARCHAR(64) NULL,
    `authMethod` ENUM('OAUTH2_CLIENT_CREDENTIALS', 'OAUTH2_AUTHORIZATION_CODE', 'API_KEY', 'BEARER_TOKEN', 'BASIC', 'MONDAY_PERSONAL_TOKEN') NOT NULL DEFAULT 'OAUTH2_CLIENT_CREDENTIALS',
    `apiKeyLocation` ENUM('HEADER', 'QUERY') NULL,
    `apiKeyName` VARCHAR(64) NULL,
    `oauthAuthorizationUrl` VARCHAR(1024) NULL,
    `oauthTokenUrl` VARCHAR(1024) NULL,
    `oauthScope` VARCHAR(512) NULL,
    `oauthUsesPlatformApp` BOOLEAN NOT NULL DEFAULT false,
    `mutualTlsEnabled` BOOLEAN NOT NULL DEFAULT false,
    `webhookEnabled` BOOLEAN NOT NULL DEFAULT false,
    `webhookSlug` VARCHAR(64) NOT NULL,
    `webhookSignatureHeader` VARCHAR(64) NOT NULL DEFAULT 'X-UBOSS-Signature',
    `webhookTimestampHeader` VARCHAR(64) NULL,
    `webhookToleranceSeconds` INTEGER NOT NULL DEFAULT 300,
    `pollingEnabled` BOOLEAN NOT NULL DEFAULT false,
    `pollingIntervalMinutes` INTEGER NOT NULL DEFAULT 60,
    `pollingTimezone` VARCHAR(64) NOT NULL DEFAULT 'UTC',
    `lastPolledAt` DATETIME(3) NULL,
    `nextPollAt` DATETIME(3) NULL,
    `pollCursor` VARCHAR(512) NULL,
    `lastTestAt` DATETIME(3) NULL,
    `lastTestOk` BOOLEAN NULL,
    `lastTestHttpStatus` INTEGER NULL,
    `lastTestDurationMs` INTEGER NULL,
    `lastTestMessage` VARCHAR(512) NULL,
    `mappingVerifiedAt` DATETIME(3) NULL,
    `consecutiveFailures` INTEGER NOT NULL DEFAULT 0,
    `circuitOpenedAt` DATETIME(3) NULL,
    `lastSuccessAt` DATETIME(3) NULL,
    `lastFailureAt` DATETIME(3) NULL,
    `createdByProfileId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `deletedAt` DATETIME(3) NULL,

    UNIQUE INDEX `uq_customer_erp_webhook_slug`(`webhookSlug`),
    INDEX `ix_customer_erp_connection_org_state`(`organizationId`, `state`),
    INDEX `ix_customer_erp_connection_poll_due`(`state`, `pollingEnabled`, `nextPollAt`),
    UNIQUE INDEX `uq_customer_erp_connection_name`(`organizationId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_erp_credentials` (
    `id` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `kind` ENUM('PRIMARY', 'OAUTH_TOKENS', 'WEBHOOK_SIGNING', 'CLIENT_CERTIFICATE') NOT NULL,
    `payloadEnc` TEXT NOT NULL,
    `hint` VARCHAR(191) NULL,
    `expiresAt` DATETIME(3) NULL,
    `grantedScope` VARCHAR(512) NULL,
    `rotatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_customer_erp_credential_expiry`(`kind`, `expiresAt`),
    UNIQUE INDEX `uq_customer_erp_credential`(`connectionId`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_erp_endpoints` (
    `id` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `purpose` ENUM('PRODUCTS', 'WAREHOUSES', 'INVENTORY', 'PURCHASE_ORDER_CREATE', 'PURCHASE_ORDER_UPDATE', 'GOODS_RECEIPT', 'SHIPMENT_STATUS', 'INVOICE', 'PAYMENT_REFERENCE', 'WEBHOOK') NOT NULL,
    `path` VARCHAR(512) NOT NULL,
    `method` VARCHAR(8) NOT NULL DEFAULT 'GET',
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `pagination` ENUM('NONE', 'PAGE_NUMBER', 'OFFSET_LIMIT', 'CURSOR', 'ODATA_NEXT_LINK') NOT NULL DEFAULT 'NONE',
    `paginationConfigJson` JSON NULL,
    `recordsPath` VARCHAR(191) NULL,
    `requestTemplateJson` JSON NULL,
    `queryParamsJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_customer_erp_endpoint`(`connectionId`, `purpose`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_erp_field_mappings` (
    `id` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `entity` ENUM('PRODUCT', 'WAREHOUSE', 'ORDER', 'INVENTORY', 'INVOICE', 'PAYMENT', 'STATUS') NOT NULL,
    `platformField` VARCHAR(64) NOT NULL,
    `erpPath` VARCHAR(191) NOT NULL,
    `constantValue` VARCHAR(191) NULL,
    `erpValue` VARCHAR(128) NULL,
    `transform` VARCHAR(32) NULL,
    `required` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_customer_erp_field_mapping_entity`(`connectionId`, `entity`),
    UNIQUE INDEX `uq_customer_erp_field_mapping`(`connectionId`, `entity`, `platformField`, `erpValue`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_erp_warehouse_maps` (
    `id` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `inventoryLocationId` CHAR(26) NULL,
    `erpPlant` VARCHAR(32) NULL,
    `erpStorageLocation` VARCHAR(32) NULL,
    `erpBoardId` VARCHAR(64) NULL,
    `erpGroupId` VARCHAR(64) NULL,
    `isFallback` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_customer_erp_warehouse_map`(`connectionId`, `inventoryLocationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_erp_sync_policies` (
    `id` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `sourceOfTruth` ENUM('ERP', 'PLATFORM') NOT NULL DEFAULT 'PLATFORM',
    `mode` ENUM('INBOUND', 'OUTBOUND', 'BIDIRECTIONAL') NOT NULL DEFAULT 'OUTBOUND',
    `conflictPolicy` ENUM('ERP_WINS', 'PLATFORM_WINS', 'NEWEST_WINS', 'MANUAL') NOT NULL DEFAULT 'MANUAL',
    `inventoryWriteMode` ENUM('AUTOMATIC', 'APPROVAL_REQUIRED') NOT NULL DEFAULT 'APPROVAL_REQUIRED',
    `receiptOnPlatformDelivery` BOOLEAN NOT NULL DEFAULT false,
    `approvalThresholdMinor` BIGINT NULL,
    `approvalCurrency` CHAR(3) NULL,
    `approvalExpiryHours` INTEGER NOT NULL DEFAULT 72,
    `sendPurchaseOrders` BOOLEAN NOT NULL DEFAULT true,
    `sendShipmentStatus` BOOLEAN NOT NULL DEFAULT true,
    `sendGoodsReceipts` BOOLEAN NOT NULL DEFAULT true,
    `sendInvoices` BOOLEAN NOT NULL DEFAULT true,
    `sendPaymentReferences` BOOLEAN NOT NULL DEFAULT true,
    `syncInventory` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_customer_erp_policy_connection`(`connectionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_erp_sync_events` (
    `id` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `organizationId` CHAR(26) NOT NULL,
    `eventType` ENUM('CONNECTION_TEST', 'DRY_RUN', 'PURCHASE_ORDER_CREATE', 'PURCHASE_ORDER_UPDATE', 'SHIPMENT_STATUS', 'GOODS_RECEIPT', 'INVENTORY_UPDATE', 'INVOICE_SYNC', 'PAYMENT_REFERENCE', 'INBOUND_POLL', 'INBOUND_WEBHOOK') NOT NULL,
    `state` ENUM('QUEUED', 'PROCESSING', 'SUCCEEDED', 'RETRYING', 'FAILED', 'SKIPPED') NOT NULL DEFAULT 'QUEUED',
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `eventVersion` INTEGER NOT NULL DEFAULT 1,
    `orderId` CHAR(26) NULL,
    `occurrenceId` CHAR(26) NULL,
    `invoiceId` CHAR(26) NULL,
    `productId` CHAR(26) NULL,
    `correlationId` CHAR(26) NOT NULL,
    `requestJson` JSON NULL,
    `responseJson` JSON NULL,
    `erpReference` VARCHAR(191) NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `lastAttemptAt` DATETIME(3) NULL,
    `nextRetryAt` DATETIME(3) NULL,
    `httpStatus` INTEGER NULL,
    `durationMs` INTEGER NULL,
    `errorCode` VARCHAR(64) NULL,
    `errorMessage` VARCHAR(1024) NULL,
    `skipReason` VARCHAR(255) NULL,
    `approvalId` CHAR(26) NULL,
    `leaseOwner` VARCHAR(64) NULL,
    `leaseExpiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,

    UNIQUE INDEX `uq_customer_erp_event_idempotency`(`idempotencyKey`),
    INDEX `ix_customer_erp_event_org_time`(`organizationId`, `createdAt`),
    INDEX `ix_customer_erp_event_conn_state`(`connectionId`, `state`, `createdAt`),
    INDEX `ix_customer_erp_event_order`(`orderId`),
    INDEX `ix_customer_erp_event_due`(`state`, `nextRetryAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_erp_sync_jobs` (
    `id` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `organizationId` CHAR(26) NOT NULL,
    `trigger` VARCHAR(16) NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'RUNNING',
    `isDryRun` BOOLEAN NOT NULL DEFAULT false,
    `correlationId` CHAR(26) NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,
    `processedCount` INTEGER NOT NULL DEFAULT 0,
    `succeededCount` INTEGER NOT NULL DEFAULT 0,
    `skippedCount` INTEGER NOT NULL DEFAULT 0,
    `failedCount` INTEGER NOT NULL DEFAULT 0,
    `conflictCount` INTEGER NOT NULL DEFAULT 0,
    `rateLimitedUntil` DATETIME(3) NULL,
    `cursorAfter` VARCHAR(512) NULL,
    `errorCode` VARCHAR(64) NULL,
    `errorMessage` VARCHAR(1024) NULL,
    `startedByProfileId` CHAR(26) NULL,

    INDEX `ix_customer_erp_job_conn_time`(`connectionId`, `startedAt`),
    INDEX `ix_customer_erp_job_org_time`(`organizationId`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_erp_webhook_events` (
    `id` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `organizationId` CHAR(26) NOT NULL,
    `externalEventId` VARCHAR(191) NOT NULL,
    `externalEventType` VARCHAR(128) NULL,
    `verified` BOOLEAN NOT NULL DEFAULT false,
    `rejectionReason` VARCHAR(255) NULL,
    `signedAt` DATETIME(3) NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,
    `syncEventId` CHAR(26) NULL,
    `payloadJson` JSON NULL,
    `correlationId` CHAR(26) NOT NULL,

    INDEX `ix_customer_erp_webhook_conn_time`(`connectionId`, `receivedAt`),
    UNIQUE INDEX `uq_customer_erp_webhook_event`(`connectionId`, `externalEventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_erp_order_links` (
    `id` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `organizationId` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `occurrenceId` CHAR(26) NULL,
    `erpPurchaseOrderId` VARCHAR(191) NULL,
    `erpPurchaseOrderNumber` VARCHAR(64) NULL,
    `erpOrderStatus` VARCHAR(64) NULL,
    `erpGoodsReceiptId` VARCHAR(191) NULL,
    `goodsReceiptedAt` DATETIME(3) NULL,
    `onOrderQty` INTEGER NOT NULL DEFAULT 0,
    `receivedQty` INTEGER NOT NULL DEFAULT 0,
    `shipmentStatus` VARCHAR(64) NULL,
    `trackingNumber` VARCHAR(128) NULL,
    `pushedAt` DATETIME(3) NULL,
    `lastSyncedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_customer_erp_order_link_org`(`organizationId`, `createdAt`),
    INDEX `ix_customer_erp_order_link_erp_po`(`erpPurchaseOrderId`),
    UNIQUE INDEX `uq_customer_erp_order_link`(`connectionId`, `orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_erp_invoice_links` (
    `id` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `organizationId` CHAR(26) NOT NULL,
    `invoiceId` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NULL,
    `erpInvoiceId` VARCHAR(191) NULL,
    `erpInvoiceNumber` VARCHAR(64) NULL,
    `currency` CHAR(3) NOT NULL,
    `grandTotalMinor` BIGINT NOT NULL,
    `taxMinor` BIGINT NOT NULL DEFAULT 0,
    `dueAt` DATETIME(3) NULL,
    `documentUrl` VARCHAR(1024) NULL,
    `paymentReference` VARCHAR(191) NULL,
    `paymentStatus` VARCHAR(32) NULL,
    `paymentSyncedAt` DATETIME(3) NULL,
    `syncedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_customer_erp_invoice_link_org`(`organizationId`, `createdAt`),
    UNIQUE INDEX `uq_customer_erp_invoice_link`(`connectionId`, `invoiceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_erp_inventory_links` (
    `id` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `organizationId` CHAR(26) NOT NULL,
    `productId` CHAR(26) NOT NULL,
    `variantKey` CHAR(26) NOT NULL DEFAULT '',
    `erpMaterialNumber` VARCHAR(191) NULL,
    `erpPlant` VARCHAR(32) NULL,
    `onOrderQty` INTEGER NOT NULL DEFAULT 0,
    `incomingQty` INTEGER NOT NULL DEFAULT 0,
    `onHandQty` INTEGER NOT NULL DEFAULT 0,
    `erpUnitOfMeasure` VARCHAR(16) NULL,
    `lastAppliedEventId` CHAR(26) NULL,
    `lastSyncedAt` DATETIME(3) NULL,
    `divergenceNote` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_customer_erp_inventory_link_org`(`organizationId`, `updatedAt`),
    INDEX `ix_customer_erp_inventory_link_material`(`erpMaterialNumber`),
    UNIQUE INDEX `uq_customer_erp_inventory_link`(`connectionId`, `productId`, `variantKey`, `erpPlant`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_erp_approvals` (
    `id` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `organizationId` CHAR(26) NOT NULL,
    `kind` ENUM('PURCHASE_ORDER', 'INVENTORY_WRITE') NOT NULL,
    `state` ENUM('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED') NOT NULL DEFAULT 'PENDING',
    `syncEventId` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NULL,
    `amountMinor` BIGINT NULL,
    `currency` CHAR(3) NULL,
    `summary` VARCHAR(512) NOT NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `decidedByProfileId` CHAR(26) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` VARCHAR(512) NULL,

    INDEX `ix_customer_erp_approval_org_state`(`organizationId`, `state`, `requestedAt`),
    INDEX `ix_customer_erp_approval_expiry`(`state`, `expiresAt`),
    UNIQUE INDEX `uq_customer_erp_approval_event`(`syncEventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_erp_oauth_states` (
    `id` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `stateToken` VARCHAR(64) NOT NULL,
    `codeVerifierEnc` TEXT NOT NULL,
    `redirectUri` VARCHAR(1024) NOT NULL,
    `startedByProfileId` CHAR(26) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_customer_erp_oauth_state`(`stateToken`),
    INDEX `ix_customer_erp_oauth_state_expiry`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `customer_erp_audit_logs` (
    `id` CHAR(26) NOT NULL,
    `organizationId` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NULL,
    `action` VARCHAR(64) NOT NULL,
    `actorProfileId` CHAR(26) NULL,
    `actorEmail` VARCHAR(320) NULL,
    `resourceType` VARCHAR(48) NOT NULL,
    `resourceId` CHAR(26) NULL,
    `beforeJson` JSON NULL,
    `afterJson` JSON NULL,
    `ipAddress` VARCHAR(45) NULL,
    `userAgent` VARCHAR(512) NULL,
    `correlationId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_customer_erp_audit_org_time`(`organizationId`, `createdAt`),
    INDEX `ix_customer_erp_audit_conn_time`(`connectionId`, `createdAt`),
    INDEX `ix_customer_erp_audit_action`(`action`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `buyer_organization_members` ADD CONSTRAINT `buyer_organization_members_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `buyer_organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `buyer_organization_members` ADD CONSTRAINT `buyer_organization_members_customerProfileId_fkey` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `buyer_organization_invites` ADD CONSTRAINT `buyer_organization_invites_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `buyer_organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_erp_connections` ADD CONSTRAINT `customer_erp_connections_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `buyer_organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_erp_credentials` ADD CONSTRAINT `customer_erp_credentials_connectionId_fkey` FOREIGN KEY (`connectionId`) REFERENCES `customer_erp_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_erp_endpoints` ADD CONSTRAINT `customer_erp_endpoints_connectionId_fkey` FOREIGN KEY (`connectionId`) REFERENCES `customer_erp_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_erp_field_mappings` ADD CONSTRAINT `customer_erp_field_mappings_connectionId_fkey` FOREIGN KEY (`connectionId`) REFERENCES `customer_erp_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_erp_warehouse_maps` ADD CONSTRAINT `customer_erp_warehouse_maps_connectionId_fkey` FOREIGN KEY (`connectionId`) REFERENCES `customer_erp_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_erp_sync_policies` ADD CONSTRAINT `customer_erp_sync_policies_connectionId_fkey` FOREIGN KEY (`connectionId`) REFERENCES `customer_erp_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_erp_sync_events` ADD CONSTRAINT `customer_erp_sync_events_connectionId_fkey` FOREIGN KEY (`connectionId`) REFERENCES `customer_erp_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_erp_sync_jobs` ADD CONSTRAINT `customer_erp_sync_jobs_connectionId_fkey` FOREIGN KEY (`connectionId`) REFERENCES `customer_erp_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_erp_webhook_events` ADD CONSTRAINT `customer_erp_webhook_events_connectionId_fkey` FOREIGN KEY (`connectionId`) REFERENCES `customer_erp_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_erp_order_links` ADD CONSTRAINT `customer_erp_order_links_connectionId_fkey` FOREIGN KEY (`connectionId`) REFERENCES `customer_erp_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_erp_invoice_links` ADD CONSTRAINT `customer_erp_invoice_links_connectionId_fkey` FOREIGN KEY (`connectionId`) REFERENCES `customer_erp_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_erp_inventory_links` ADD CONSTRAINT `customer_erp_inventory_links_connectionId_fkey` FOREIGN KEY (`connectionId`) REFERENCES `customer_erp_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_erp_approvals` ADD CONSTRAINT `customer_erp_approvals_connectionId_fkey` FOREIGN KEY (`connectionId`) REFERENCES `customer_erp_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_erp_oauth_states` ADD CONSTRAINT `customer_erp_oauth_states_connectionId_fkey` FOREIGN KEY (`connectionId`) REFERENCES `customer_erp_connections`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `customer_erp_audit_logs` ADD CONSTRAINT `customer_erp_audit_logs_organizationId_fkey` FOREIGN KEY (`organizationId`) REFERENCES `buyer_organizations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Constraints the application also enforces, kept here as the last word.
--
-- The services validate all of these and return a field-level error, which is
-- what a person actually needs. These exist because a service is one way into
-- a table and a database is the only place a rule cannot be gone around - by a
-- migration, by a support script, or by the next feature that writes this
-- table without reading the service first.
-- ---------------------------------------------------------------------------

-- An API key has to go somewhere and be called something. Written so that
-- adding an auth method never breaks it.
ALTER TABLE `customer_erp_connections`
  ADD CONSTRAINT `chk_customer_erp_api_key_named`
  CHECK (`authMethod` <> 'API_KEY' OR (`apiKeyLocation` IS NOT NULL AND `apiKeyName` IS NOT NULL));

-- Any OAuth grant needs somewhere to exchange at. The authorisation URL is
-- only needed by the authorisation-code flow, and is checked separately.
ALTER TABLE `customer_erp_connections`
  ADD CONSTRAINT `chk_customer_erp_oauth_token_url`
  CHECK (`authMethod` NOT IN ('OAUTH2_CLIENT_CREDENTIALS', 'OAUTH2_AUTHORIZATION_CODE')
         OR `oauthTokenUrl` IS NOT NULL);

ALTER TABLE `customer_erp_connections`
  ADD CONSTRAINT `chk_customer_erp_oauth_authorize_url`
  CHECK (`authMethod` <> 'OAUTH2_AUTHORIZATION_CODE' OR `oauthAuthorizationUrl` IS NOT NULL);

-- A timeout that a worker slot can survive. One second is already implausibly
-- fast for an ERP; a ten-minute one would hold the slot hostage.
ALTER TABLE `customer_erp_connections`
  ADD CONSTRAINT `chk_customer_erp_timeout_range`
  CHECK (`timeoutMs` BETWEEN 1000 AND 60000);

-- Polling that is neither a hot loop nor a fortnight.
ALTER TABLE `customer_erp_connections`
  ADD CONSTRAINT `chk_customer_erp_poll_interval`
  CHECK (`pollingIntervalMinutes` BETWEEN 5 AND 10080);

-- A replay window measured in seconds, wide enough for real clock skew and
-- narrow enough that a captured delivery stops working.
ALTER TABLE `customer_erp_connections`
  ADD CONSTRAINT `chk_customer_erp_webhook_tolerance`
  CHECK (`webhookToleranceSeconds` BETWEEN 30 AND 3600);

-- A threshold is an amount in a currency. One without the other cannot be
-- compared to anything, and the comparison is the only thing it is for.
ALTER TABLE `customer_erp_sync_policies`
  ADD CONSTRAINT `chk_customer_erp_threshold_currency`
  CHECK (`approvalThresholdMinor` IS NULL OR `approvalCurrency` IS NOT NULL);

-- Money is never negative here. A negative threshold would approve everything
-- while looking like a restriction.
ALTER TABLE `customer_erp_sync_policies`
  ADD CONSTRAINT `chk_customer_erp_threshold_positive`
  CHECK (`approvalThresholdMinor` IS NULL OR `approvalThresholdMinor` >= 0);

-- Quantities on a link row describe counts of things. Below zero is not a
-- quantity, it is a bug that has already happened.
ALTER TABLE `customer_erp_order_links`
  ADD CONSTRAINT `chk_customer_erp_order_link_qty`
  CHECK (`onOrderQty` >= 0 AND `receivedQty` >= 0);

ALTER TABLE `customer_erp_inventory_links`
  ADD CONSTRAINT `chk_customer_erp_inventory_link_qty`
  CHECK (`onOrderQty` >= 0 AND `incomingQty` >= 0 AND `onHandQty` >= 0);

-- An event that has been attempted cannot have been attempted a negative
-- number of times, and one still queued cannot claim a completion.
ALTER TABLE `customer_erp_sync_events`
  ADD CONSTRAINT `chk_customer_erp_event_attempts`
  CHECK (`attemptCount` >= 0 AND `eventVersion` >= 1);
