-- Exchange rate snapshots: keeping what the feed said, not just what it did.
--
-- Until now the refresh job fetched rates, rewrote prices with them and threw
-- the rates away. Two tables fix that, and one column on `orders` makes an
-- individual total explainable afterwards.
--
-- SAFE TO RUN ON A LIVE DEPLOYMENT
--
--   * Every added column is nullable or carries a default, so no backfill is
--     needed and no existing row changes meaning.
--   * `currency_rate_sync.provider` defaults to 'json', which is the feed an
--     upgrading deployment is already using. Nothing switches to the ECB by
--     itself; that is a configuration change somebody makes.
--   * `currency_rate_sync.deriveMissingPrices` defaults to false, so the
--     existing rule - a SKU with no price row in a currency is not sellable in
--     it - stays exactly as it was until an operator turns derivation on.
--   * `orders.fx*` are all NULL for every order already placed. NULL means
--     "this predates the record", which is a different statement from a
--     fabricated rate of 1.0, and the reporting reads it that way.
--
-- ROLLBACK
--
-- Dropping the two tables and the `orders.fx*` columns restores the previous
-- shape exactly. Nothing else reads them, and no existing column is altered.
-- Drop the foreign key `orders_fxSnapshotId_fkey` first.
--
-- MARIADB NOTE
--
-- `uq_fx_snapshot_active_provider` is a UNIQUE index over a NULLABLE column,
-- which is the "one active snapshot per provider" rule. MariaDB treats every
-- NULL in a UNIQUE index as distinct, so retired snapshots (activeProvider
-- NULL) do not collide and two concurrent activations cannot both win.

-- AlterTable
ALTER TABLE `currency_rate_sync` ADD COLUMN `alertMaxAgeHours` INTEGER NOT NULL DEFAULT 72,
    ADD COLUMN `checkoutMaxAgeHours` INTEGER NOT NULL DEFAULT 96,
    ADD COLUMN `consecutiveFailures` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `deriveMissingPrices` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `displayMaxAgeHours` INTEGER NOT NULL DEFAULT 168,
    ADD COLUMN `lastFailureAt` DATETIME(3) NULL,
    ADD COLUMN `lastSuccessAt` DATETIME(3) NULL,
    ADD COLUMN `provider` VARCHAR(32) NOT NULL DEFAULT 'json',
    ADD COLUMN `quoteTtlSeconds` INTEGER NOT NULL DEFAULT 900;

-- AlterTable
ALTER TABLE `orders` ADD COLUMN `fxAdjustmentPercent` DECIMAL(5, 2) NULL,
    ADD COLUMN `fxBaseCurrency` CHAR(3) NULL,
    ADD COLUMN `fxBaseGrandTotalMinor` BIGINT NULL,
    ADD COLUMN `fxMidRate` DECIMAL(24, 12) NULL,
    ADD COLUMN `fxPolicyVersion` VARCHAR(32) NULL,
    ADD COLUMN `fxPriceSource` ENUM('MANUAL', 'CONVERTED') NULL,
    ADD COLUMN `fxProvider` VARCHAR(32) NULL,
    ADD COLUMN `fxRateAsOf` DATETIME(3) NULL,
    ADD COLUMN `fxRateUsed` DECIMAL(24, 12) NULL,
    ADD COLUMN `fxSnapshotId` CHAR(26) NULL;

-- CreateTable
CREATE TABLE `exchange_rate_snapshots` (
    `id` CHAR(26) NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `pivotCurrency` CHAR(3) NOT NULL,
    `asOf` DATETIME(3) NOT NULL,
    `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sourceReference` VARCHAR(512) NOT NULL,
    `retrievalStatus` ENUM('FETCHED', 'FAILED') NOT NULL DEFAULT 'FETCHED',
    `validationStatus` ENUM('PENDING', 'VALID', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `failureReason` VARCHAR(512) NULL,
    `rateCount` INTEGER NOT NULL DEFAULT 0,
    `rejectedCount` INTEGER NOT NULL DEFAULT 0,
    `maxDriftPercent` DECIMAL(9, 4) NULL,
    `maxDriftCurrency` CHAR(3) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT false,
    `activeProvider` VARCHAR(32) NULL,
    `activatedAt` DATETIME(3) NULL,
    `retiredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_fx_snapshot_active`(`provider`, `isActive`),
    INDEX `ix_fx_snapshot_provider_asof`(`provider`, `asOf`),
    INDEX `ix_fx_snapshot_validation`(`validationStatus`, `fetchedAt`),
    UNIQUE INDEX `uq_fx_snapshot_active_provider`(`activeProvider`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `exchange_rates` (
    `id` CHAR(26) NOT NULL,
    `snapshotId` CHAR(26) NOT NULL,
    `baseCurrency` CHAR(3) NOT NULL,
    `quoteCurrency` CHAR(3) NOT NULL,
    `rate` DECIMAL(24, 12) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_exchange_rate_currency_time`(`quoteCurrency`, `createdAt`),
    UNIQUE INDEX `uq_exchange_rate_snapshot_currency`(`snapshotId`, `quoteCurrency`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ix_order_fx_snapshot` ON `orders`(`fxSnapshotId`);

-- AddForeignKey
ALTER TABLE `orders` ADD CONSTRAINT `orders_fxSnapshotId_fkey` FOREIGN KEY (`fxSnapshotId`) REFERENCES `exchange_rate_snapshots`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `exchange_rates` ADD CONSTRAINT `exchange_rates_snapshotId_fkey` FOREIGN KEY (`snapshotId`) REFERENCES `exchange_rate_snapshots`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

