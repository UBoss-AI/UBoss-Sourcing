-- The business's ERP, and a customer's authority to be charged.
--
-- Two features that arrive together because the second is what makes the first
-- useful without somebody watching, and one distinction runs through both.
--
-- **The ERP belongs to the BUSINESS.** One connection, configured by an
-- administrator under Settings -> ERP, used for every order this installation
-- takes. There is deliberately no per-customer connection: a connection is a
-- URL plus a credential that this server then calls, and letting a buyer supply
-- either turns a form field into a server-side request forgery primitive and
-- makes "did this order reach the warehouse" depend on something the buyer
-- configured. `business_profiles` is a single-row table - this deployment
-- serves exactly one business - and its ERP is the same one for every order.
--
-- **Auto-pay belongs to the CUSTOMER.** It is the one thing here that cannot be
-- an administrator's to set, because nobody can consent on somebody else's
-- behalf to money leaving their account.
--
-- Six new tables, and why each is a table rather than a column:
--
--   erp_connections           The configuration itself. Several rows are
--                             allowed - a sandbox and a live one is the
--                             ordinary case - but at most one is ACTIVE, which
--                             `activateConnection` enforces. MariaDB 10.4 has
--                             no partial index, so "unique where status =
--                             ACTIVE" cannot be a constraint here.
--
--   erp_inventory_sync_runs   One pass over a feed. Needs counts, a status, a
--                             start and a finish - a JSON blob on the
--                             connection could hold the last one and nothing
--                             could answer "how often has this failed".
--
--   erp_sync_record_errors    The rows a pass could not read. Capped per run by
--                             the service; a feed that fails wholesale produces
--                             one reason, not fifty thousand.
--
--   erp_inventory_snapshots   What the ERP last said it holds. NOT
--                             `inventory_balances` - see the comment above that
--                             table, which is the most important one in this
--                             file.
--
--   integration_events        The ledger. Correlation id, idempotency key,
--                             attempt count, safe provider response. This is
--                             what a retry consults and what answers "why has
--                             this order not reached the warehouse".
--
--   erp_webhook_receipts      Seen-before, keyed on the ERP's own event id. The
--                             duplicate guard for inbound stock updates,
--                             enforced by a UNIQUE index rather than by the
--                             handler remembering to check.
--
--   customer_autopay_settings Consent to charge, apart from the instrument to
--                             charge. A saved card is not permission to use it,
--                             and conflating the two is how a customer gets
--                             billed for something they never authorised.
--
-- On the two guards that are structural rather than procedural:
--
--   `uq_integration_event_idempotency` is what makes a duplicate ERP order
--   impossible rather than unlikely. The same logical operation computes the
--   same key on every attempt, so the second insert collides.
--
--   `uq_erp_webhook_receipt` does the same for inbound webhooks. An ERP that
--   redelivers finds the row already there and the handler answers "already
--   applied, in run X" instead of recording stock twice.
--
-- On MariaDB 10.4. No CHECK constraint here names an ENUM member, so nothing in
-- this migration has the problem `chk_schedule_frequency_field_present` had.
-- The constraints at the end are arithmetic or NULL-shape, which 10.4 enforces
-- without complaint. Every FK is InnoDB with an explicit ON DELETE, since 10.4
-- has no deferred constraints to fall back on.

-- ---------------------------------------------------------------------------
-- The connection
-- ---------------------------------------------------------------------------

CREATE TABLE `erp_connections` (
    `id`                     CHAR(26)      NOT NULL,
    `name`                   VARCHAR(128)  NOT NULL,
    `baseUrl`                VARCHAR(1024) NOT NULL,

    `status`                 ENUM('DRAFT','TESTING','CONNECTED','ACTIVE','PAUSED','ERROR','DISABLED') NOT NULL DEFAULT 'DRAFT',
    `statusReason`           VARCHAR(512)  NULL,
    `statusChangedAt`        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    `productEndpoint`        VARCHAR(512)  NULL,
    `inventoryEndpoint`      VARCHAR(512)  NULL,
    `warehouseEndpoint`      VARCHAR(512)  NULL,
    `orderCreateEndpoint`    VARCHAR(512)  NULL,
    `orderStatusEndpoint`    VARCHAR(512)  NULL,

    `methodsJson`            JSON          NULL,
    `customHeadersJson`      JSON          NULL,
    `timeoutMs`              INT           NOT NULL DEFAULT 15000,

    `authMethod`             ENUM('API_KEY','BEARER_TOKEN','BASIC','OAUTH2') NOT NULL DEFAULT 'API_KEY',
    -- AES-256-GCM envelope. Nothing in the application decrypts this into a
    -- response, a log line or an error message; `credentialHint` is what the
    -- edit screen shows.
    `credentialsEnc`         TEXT          NULL,
    `credentialHint`         VARCHAR(128)  NULL,

    `oauthTokenUrl`          VARCHAR(1024) NULL,
    `oauthScope`             VARCHAR(512)  NULL,
    `oauthTokenEnc`          TEXT          NULL,
    `oauthTokenExpiresAt`    DATETIME(3)   NULL,

    `webhookEnabled`         BOOLEAN       NOT NULL DEFAULT false,
    `webhookSecretEnc`       TEXT          NULL,
    `webhookSignatureHeader` VARCHAR(64)   NOT NULL DEFAULT 'X-UBOSS-Signature',
    `webhookSlug`            VARCHAR(64)   NOT NULL,

    `pollingEnabled`         BOOLEAN       NOT NULL DEFAULT false,
    `pollingIntervalMinutes` INT           NOT NULL DEFAULT 60,
    `lastPolledAt`           DATETIME(3)   NULL,
    `nextPollAt`             DATETIME(3)   NULL,

    `fieldMappingJson`       JSON          NULL,
    `mappingVerifiedAt`      DATETIME(3)   NULL,

    `inventoryAuthority`     ENUM('ERP','PLATFORM','MANUAL') NOT NULL DEFAULT 'ERP',
    `allowManualOverride`    BOOLEAN       NOT NULL DEFAULT false,

    `orderPushEnabled`       BOOLEAN       NOT NULL DEFAULT true,
    `idempotencyHeader`      VARCHAR(64)   NOT NULL DEFAULT 'Idempotency-Key',

    `lastTestAt`             DATETIME(3)   NULL,
    `lastTestOk`             BOOLEAN       NULL,
    `lastTestHttpStatus`     INT           NULL,
    `lastTestDurationMs`     INT           NULL,
    `lastTestMessage`        VARCHAR(512)  NULL,

    `consecutiveFailures`    INT           NOT NULL DEFAULT 0,
    `circuitOpenedAt`        DATETIME(3)   NULL,

    `lastSyncSuccessAt`      DATETIME(3)   NULL,
    `lastSyncFailureAt`      DATETIME(3)   NULL,

    `createdById`            CHAR(26)      NULL,
    `createdAt`              DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`              DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    `deletedAt`              DATETIME(3)   NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `uq_erp_connection_name`(`name`),
    UNIQUE INDEX `uq_erp_webhook_slug`(`webhookSlug`),
    INDEX `ix_erp_connection_status`(`status`),
    INDEX `ix_erp_connection_poll_due`(`status`, `pollingEnabled`, `nextPollAt`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Inventory synchronisation
-- ---------------------------------------------------------------------------

CREATE TABLE `erp_inventory_sync_runs` (
    `id`               CHAR(26)      NOT NULL,
    `connectionId`     CHAR(26)      NOT NULL,

    `trigger`          ENUM('MANUAL','SCHEDULED','WEBHOOK','RETRY') NOT NULL,
    `status`           ENUM('RUNNING','SUCCEEDED','PARTIAL','FAILED','RATE_LIMITED') NOT NULL DEFAULT 'RUNNING',
    `isDryRun`         BOOLEAN       NOT NULL DEFAULT false,

    `correlationId`    CHAR(26)      NOT NULL,

    `startedAt`        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt`       DATETIME(3)   NULL,

    `processedCount`   INT           NOT NULL DEFAULT 0,
    `appliedCount`     INT           NOT NULL DEFAULT 0,
    `skippedCount`     INT           NOT NULL DEFAULT 0,
    `failedCount`      INT           NOT NULL DEFAULT 0,
    `conflictCount`    INT           NOT NULL DEFAULT 0,

    `rateLimitedUntil` DATETIME(3)   NULL,

    `errorCode`        VARCHAR(64)   NULL,
    `errorMessage`     VARCHAR(1024) NULL,

    PRIMARY KEY (`id`),
    INDEX `ix_erp_sync_connection_time`(`connectionId`, `startedAt`),
    INDEX `ix_erp_sync_status_time`(`status`, `startedAt`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `erp_inventory_sync_runs`
    ADD CONSTRAINT `fk_erp_sync_connection`
    FOREIGN KEY (`connectionId`) REFERENCES `erp_connections`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE `erp_sync_record_errors` (
    `id`           CHAR(26)      NOT NULL,
    `syncRunId`    CHAR(26)      NOT NULL,

    `externalRef`  VARCHAR(191)  NULL,
    `field`        VARCHAR(128)  NULL,
    `errorCode`    VARCHAR(64)   NOT NULL,
    -- Already safe for display: redaction happens before the write, so nothing
    -- reading this column has to remember to sanitise.
    `errorMessage` VARCHAR(1024) NOT NULL,

    `createdAt`    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    INDEX `ix_erp_sync_record_run`(`syncRunId`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `erp_sync_record_errors`
    ADD CONSTRAINT `fk_erp_sync_record_run`
    FOREIGN KEY (`syncRunId`) REFERENCES `erp_inventory_sync_runs`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- What the ERP says it holds
-- ---------------------------------------------------------------------------

-- **This is NOT `inventory_balances`, and that is the most important line in
-- this migration.**
--
-- `inventory_balances` is derived from `inventory_movements`, an append-only
-- ledger carrying an actor and a reason on every row. That pair is what makes
-- "why did on-hand change" a question with an answer. A feed that overwrote
-- balances directly would move real stock with no movement behind it, and the
-- first time a field mapping was wrong it would do so silently, at scale, and
-- with nothing to reverse.
--
-- So a sync writes here, and the two figures are shown side by side. Acting on
-- a difference is a person's decision, taken through the Inventory screens,
-- which record who took it and why.
--
-- `warehouseKey` is NOT NULL with a '' sentinel rather than a nullable
-- `warehouseCode`. MariaDB treats every NULL in a UNIQUE index as distinct, so
-- a nullable column inside the composite unique below would let the same SKU be
-- inserted without a warehouse any number of times - turning every redelivered
-- webhook into a duplicate row.
CREATE TABLE `erp_inventory_snapshots` (
    `id`                     CHAR(26)     NOT NULL,
    `connectionId`           CHAR(26)     NOT NULL,

    `sku`                    VARCHAR(191) NOT NULL,
    `warehouseKey`           VARCHAR(64)  NOT NULL,

    `productId`              CHAR(26)     NULL,
    `variantId`              CHAR(26)     NULL,

    `availableQuantity`      INT          NOT NULL DEFAULT 0,
    `reservedQuantity`       INT          NOT NULL DEFAULT 0,
    `unitOfMeasure`          VARCHAR(32)  NULL,

    `erpProductId`           VARCHAR(191) NULL,
    `erpProductName`         VARCHAR(255) NULL,

    `priceMinor`             BIGINT       NULL,
    `currency`               CHAR(3)      NULL,

    -- What this platform's own balances said at the moment of the sync. Stored
    -- so a divergence can be shown - "your ERP says 12, we hold 40" - rather
    -- than merely resolved and forgotten.
    `platformQuantityAtSync` INT          NULL,
    `conflictDetectedAt`     DATETIME(3)  NULL,

    `manualQuantity`         INT          NULL,
    `manualSetAt`            DATETIME(3)  NULL,
    `manualSetByUserId`      CHAR(26)     NULL,

    `lastSyncedAt`           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSyncRunId`          CHAR(26)     NULL,

    `createdAt`              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    -- What makes a sync an upsert rather than an append.
    UNIQUE INDEX `uq_erp_snapshot_sku_warehouse`(`connectionId`, `sku`, `warehouseKey`),
    INDEX `ix_erp_snapshot_sku`(`sku`),
    INDEX `ix_erp_snapshot_product`(`productId`),
    INDEX `ix_erp_snapshot_conflicts`(`connectionId`, `conflictDetectedAt`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `erp_inventory_snapshots`
    ADD CONSTRAINT `fk_erp_snapshot_connection`
    FOREIGN KEY (`connectionId`) REFERENCES `erp_connections`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The integration ledger
-- ---------------------------------------------------------------------------

CREATE TABLE `integration_events` (
    `id`                CHAR(26)      NOT NULL,
    -- Nullable so the row outlives a deleted connection: the ledger has to be
    -- able to explain an old order after its connector is gone.
    `connectionId`      CHAR(26)      NULL,

    `eventType`         ENUM('CONNECTION_TEST','DRY_RUN','ORDER_PUSH','INVENTORY_SYNC','INVENTORY_WEBHOOK','ORDER_STATUS_POLL','AUTOPAY_CHARGE') NOT NULL,
    `status`            ENUM('PENDING','IN_PROGRESS','SUCCEEDED','RETRY_SCHEDULED','FAILED','ABANDONED') NOT NULL DEFAULT 'PENDING',

    `orderId`           CHAR(26)      NULL,
    `erpOrderReference` VARCHAR(191)  NULL,

    `correlationId`     CHAR(26)      NOT NULL,
    `idempotencyKey`    VARCHAR(191)  NULL,

    `attemptCount`      INT           NOT NULL DEFAULT 0,
    `lastAttemptAt`     DATETIME(3)   NULL,
    `nextRetryAt`       DATETIME(3)   NULL,

    `httpStatus`        INT           NULL,
    `durationMs`        INT           NULL,

    `errorCode`         VARCHAR(64)   NULL,
    `errorMessage`      VARCHAR(1024) NULL,
    `responseJson`      JSON          NULL,

    `createdAt`         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`         DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    -- The duplicate guard. The same logical operation computes the same key on
    -- every attempt, so a redelivered webhook or a re-run job collides here
    -- instead of producing a second ERP order.
    --
    -- MariaDB treats every NULL in a UNIQUE index as distinct, which is exactly
    -- what is wanted: events that are not operations against ERP state (a
    -- connection test, say) leave the column NULL and may repeat freely.
    UNIQUE INDEX `uq_integration_event_idempotency`(`idempotencyKey`),
    INDEX `ix_integration_event_time`(`createdAt`),
    INDEX `ix_integration_event_kind`(`eventType`, `status`),
    INDEX `ix_integration_event_order`(`orderId`),
    INDEX `ix_integration_event_retry`(`status`, `nextRetryAt`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `integration_events`
    ADD CONSTRAINT `fk_integration_event_connection`
    FOREIGN KEY (`connectionId`) REFERENCES `erp_connections`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Inbound webhook de-duplication
-- ---------------------------------------------------------------------------

CREATE TABLE `erp_webhook_receipts` (
    `id`              CHAR(26)     NOT NULL,
    `connectionId`    CHAR(26)     NOT NULL,

    -- The ERP's own event id, or `sha256:<hex>` of the raw body when it sent
    -- none. Two identical bodies inside the window are indistinguishable from a
    -- redelivery, and for a full-quantity stock snapshot treating them as one
    -- is the safe direction to be wrong in.
    `externalEventId` VARCHAR(191) NOT NULL,

    `receivedAt`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt`     DATETIME(3)  NULL,
    `syncRunId`       CHAR(26)     NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `uq_erp_webhook_receipt`(`connectionId`, `externalEventId`),
    INDEX `ix_erp_webhook_time`(`receivedAt`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `erp_webhook_receipts`
    ADD CONSTRAINT `fk_erp_webhook_connection`
    FOREIGN KEY (`connectionId`) REFERENCES `erp_connections`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Auto-pay consent
-- ---------------------------------------------------------------------------

CREATE TABLE `customer_autopay_settings` (
    `id`                     CHAR(26)     NOT NULL,
    `customerProfileId`      CHAR(26)     NOT NULL,

    `status`                 ENUM('DISABLED','ACTIVE','PAUSED') NOT NULL DEFAULT 'DISABLED',
    `paymentMethodId`        CHAR(26)     NULL,

    `maxTransactionMinor`    BIGINT       NULL,
    `approvalThresholdMinor` BIGINT       NULL,
    `limitCurrency`          CHAR(3)      NULL,

    `retryPreference`        ENUM('NONE','ONCE','STANDARD') NOT NULL DEFAULT 'STANDARD',

    `notifyOnCharge`         BOOLEAN      NOT NULL DEFAULT true,
    `notifyOnFailure`        BOOLEAN      NOT NULL DEFAULT true,

    `consentAcceptedAt`      DATETIME(3)  NULL,
    `consentVersion`         VARCHAR(32)  NULL,
    -- Hashed, never the address itself. It is evidence that consent came from
    -- somewhere; keeping the raw IP would make this a worse table to leak.
    `consentIpHash`          VARCHAR(64)  NULL,
    `consentUserAgent`       VARCHAR(256) NULL,
    `consentWithdrawnAt`     DATETIME(3)  NULL,

    `enabledAt`              DATETIME(3)  NULL,
    `pausedAt`               DATETIME(3)  NULL,

    `createdAt`              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`              DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    UNIQUE INDEX `uq_autopay_customer`(`customerProfileId`),
    INDEX `ix_autopay_status`(`status`),
    INDEX `ix_autopay_payment_method`(`paymentMethodId`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `customer_autopay_settings`
    ADD CONSTRAINT `fk_autopay_customer`
    FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, not CASCADE. Removing a card must leave auto-pay without an
-- instrument - which `assertAutoPayChargeable` then refuses - rather than
-- deleting the customer's limits and preferences along with the card.
ALTER TABLE `customer_autopay_settings`
    ADD CONSTRAINT `fk_autopay_payment_method`
    FOREIGN KEY (`paymentMethodId`) REFERENCES `customer_payment_methods`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The ERP push ledger learns about the new connection table
-- ---------------------------------------------------------------------------

-- A second column rather than a reused one: `connectionId` points at
-- `integration_connections` - the legacy path an installation still configured
-- through `ERP_ORDER_CONNECTION_NAME` takes - and this points at
-- `erp_connections`, which is where every new installation is configured. They
-- are different id spaces addressing different tables, and a row that cannot
-- say which kind it holds is a row nobody can safely join. At most one is set
-- on any push; both NULL means no ERP was configured at all.
--
-- No FK: the ledger row must outlive a deleted connection, and MariaDB 10.4 has
-- no way to express "reference this table or that one".
ALTER TABLE `erp_order_pushes`
    ADD COLUMN `erpConnectionId` CHAR(26) NULL AFTER `connectionId`;

CREATE INDEX `ix_erp_push_erp_connection_time`
    ON `erp_order_pushes`(`erpConnectionId`, `createdAt`);

-- ---------------------------------------------------------------------------
-- Invariants worth having the database enforce
-- ---------------------------------------------------------------------------

-- A timeout somebody types is a worker slot they hold. One minute is already
-- generous for an ERP that is answering at all.
ALTER TABLE `erp_connections`
    ADD CONSTRAINT `chk_erp_connection_timeout_bounded` CHECK (
        `timeoutMs` >= 1000 AND `timeoutMs` <= 60000
    );

-- Five minutes is the floor. Anything under it is hammering your own ERP, and
-- the answer to "I want it faster" is a webhook, not a tighter poll.
ALTER TABLE `erp_connections`
    ADD CONSTRAINT `chk_erp_connection_poll_interval` CHECK (
        `pollingIntervalMinutes` >= 5 AND `pollingIntervalMinutes` <= 1440
    );

-- Quantities are not negative. An ERP reporting -5 available is either
-- mis-mapped or reporting a backorder in a field that does not mean that, and
-- storing it would make every availability figure downstream wrong in a way
-- nobody would trace back to here.
ALTER TABLE `erp_inventory_snapshots`
    ADD CONSTRAINT `chk_erp_snapshot_quantities_non_negative` CHECK (
        `availableQuantity` >= 0
        AND `reservedQuantity` >= 0
        AND (`manualQuantity` IS NULL OR `manualQuantity` >= 0)
    );

-- A price without a currency is not a price.
ALTER TABLE `erp_inventory_snapshots`
    ADD CONSTRAINT `chk_erp_snapshot_price_currency` CHECK (
        `priceMinor` IS NULL OR `currency` IS NOT NULL
    );

-- An amount without a currency is not a limit. This is the constraint that
-- stops 5000 being compared against a total in a different currency, which is
-- the shape of bug that charges somebody eighty times what they agreed to.
ALTER TABLE `customer_autopay_settings`
    ADD CONSTRAINT `chk_autopay_limit_currency_present` CHECK (
        (`maxTransactionMinor` IS NULL AND `approvalThresholdMinor` IS NULL)
        OR `limitCurrency` IS NOT NULL
    );

-- Limits are positive or absent. Zero would read as "never charge anything",
-- which is what DISABLED is for, and a negative one has no meaning at all.
ALTER TABLE `customer_autopay_settings`
    ADD CONSTRAINT `chk_autopay_limits_positive` CHECK (
        (`maxTransactionMinor` IS NULL OR `maxTransactionMinor` > 0)
        AND (`approvalThresholdMinor` IS NULL OR `approvalThresholdMinor` > 0)
    );

-- Auto-pay cannot be on without consent recorded. The application refuses this
-- too; the constraint is here because "we had permission" is a claim somebody
-- will one day have to prove, and a row that contradicts it should not be
-- storable.
ALTER TABLE `customer_autopay_settings`
    ADD CONSTRAINT `chk_autopay_consent_present` CHECK (
        `status` = 'DISABLED' OR `consentAcceptedAt` IS NOT NULL
    );
