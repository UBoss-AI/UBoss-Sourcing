-- Buy Later, Subscribe & Reorder, and the auto-pay path that makes them real.
--
-- Three things were missing before this migration, and only the first is a
-- matter of columns:
--
--   1. A plan could repeat, but it could not fire once. "Deliver this basket a
--      week from Tuesday and then stop" had nowhere to live, so it is added as
--      `kind` plus a ONE_TIME frequency rather than a second table - every
--      other thing about it (revalidation, payment, ERP push, idempotency, the
--      customer's management screen) is identical to a recurring occurrence,
--      and a parallel table would have meant two of each of those.
--
--   2. An occurrence had five states, and the engine needed nine. The gap was
--      not cosmetic: there was no way to say "paid, but the ERP has not taken
--      it yet", which is the one state where the customer's money has moved
--      and the work is unfinished. PAID_ERP_PENDING is that state, and
--      `erp_order_pushes` is what retries out of it without charging again.
--
--   3. Nothing recorded a reusable payment instrument or the consent to use
--      it. `recurring_schedules.mandateReference` held a provider token with
--      no consent record attached, which is not enough to charge anybody
--      off-session - not under Stripe's rules and not under the law's.
--
-- On the enums. Both status enums grow rather than change: PENDING,
-- ORDER_CREATED and PAID stay in `schedule_occurrences.status` so rows written
-- by the previous engine still read correctly, and ScheduleStatus keeps FAILED
-- alongside the new COMPLETED. Nothing writes the retained values any more.
-- Widening a MariaDB ENUM by appending members rewrites no rows and preserves
-- the ordinal of every existing one; reordering or removing a member would not,
-- which is why the retained values sit at the end of the list instead of in
-- their old positions.
--
-- On `idempotencyKey`. It is NOT NULL and UNIQUE on a table that already has
-- rows, so it cannot simply be added: the column arrives nullable, is
-- backfilled from the two fields it is derived from, and only then is tightened
-- and indexed. The format is `occ:<scheduleId>:<YYYYMMDDHHMMSSmmm>` and
-- `occurrenceIdempotencyKey()` in schedule-state.ts computes the identical
-- string from the identical inputs - so a retry recomputes the key rather than
-- minting a new one, which is the entire reason it exists. The timestamp is
-- rendered with DATE_FORMAT and not UNIX_TIMESTAMP on purpose: UNIX_TIMESTAMP
-- reads a DATETIME through the session timezone, and this server's is
-- Asia/Calcutta, so it would have produced keys 19800 seconds away from the
-- ones the application computes.
--
-- Every other column is additive and nullable or defaulted, so an installation
-- that is already running takes this migration without a backfill it has to
-- think about.

-- ---------------------------------------------------------------------------
-- Reusable payment instruments and their off-session consent
-- ---------------------------------------------------------------------------
--
-- Created before `recurring_schedules` is altered, because that table gains a
-- foreign key pointing here.
--
-- The stored set is deliberately the smallest one that can charge a card:
-- Stripe's customer id, its payment-method id, and the display fields Stripe
-- itself hands back so a person can tell which card they picked. No PAN, no
-- CVV, no client secret. Leaking this table yields nothing chargeable without
-- the deployment's own Stripe secret key.
CREATE TABLE `customer_payment_methods` (
    `id`                      CHAR(26)                            NOT NULL,
    `customerProfileId`       CHAR(26)                            NOT NULL,
    `provider`                ENUM('RAZORPAY', 'STRIPE')          NOT NULL,

    `providerCustomerId`      VARCHAR(128)                        NOT NULL,
    `providerPaymentMethodId` VARCHAR(128)                        NOT NULL,
    `setupIntentId`           VARCHAR(128)                        NULL,

    -- Display only. None of these five can pay for anything.
    `brand`                   VARCHAR(32)                         NULL,
    `last4`                   VARCHAR(4)                          NULL,
    `expMonth`                INTEGER                             NULL,
    `expYear`                 INTEGER                             NULL,
    `funding`                 VARCHAR(16)                         NULL,
    `country`                 CHAR(2)                             NULL,

    `status`                  ENUM('ACTIVE', 'DETACHED', 'EXPIRED') NOT NULL DEFAULT 'ACTIVE',

    -- Charging while the customer is absent is lawful because they agreed to
    -- it for a stated purpose. `consentVersion` is what lets a change of terms
    -- demand a fresh agreement instead of inheriting the old one.
    `consentAcceptedAt`       DATETIME(3)                         NOT NULL,
    `consentVersion`          VARCHAR(32)                         NOT NULL,
    -- Hashed, never the address: evidence that consent came from somewhere,
    -- without making this table a worse thing to leak than it has to be.
    `consentIpHash`           VARCHAR(64)                         NULL,
    `consentUserAgent`        VARCHAR(256)                        NULL,

    `isDefault`               BOOLEAN                             NOT NULL DEFAULT FALSE,

    `detachedAt`              DATETIME(3)                         NULL,
    `createdAt`               DATETIME(3)                         NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`               DATETIME(3)                         NOT NULL,

    -- One row per instrument. A repeated SetupIntent confirmation collides
    -- here instead of giving the customer the same card twice.
    UNIQUE INDEX `uq_payment_method_provider_ref`(`provider`, `providerPaymentMethodId`),
    INDEX `ix_payment_method_customer`(`customerProfileId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `customer_payment_methods`
    ADD CONSTRAINT `customer_payment_methods_customerProfileId_fkey`
        FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`)
        ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Plans: one-shot delivery, price tolerance, edit cutoff, fulfilment, consent
-- ---------------------------------------------------------------------------
--
-- `runOnceAt` is held as well as `nextRunAt`, not instead of it. nextRunAt is
-- the worker's mutable queue key and is cleared on pause; runOnceAt is what the
-- customer asked for and never changes once authorised. Without it, pausing a
-- Buy Later would lose the date it was meant to fire on.
--
-- The two tolerance columns and `repriceApprovalThresholdMinor` are different
-- tests and all three are checked. The threshold is an absolute ceiling set
-- once; the tolerances measure drift from what the customer was last quoted,
-- as a percentage and as a floor in minor units so that 5% of a small basket
-- does not hold an occurrence over a rounding difference.
ALTER TABLE `recurring_schedules`
    ADD COLUMN `kind`                  ENUM('ONE_TIME', 'RECURRING')     NOT NULL DEFAULT 'RECURRING' AFTER `status`,
    ADD COLUMN `runOnceAt`             DATETIME(3)                       NULL     AFTER `kind`,

    ADD COLUMN `paymentMethodId`       CHAR(26)                          NULL     AFTER `payerEmail`,

    ADD COLUMN `priceTolerancePercent` DECIMAL(5, 2)                     NULL     AFTER `repriceApprovalThresholdMinor`,
    ADD COLUMN `priceToleranceMinor`   BIGINT                            NULL     AFTER `priceTolerancePercent`,
    ADD COLUMN `editCutoffMinutes`     INTEGER                           NOT NULL DEFAULT 1440 AFTER `priceToleranceMinor`,
    ADD COLUMN `substitutionPolicy`    ENUM('NEVER', 'SAVED_PREFERENCE') NOT NULL DEFAULT 'NEVER' AFTER `editCutoffMinutes`,

    ADD COLUMN `fulfilmentRule`        ENUM('AUTO', 'FIXED_LOCATION')    NOT NULL DEFAULT 'AUTO' AFTER `substitutionPolicy`,
    ADD COLUMN `inventoryLocationId`   CHAR(26)                          NULL     AFTER `fulfilmentRule`,

    ADD COLUMN `cartSnapshotJson`      JSON                              NULL     AFTER `inventoryLocationId`,
    ADD COLUMN `sourceCartId`          CHAR(26)                          NULL     AFTER `cartSnapshotJson`,

    ADD COLUMN `activatedAt`           DATETIME(3)                       NULL     AFTER `sourceCartId`,
    ADD COLUMN `completedAt`           DATETIME(3)                       NULL     AFTER `activatedAt`,

    -- DRAFT and COMPLETED appended; ACTIVE stays the default so nothing that
    -- creates a plan the old way changes behaviour.
    MODIFY `status`    ENUM('DRAFT', 'ACTIVE', 'PAUSED', 'CANCELLED', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'ACTIVE',
    MODIFY `frequency` ENUM('EVERY_N_DAYS', 'WEEKLY', 'BIWEEKLY', 'MONTHLY', 'ONE_TIME')     NOT NULL;

-- Every plan that already exists was authorised at creation time, and its
-- consent timestamp is the closest honest record of when. Leaving activatedAt
-- NULL would make an active plan look like a draft to the screens added here.
UPDATE `recurring_schedules`
   SET `activatedAt` = `consentAcceptedAt`
 WHERE `activatedAt` IS NULL
   AND `status` <> 'DRAFT';

ALTER TABLE `recurring_schedules`
    ADD CONSTRAINT `recurring_schedules_paymentMethodId_fkey`
        FOREIGN KEY (`paymentMethodId`) REFERENCES `customer_payment_methods`(`id`)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    -- RESTRICT, not CASCADE: a customer removing a card must not silently
    -- delete the plan that depends on it. The service refuses the removal and
    -- names the plans, so the customer decides what happens.
    ADD CONSTRAINT `recurring_schedules_inventoryLocationId_fkey`
        FOREIGN KEY (`inventoryLocationId`) REFERENCES `inventory_locations`(`id`)
        ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX `ix_schedule_customer_kind`   ON `recurring_schedules`(`customerProfileId`, `kind`, `status`);
CREATE INDEX `ix_schedule_payment_method`  ON `recurring_schedules`(`paymentMethodId`);
CREATE INDEX `ix_schedule_location`        ON `recurring_schedules`(`inventoryLocationId`);

-- ---------------------------------------------------------------------------
-- Plan items: the one substitution the customer actually named
-- ---------------------------------------------------------------------------
--
-- One substitute per line, no second choice and no category fallback. A
-- substitution the customer did not name is a substitution they did not
-- authorise, so an unfillable occurrence is held rather than filled with
-- something similar. Consulted only when the plan's substitutionPolicy is
-- SAVED_PREFERENCE.
ALTER TABLE `recurring_schedule_items`
    ADD COLUMN `substituteProductId`  CHAR(26)    NULL AFTER `quantity`,
    ADD COLUMN `substituteVariantId`  CHAR(26)    NULL AFTER `substituteProductId`,
    ADD COLUMN `substituteVariantKey` VARCHAR(26) NOT NULL DEFAULT '' AFTER `substituteVariantId`;

ALTER TABLE `recurring_schedule_items`
    ADD CONSTRAINT `recurring_schedule_items_substituteProductId_fkey`
        FOREIGN KEY (`substituteProductId`) REFERENCES `products`(`id`)
        ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `recurring_schedule_items_substituteVariantId_fkey`
        FOREIGN KEY (`substituteVariantId`) REFERENCES `product_variants`(`id`)
        ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX `ix_schedule_item_substitute` ON `recurring_schedule_items`(`substituteProductId`);

-- ---------------------------------------------------------------------------
-- Occurrences: nine states, a cart snapshot, and a stable idempotency key
-- ---------------------------------------------------------------------------
--
-- `paymentAttemptCount` is counted apart from `attemptCount` because a
-- validation failure that never reached Stripe must not consume a card's retry
-- budget. Banks read repeated declines as a signal about the card, and three
-- "out of stock" holds followed by one real attempt should not look to them
-- like four failed charges.
ALTER TABLE `schedule_occurrences`
    -- Copied off the plan at materialisation rather than read back from it: a
    -- customer who moves country and changes their plan's timezone must not
    -- retroactively change what time last month's order was due.
    ADD COLUMN `timezone`            VARCHAR(64)  NOT NULL DEFAULT 'UTC' AFTER `plannedRunAt`,

    ADD COLUMN `paymentAttemptCount` INTEGER      NOT NULL DEFAULT 0 AFTER `nextRetryAt`,

    -- A PaymentIntent id, written before the charge is confirmed so that a
    -- crash mid-call leaves something to reconcile against rather than a gap.
    -- Never a client secret; those are fetched from Stripe on demand.
    ADD COLUMN `paymentReference`    VARCHAR(128) NULL AFTER `actualTotalMinor`,

    ADD COLUMN `erpOrderReference`   VARCHAR(128) NULL AFTER `paymentReference`,
    ADD COLUMN `erpPushStatus`       ENUM('PENDING', 'SUCCEEDED', 'FAILED', 'ABANDONED') NULL AFTER `erpOrderReference`,

    -- Nullable for now. Backfilled and tightened below.
    ADD COLUMN `idempotencyKey`      VARCHAR(80)  NULL AFTER `erpPushStatus`,

    ADD COLUMN `cartSnapshotJson`    JSON         NULL AFTER `idempotencyKey`,

    -- Both a user skip and an engine skip end in SKIPPED, and the customer is
    -- owed a different sentence for each: "you skipped this" against "we could
    -- not supply this".
    ADD COLUMN `skippedByUser`       BOOLEAN      NOT NULL DEFAULT FALSE AFTER `cartSnapshotJson`,

    ADD COLUMN `actionRequiredAt`    DATETIME(3)  NULL AFTER `skipReason`,

    MODIFY `status` ENUM(
        'SCHEDULED', 'AWAITING_VALIDATION', 'PAYMENT_PENDING', 'ACTION_REQUIRED',
        'PROCESSING', 'PAID_ERP_PENDING', 'COMPLETED', 'SKIPPED', 'CANCELLED', 'FAILED',
        -- Retained so rows written by the previous engine still read correctly.
        -- Nothing writes these any more.
        'PENDING', 'ORDER_CREATED', 'PAID'
    ) NOT NULL DEFAULT 'SCHEDULED';

-- An existing occurrence was due in its plan's zone, whatever the column
-- default says. Correct it before anything formats a date from it.
UPDATE `schedule_occurrences` `o`
  JOIN `recurring_schedules` `s` ON `s`.`id` = `o`.`scheduleId`
   SET `o`.`timezone` = `s`.`timezone`
 WHERE `o`.`timezone` = 'UTC';

-- Backfill the key from the two fields it is derived from, so historical rows
-- carry the same value the application would compute for them.
--
-- DATE_FORMAT, not UNIX_TIMESTAMP: see the note at the top of this file.
-- %f yields six digits of microseconds and the key uses milliseconds, so it is
-- truncated to three - DATETIME(3) never holds more than that anyway.
UPDATE `schedule_occurrences`
   SET `idempotencyKey` = CONCAT(
           'occ:', `scheduleId`, ':',
           DATE_FORMAT(`plannedRunAt`, '%Y%m%d%H%i%s'),
           LPAD(FLOOR(MICROSECOND(`plannedRunAt`) / 1000), 3, '0')
       )
 WHERE `idempotencyKey` IS NULL;

-- Safe to tighten now: (scheduleId, plannedRunAt) is already unique, and the
-- key is a pure function of that pair, so the backfill cannot have produced a
-- collision.
ALTER TABLE `schedule_occurrences`
    MODIFY `idempotencyKey` VARCHAR(80) NOT NULL;

CREATE UNIQUE INDEX `uq_occurrence_idempotency`     ON `schedule_occurrences`(`idempotencyKey`);
CREATE INDEX        `ix_occurrence_reminder`        ON `schedule_occurrences`(`status`, `plannedRunAt`, `reminderSentAt`);
CREATE INDEX        `ix_occurrence_schedule_status` ON `schedule_occurrences`(`scheduleId`, `status`);

-- ---------------------------------------------------------------------------
-- The ERP hand-off, and its retries
-- ---------------------------------------------------------------------------
--
-- A separate table from `orders` because it has a different lifetime: the order
-- is finished the moment it is paid, while this row can be retried for hours
-- afterwards and has to remember what it already sent.
--
-- `orderId` is UNIQUE, and that is the structural reason a retry cannot create
-- a second ERP order. It does not depend on the retry code being careful.
-- `idempotencyKey` is sent to the ERP as its idempotency header and is the same
-- value on every attempt: an ERP that honours the header de-duplicates on its
-- own side, and one that does not is still covered by the unique orderId here.
CREATE TABLE `erp_order_pushes` (
    `id`                CHAR(26)     NOT NULL,
    `orderId`           CHAR(26)     NOT NULL,
    -- The occurrence that caused it, when a schedule did. NULL for an ordinary
    -- checkout pushed to the ERP.
    `occurrenceId`      CHAR(26)     NULL,
    -- The connector used. NULL once a connection is deleted: the ledger row
    -- outlives the configuration that made it.
    `connectionId`      CHAR(26)     NULL,

    `idempotencyKey`    VARCHAR(80)  NOT NULL,

    `status`            ENUM('PENDING', 'SUCCEEDED', 'FAILED', 'ABANDONED') NOT NULL DEFAULT 'PENDING',

    `erpOrderReference` VARCHAR(128) NULL,

    `attemptCount`      INTEGER      NOT NULL DEFAULT 0,
    `lastAttemptAt`     DATETIME(3)  NULL,
    `nextRetryAt`       DATETIME(3)  NULL,
    `succeededAt`       DATETIME(3)  NULL,

    `lastErrorCode`     VARCHAR(64)  NULL,
    `lastErrorMessage`  VARCHAR(1024) NULL,

    -- What was sent and what came back, for the argument that follows a
    -- disagreement about an order. Credentials are redacted before either is
    -- written.
    `requestJson`       JSON         NULL,
    `responseJson`      JSON         NULL,

    `createdAt`         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`         DATETIME(3)  NOT NULL,

    UNIQUE INDEX `uq_erp_push_order`(`orderId`),
    UNIQUE INDEX `uq_erp_push_occurrence`(`occurrenceId`),
    UNIQUE INDEX `uq_erp_push_idempotency`(`idempotencyKey`),
    INDEX `ix_erp_push_retry`(`status`, `nextRetryAt`),
    INDEX `ix_erp_push_connection_time`(`connectionId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `erp_order_pushes`
    ADD CONSTRAINT `erp_order_pushes_orderId_fkey`
        FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`)
        ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `erp_order_pushes_occurrenceId_fkey`
        FOREIGN KEY (`occurrenceId`) REFERENCES `schedule_occurrences`(`id`)
        ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Inventory movements: an opt-in idempotency key
-- ---------------------------------------------------------------------------
--
-- The ledger is append-only and a movement is not reversible, so a retried ERP
-- sync or a redelivered webhook posting the same delta twice would silently
-- corrupt on-hand. A caller that can name its intent passes a key, and the
-- second insert collides here instead of succeeding.
--
-- MariaDB treating every NULL in a UNIQUE index as distinct is the mechanism
-- here rather than a caveat to work around: every movement written by hand or
-- by an existing caller stays keyless and none of them collide with each other.
-- Only callers that opt in get the guarantee.
ALTER TABLE `inventory_movements`
    ADD COLUMN `dedupeKey` VARCHAR(120) NULL AFTER `referenceId`;

CREATE UNIQUE INDEX `uq_inventory_movement_dedupe` ON `inventory_movements`(`dedupeKey`);
