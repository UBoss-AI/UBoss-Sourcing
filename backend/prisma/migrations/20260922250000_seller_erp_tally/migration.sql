-- Each seller's own accounting system: TallyPrime.
--
-- THIS IS THE THIRD ERP FEATURE IN THIS DATABASE AND IT IS NEITHER OF THE
-- OTHER TWO.
--
--   `erp_connections`          the OPERATOR's warehouse system. One business,
--                              one active connection.
--   `customer_erp_connections` a BUYER's purchasing system. A hospital's Odoo.
--   `seller_erp_connections`   THIS. A SELLER's accounting system, one per
--                              seller, posting that seller's own sales into
--                              their own books.
--
-- No table, job type or retry budget is shared between them. A seller's Tally
-- being down must not slow the operator's warehouse sync, and one seller's
-- books must be unreachable from another seller's session.
--
-- WHY THERE IS A BRIDGE AND NOT A URL
--
-- TallyPrime is a Windows desktop application whose integration surface is an
-- HTTP listener on the seller's own machine - by default localhost:9000, with
-- NO AUTHENTICATION. Anybody who can reach that port can read the whole ledger
-- and post vouchers into it.
--
-- So there is no address a seller can safely hand over. `localhost:9000` from
-- this server is THIS server. A seller who forwards 9000 to the internet has
-- published their accounts. The only safe shape is outbound-only: a small
-- agent beside Tally opens an authenticated connection OUT to this API and
-- claims work queued for its own seller. Nothing ever connects in.
--
-- `seller_erp_bridge_devices` is those agents. `seller_erp_sync_jobs` is the
-- work. `seller_erp_pairing_codes` is how a machine becomes trusted.
--
-- WHAT IS NOT STORED HERE
--
-- Credentials. The bridge token is kept as a SHA-256 and a display prefix,
-- exactly as `auth_tokens` and the carrier webhook secrets already are - a
-- hash cannot be turned back into a credential by anybody, and verification
-- needs nothing more. Pairing codes likewise. No Tally payload is retained;
-- `seller_erp_sync_attempts` keeps SHA-256 hashes of the request and response
-- so two attempts can be proven identical without a financial document
-- sitting in a diagnostics table.
--
-- ROLLING BACK
--
--   DROP TABLE `seller_erp_sync_attempts`;
--   DROP TABLE `seller_erp_sync_jobs`;
--   DROP TABLE `seller_erp_external_references`;
--   DROP TABLE `seller_erp_audit_events`;
--   DROP TABLE `seller_erp_mappings`;
--   DROP TABLE `seller_erp_master_cache`;
--   DROP TABLE `seller_erp_companies`;
--   DROP TABLE `seller_erp_sync_policies`;
--   DROP TABLE `seller_erp_pairing_codes`;
--   DROP TABLE `seller_erp_bridge_devices`;
--   DROP TABLE `seller_erp_connections`;
--
-- in that order - children first. Nothing outside this migration references
-- any of these tables, so the drop is clean and no other feature degrades.
-- Every bridge token becomes unusable, which is the correct outcome: a rolled
-- back deployment must not leave a paired agent able to authenticate.

CREATE TABLE `seller_erp_connections` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `provider` ENUM('TALLY_PRIME') NOT NULL DEFAULT 'TALLY_PRIME',
    `name` VARCHAR(128) NOT NULL,
    `state` ENUM(
      'NOT_CONFIGURED', 'BRIDGE_REQUIRED', 'AWAITING_PAIRING', 'BRIDGE_OFFLINE',
      'TALLY_UNAVAILABLE', 'COMPANY_NOT_LOADED', 'MAPPING_INCOMPLETE',
      'VALIDATION_FAILED', 'CONNECTED', 'SYNCING', 'CONNECTED_WITH_WARNINGS',
      'PAIRING_EXPIRED', 'DISABLED'
    ) NOT NULL DEFAULT 'NOT_CONFIGURED',
    `stateReason` VARCHAR(512) NULL,
    `stateChangedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `networkMode` ENUM('BRIDGE', 'DIRECT_PRIVATE') NOT NULL DEFAULT 'BRIDGE',
    `directBaseUrl` VARCHAR(1024) NULL,
    `companyName` VARCHAR(255) NULL,
    `companyGuid` VARCHAR(96) NULL,
    `companyBooksFrom` DATE NULL,
    `tallyVersion` VARCHAR(64) NULL,
    `tallyBaseCurrency` VARCHAR(16) NULL,
    `lastTestAt` DATETIME(3) NULL,
    `lastTestOk` BOOLEAN NOT NULL DEFAULT false,
    `lastTestMessage` VARCHAR(512) NULL,
    `lastSuccessfulSyncAt` DATETIME(3) NULL,
    `lastHeartbeatAt` DATETIME(3) NULL,
    `mappingCompleteAt` DATETIME(3) NULL,
    `lastValidationAt` DATETIME(3) NULL,
    `lastReconcileAt` DATETIME(3) NULL,
    `initialSyncStartedAt` DATETIME(3) NULL,
    `initialSyncCompletedAt` DATETIME(3) NULL,
    `inventoryAuthority` ENUM('GLOVIA', 'TALLY', 'MANUAL', 'DISABLED') NOT NULL DEFAULT 'DISABLED',
    `autoCreateMasters` BOOLEAN NOT NULL DEFAULT false,
    `payloadVersion` INTEGER NOT NULL DEFAULT 1,
    `consecutiveFailures` INTEGER NOT NULL DEFAULT 0,
    `circuitState` ENUM('CLOSED', 'OPEN', 'HALF_OPEN') NOT NULL DEFAULT 'CLOSED',
    `circuitOpenedAt` DATETIME(3) NULL,
    `circuitResetAt` DATETIME(3) NULL,
    `disabledAt` DATETIME(3) NULL,
    `createdByProfileId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_seller_erp_connection_name`(`sellerAccountId`, `name`),
    INDEX `ix_seller_erp_connection_state`(`sellerAccountId`, `state`),
    INDEX `ix_seller_erp_connection_heartbeat`(`state`, `lastHeartbeatAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `seller_erp_bridge_devices` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `label` VARCHAR(120) NOT NULL,
    `state` ENUM('PENDING', 'ACTIVE', 'OFFLINE', 'REVOKED') NOT NULL DEFAULT 'PENDING',
    `tokenHash` CHAR(64) NOT NULL,
    `tokenPrefix` VARCHAR(12) NOT NULL,
    `tokenIssuedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `tokenExpiresAt` DATETIME(3) NULL,
    `tokenRotatedAt` DATETIME(3) NULL,
    `lastHeartbeatAt` DATETIME(3) NULL,
    `lastSeenIpHash` CHAR(64) NULL,
    `agentVersion` VARCHAR(32) NULL,
    `osLabel` VARCHAR(64) NULL,
    `reportedTallyAddress` VARCHAR(255) NULL,
    `tasksCompleted` INTEGER NOT NULL DEFAULT 0,
    `tasksFailed` INTEGER NOT NULL DEFAULT 0,
    `revokedAt` DATETIME(3) NULL,
    `revokedReason` VARCHAR(255) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_seller_erp_bridge_token`(`tokenHash`),
    INDEX `ix_seller_erp_bridge_connection`(`connectionId`, `state`),
    INDEX `ix_seller_erp_bridge_seller_state`(`sellerAccountId`, `state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `seller_erp_pairing_codes` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `codeHash` CHAR(64) NOT NULL,
    `codePrefix` VARCHAR(8) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `consumedByDeviceId` CHAR(26) NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `deviceLabel` VARCHAR(120) NOT NULL,
    `createdByProfileId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_seller_erp_pairing_code`(`codeHash`),
    INDEX `ix_seller_erp_pairing_seller`(`sellerAccountId`, `createdAt`),
    INDEX `ix_seller_erp_pairing_sweep`(`expiresAt`, `consumedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `seller_erp_companies` (
    `id` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `tallyName` VARCHAR(255) NOT NULL,
    `tallyGuid` VARCHAR(96) NULL,
    `booksFrom` DATE NULL,
    `isSelected` BOOLEAN NOT NULL DEFAULT false,
    `lastSeenAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_seller_erp_company_name`(`connectionId`, `tallyName`),
    INDEX `ix_seller_erp_company_selected`(`connectionId`, `isSelected`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `seller_erp_master_cache` (
    `id` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `entity` ENUM(
      'PARTY_LEDGER', 'STOCK_ITEM', 'GODOWN', 'UNIT', 'ALTERNATE_UNIT',
      'SALES_ORDER_VOUCHER_TYPE', 'SALES_INVOICE_VOUCHER_TYPE',
      'RECEIPT_VOUCHER_TYPE', 'CREDIT_NOTE_VOUCHER_TYPE',
      'SALES_LEDGER', 'FREIGHT_LEDGER', 'DISCOUNT_LEDGER', 'COMMISSION_LEDGER',
      'GATEWAY_FEE_LEDGER', 'ROUNDING_LEDGER',
      'TAX_LEDGER_CGST', 'TAX_LEDGER_SGST', 'TAX_LEDGER_IGST', 'TAX_LEDGER_CESS',
      'TAX_LEDGER_OTHER', 'COST_CENTRE', 'CURRENCY'
    ) NOT NULL,
    `tallyName` VARCHAR(255) NOT NULL,
    `tallyGuid` VARCHAR(96) NULL,
    `parentName` VARCHAR(255) NULL,
    `extraJson` JSON NULL,
    `lastSeenAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_seller_erp_master`(`connectionId`, `entity`, `tallyName`),
    INDEX `ix_seller_erp_master_entity`(`connectionId`, `entity`, `lastSeenAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `seller_erp_mappings` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `entity` ENUM(
      'PARTY_LEDGER', 'STOCK_ITEM', 'GODOWN', 'UNIT', 'ALTERNATE_UNIT',
      'SALES_ORDER_VOUCHER_TYPE', 'SALES_INVOICE_VOUCHER_TYPE',
      'RECEIPT_VOUCHER_TYPE', 'CREDIT_NOTE_VOUCHER_TYPE',
      'SALES_LEDGER', 'FREIGHT_LEDGER', 'DISCOUNT_LEDGER', 'COMMISSION_LEDGER',
      'GATEWAY_FEE_LEDGER', 'ROUNDING_LEDGER',
      'TAX_LEDGER_CGST', 'TAX_LEDGER_SGST', 'TAX_LEDGER_IGST', 'TAX_LEDGER_CESS',
      'TAX_LEDGER_OTHER', 'COST_CENTRE', 'CURRENCY'
    ) NOT NULL,
    `localKey` VARCHAR(64) NOT NULL DEFAULT '',
    `localLabel` VARCHAR(255) NULL,
    `tallyName` VARCHAR(255) NOT NULL,
    `tallyGuid` VARCHAR(96) NULL,
    `alternateUnitName` VARCHAR(64) NULL,
    `conversionFactor` DECIMAL(18, 6) NULL,
    `isConfirmed` BOOLEAN NOT NULL DEFAULT false,
    `warning` VARCHAR(512) NULL,
    `updatedByProfileId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_seller_erp_mapping`(`connectionId`, `entity`, `localKey`),
    INDEX `ix_seller_erp_mapping_seller`(`sellerAccountId`, `entity`),
    INDEX `ix_seller_erp_mapping_confirmed`(`connectionId`, `isConfirmed`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `seller_erp_sync_policies` (
    `id` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `postSalesOrder` BOOLEAN NOT NULL DEFAULT true,
    `postSalesInvoice` BOOLEAN NOT NULL DEFAULT false,
    `invoiceOnDispatch` BOOLEAN NOT NULL DEFAULT true,
    `postReceipt` BOOLEAN NOT NULL DEFAULT false,
    `postCreditNote` BOOLEAN NOT NULL DEFAULT false,
    `cancellationMode` ENUM('CREDIT_NOTE', 'MARK_CANCELLED', 'MANUAL') NOT NULL DEFAULT 'CREDIT_NOTE',
    `syncStockItems` BOOLEAN NOT NULL DEFAULT false,
    `syncPartyLedgers` BOOLEAN NOT NULL DEFAULT false,
    `syncGodowns` BOOLEAN NOT NULL DEFAULT false,
    `inventoryAuthority` ENUM('GLOVIA', 'TALLY', 'MANUAL', 'DISABLED') NOT NULL DEFAULT 'DISABLED',
    `inventoryPollMinutes` INTEGER NULL,
    `includePackagingNarration` BOOLEAN NOT NULL DEFAULT true,
    `narrationTemplate` VARCHAR(512) NULL,
    `maxAttempts` INTEGER NOT NULL DEFAULT 8,
    `retryBaseSeconds` INTEGER NOT NULL DEFAULT 30,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_seller_erp_policy_connection`(`connectionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The outbox.
--
-- `uq_seller_erp_job_idempotency` is the whole duplicate guarantee. A webhook
-- redelivered four times, a lease that expired mid-flight, a seller pressing
-- "sync now" twice - every one of those tries to enqueue the same event, and
-- this index turns the second and subsequent attempts into a no-op AT THE
-- DATABASE rather than into a second voucher in somebody's books. A duplicate
-- Sales Invoice is a tax return that does not reconcile.
CREATE TABLE `seller_erp_sync_jobs` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `eventType` ENUM(
      'SALES_ORDER', 'SALES_INVOICE', 'RECEIPT', 'CREDIT_NOTE', 'CANCELLATION',
      'STOCK_ITEM_UPSERT', 'PARTY_LEDGER_UPSERT', 'GODOWN_UPSERT',
      'INVENTORY_PULL', 'MASTER_PULL', 'CONNECTION_TEST'
    ) NOT NULL,
    `sourceEntityType` VARCHAR(48) NOT NULL,
    `sourceEntityId` CHAR(26) NULL,
    `orderId` CHAR(26) NULL,
    `sellerOrderGroupId` CHAR(26) NULL,
    `payloadJson` JSON NOT NULL,
    `payloadVersion` INTEGER NOT NULL DEFAULT 1,
    `status` ENUM(
      'PENDING', 'IN_FLIGHT', 'SUCCEEDED', 'RETRY_SCHEDULED',
      'FAILED', 'DEAD_LETTER', 'CANCELLED', 'BLOCKED'
    ) NOT NULL DEFAULT 'PENDING',
    `trigger` ENUM('MANUAL', 'INITIAL', 'EVENT', 'SCHEDULED', 'RETRY', 'RECONCILE') NOT NULL DEFAULT 'EVENT',
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `maxAttempts` INTEGER NOT NULL DEFAULT 8,
    `nextRetryAt` DATETIME(3) NULL,
    `sequenceKey` VARCHAR(96) NOT NULL DEFAULT '',
    `dependsOnJobId` CHAR(26) NULL,
    `leaseOwner` VARCHAR(64) NULL,
    `leaseExpiresAt` DATETIME(3) NULL,
    `externalVoucherId` VARCHAR(96) NULL,
    `externalVoucherNumber` VARCHAR(64) NULL,
    `externalMasterName` VARCHAR(255) NULL,
    `sanitizedError` VARCHAR(1000) NULL,
    `errorCode` VARCHAR(64) NULL,
    `correlationId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,

    UNIQUE INDEX `uq_seller_erp_job_idempotency`(`idempotencyKey`),
    INDEX `ix_seller_erp_job_claim`(`connectionId`, `status`, `nextRetryAt`, `createdAt`),
    INDEX `ix_seller_erp_job_seller`(`sellerAccountId`, `status`, `createdAt`),
    INDEX `ix_seller_erp_job_sequence`(`connectionId`, `sequenceKey`, `status`),
    INDEX `ix_seller_erp_job_order`(`orderId`),
    INDEX `ix_seller_erp_job_lease`(`status`, `leaseExpiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- One row per GO at a job, not one row overwritten eight times.
--
-- The Tally counters are why an HTTP 200 is not treated as success: Tally
-- answers 200 to a request that created nothing and rejected every line, and
-- the truth is in CREATED / ALTERED / IGNORED / ERRORS / EXCEPTIONS.
CREATE TABLE `seller_erp_sync_attempts` (
    `id` CHAR(26) NOT NULL,
    `jobId` CHAR(26) NOT NULL,
    `attemptNumber` INTEGER NOT NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `finishedAt` DATETIME(3) NULL,
    `durationMs` INTEGER NULL,
    `outcome` VARCHAR(32) NOT NULL,
    `httpStatus` INTEGER NULL,
    `tallyCreated` INTEGER NULL,
    `tallyAltered` INTEGER NULL,
    `tallyDeleted` INTEGER NULL,
    `tallyIgnored` INTEGER NULL,
    `tallyErrors` INTEGER NULL,
    `tallyExceptions` INTEGER NULL,
    `tallyLastVoucherId` VARCHAR(96) NULL,
    `lineErrorsJson` JSON NULL,
    `sanitizedError` VARCHAR(1000) NULL,
    `requestHash` CHAR(64) NULL,
    `responseHash` CHAR(64) NULL,
    `correlationId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_seller_erp_attempt_number`(`jobId`, `attemptNumber`),
    INDEX `ix_seller_erp_attempt_time`(`jobId`, `startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `seller_erp_external_references` (
    `id` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NOT NULL,
    `entityType` VARCHAR(48) NOT NULL,
    `localId` CHAR(26) NOT NULL,
    `tallyName` VARCHAR(255) NULL,
    `tallyGuid` VARCHAR(96) NULL,
    `voucherNumber` VARCHAR(64) NULL,
    `voucherDate` DATE NULL,
    `voucherTypeName` VARCHAR(128) NULL,
    `lastSyncedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_seller_erp_ref_entity`(`connectionId`, `entityType`, `localId`),
    INDEX `ix_seller_erp_ref_type`(`connectionId`, `entityType`, `lastSyncedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `seller_erp_audit_events` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `connectionId` CHAR(26) NULL,
    `action` VARCHAR(96) NOT NULL,
    `actorType` ENUM('SYSTEM', 'ADMIN', 'CUSTOMER', 'PROVIDER', 'LOGISTICS') NOT NULL,
    `actorUserId` CHAR(26) NULL,
    `actorLabel` VARCHAR(120) NULL,
    `summary` VARCHAR(512) NULL,
    `metaJson` JSON NULL,
    `ipHash` CHAR(64) NULL,
    `correlationId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_seller_erp_audit_time`(`sellerAccountId`, `createdAt`),
    INDEX `ix_seller_erp_audit_action`(`sellerAccountId`, `action`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Foreign keys. Everything cascades from the seller, because a seller account
-- removed takes its own books' configuration with it - none of it means
-- anything without the seller, and none of it is somebody else's record.
ALTER TABLE `seller_erp_connections`
  ADD CONSTRAINT `fk_seller_erp_connection_seller`
    FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_erp_bridge_devices`
  ADD CONSTRAINT `fk_seller_erp_bridge_seller`
    FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_seller_erp_bridge_connection`
    FOREIGN KEY (`connectionId`) REFERENCES `seller_erp_connections`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_erp_pairing_codes`
  ADD CONSTRAINT `fk_seller_erp_pairing_connection`
    FOREIGN KEY (`connectionId`) REFERENCES `seller_erp_connections`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_erp_companies`
  ADD CONSTRAINT `fk_seller_erp_company_connection`
    FOREIGN KEY (`connectionId`) REFERENCES `seller_erp_connections`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_erp_master_cache`
  ADD CONSTRAINT `fk_seller_erp_master_connection`
    FOREIGN KEY (`connectionId`) REFERENCES `seller_erp_connections`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_erp_mappings`
  ADD CONSTRAINT `fk_seller_erp_mapping_connection`
    FOREIGN KEY (`connectionId`) REFERENCES `seller_erp_connections`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_erp_sync_policies`
  ADD CONSTRAINT `fk_seller_erp_policy_connection`
    FOREIGN KEY (`connectionId`) REFERENCES `seller_erp_connections`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_erp_sync_jobs`
  ADD CONSTRAINT `fk_seller_erp_job_seller`
    FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_seller_erp_job_connection`
    FOREIGN KEY (`connectionId`) REFERENCES `seller_erp_connections`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_erp_sync_attempts`
  ADD CONSTRAINT `fk_seller_erp_attempt_job`
    FOREIGN KEY (`jobId`) REFERENCES `seller_erp_sync_jobs`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_erp_external_references`
  ADD CONSTRAINT `fk_seller_erp_ref_connection`
    FOREIGN KEY (`connectionId`) REFERENCES `seller_erp_connections`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_erp_audit_events`
  ADD CONSTRAINT `fk_seller_erp_audit_seller`
    FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_seller_erp_audit_connection`
    FOREIGN KEY (`connectionId`) REFERENCES `seller_erp_connections`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- CHECK constraints.
--
-- The retry budget and the attempt counter are the two an application bug
-- would break silently, and both of them decide whether somebody's books get
-- a second copy of a voucher.
ALTER TABLE `seller_erp_sync_jobs`
  ADD CONSTRAINT `chk_seller_erp_job_attempts` CHECK (
    `attemptCount` >= 0 AND `maxAttempts` > 0 AND `attemptCount` <= `maxAttempts` + 1
  );

ALTER TABLE `seller_erp_sync_attempts`
  ADD CONSTRAINT `chk_seller_erp_attempt_number` CHECK (`attemptNumber` > 0);

ALTER TABLE `seller_erp_sync_policies`
  ADD CONSTRAINT `chk_seller_erp_policy_retry` CHECK (
    `maxAttempts` > 0 AND `maxAttempts` <= 50 AND
    `retryBaseSeconds` > 0 AND `retryBaseSeconds` <= 3600 AND
    (`inventoryPollMinutes` IS NULL OR `inventoryPollMinutes` >= 5)
  );

-- A DIRECT_PRIVATE connection must actually have an address, and a BRIDGE one
-- must not carry a stale address from a mode somebody switched away from. The
-- second half is the one that matters: a leftover URL on a bridge connection
-- is an outbound call waiting for a code path to find it.
ALTER TABLE `seller_erp_connections`
  ADD CONSTRAINT `chk_seller_erp_network_mode` CHECK (
    (`networkMode` = 'DIRECT_PRIVATE' AND `directBaseUrl` IS NOT NULL) OR
    (`networkMode` = 'BRIDGE' AND `directBaseUrl` IS NULL)
  );
