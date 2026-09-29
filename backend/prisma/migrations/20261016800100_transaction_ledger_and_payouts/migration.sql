-- The transaction ledger, held funds and Stripe Connect payouts.
--
-- ledger_accounts / ledger_entries / ledger_lines are an append-only,
-- double-entry journal: every entry's lines are in one currency and sum to
-- zero (the service refuses anything else, and reconciliation re-checks it).
-- A line is never zero. A correction is a REVERSAL entry naming the entry it
-- undoes, at most once. The application account is given no UPDATE or DELETE
-- on these three tables by deploy/mariadb/post-migrate-grants.sql.
--
-- seller_fund_holds is the protected-collection record for each seller order:
-- its disclosed release terms and whether they are met.
-- seller_fund_release_requests is the maker-checker for a manual release:
-- the database itself refuses a decision by the person who asked.
--
-- New tables only, plus nullable/defaulted columns on two payout tables: no
-- existing row changes.

-- AlterTable
ALTER TABLE `seller_payout_account_references` ADD COLUMN `bankAccountStatus` VARCHAR(32) NULL,
    ADD COLUMN `detailsSubmitted` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `lastBankPayoutAt` DATETIME(3) NULL,
    ADD COLUMN `lastBankPayoutStatus` VARCHAR(32) NULL;

-- AlterTable
ALTER TABLE `seller_payouts` ADD COLUMN `deadLetteredAt` DATETIME(3) NULL,
    ADD COLUMN `lastAttemptError` VARCHAR(512) NULL;

-- CreateTable
CREATE TABLE `ledger_accounts` (
    `id` CHAR(26) NOT NULL,
    `code` ENUM('PROVIDER_BALANCE', 'BUYER_FUNDS_CLEARING', 'SELLER_HELD', 'SELLER_RESERVE', 'SELLER_AVAILABLE', 'PAYOUTS_IN_TRANSIT', 'PLATFORM_COMMISSION', 'PLATFORM_FEE_TAX', 'CHARGEBACK_RECEIVABLE', 'CHARGEBACK_LOSSES') NOT NULL,
    `ownerKey` VARCHAR(32) NOT NULL,
    `sellerAccountId` CHAR(26) NULL,
    `currency` CHAR(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_ledger_account_seller`(`sellerAccountId`, `code`),
    UNIQUE INDEX `uq_ledger_account`(`code`, `ownerKey`, `currency`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ledger_entries` (
    `id` CHAR(26) NOT NULL,
    `kind` ENUM('PAYMENT_CAPTURED', 'SALE_ALLOCATED', 'REFUND_ISSUED', 'REFUND_CHARGED_TO_SELLER', 'FUNDS_RELEASED', 'RESERVE_RELEASED', 'PAYOUT_INITIATED', 'PAYOUT_SETTLED', 'CHARGEBACK_OPENED', 'CHARGEBACK_WON', 'CHARGEBACK_LOST', 'CHARGEBACK_FEE', 'REVERSAL') NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `orderId` CHAR(26) NULL,
    `sellerOrderGroupId` CHAR(26) NULL,
    `sellerAccountId` CHAR(26) NULL,
    `paymentTransactionId` CHAR(26) NULL,
    `refundId` CHAR(26) NULL,
    `payoutId` CHAR(26) NULL,
    `disputeId` CHAR(26) NULL,
    `providerReference` VARCHAR(128) NULL,
    `reversesEntryId` CHAR(26) NULL,
    `memo` VARCHAR(255) NOT NULL,
    `actorLabel` VARCHAR(160) NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_ledger_entry_order`(`orderId`),
    INDEX `ix_ledger_entry_group`(`sellerOrderGroupId`),
    INDEX `ix_ledger_entry_seller`(`sellerAccountId`, `occurredAt`),
    INDEX `ix_ledger_entry_provider_ref`(`providerReference`),
    INDEX `ix_ledger_entry_kind`(`kind`, `occurredAt`),
    UNIQUE INDEX `uq_ledger_entry_idempotency`(`idempotencyKey`),
    UNIQUE INDEX `uq_ledger_entry_reverses`(`reversesEntryId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ledger_lines` (
    `id` CHAR(26) NOT NULL,
    `entryId` CHAR(26) NOT NULL,
    `accountId` CHAR(26) NOT NULL,
    `amountMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,

    INDEX `ix_ledger_line_entry`(`entryId`),
    INDEX `ix_ledger_line_account`(`accountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_fund_holds` (
    `id` CHAR(26) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `status` ENUM('HELD', 'ON_HOLD', 'RELEASED') NOT NULL DEFAULT 'HELD',
    `allocatedMinor` BIGINT NOT NULL,
    `releasedMinor` BIGINT NOT NULL DEFAULT 0,
    `reserveMinor` BIGINT NOT NULL DEFAULT 0,
    `termsJson` JSON NOT NULL,
    `conditionsJson` JSON NULL,
    `holdCode` ENUM('DISPUTE', 'MANUAL') NULL,
    `holdReason` VARCHAR(1000) NULL,
    `holdPlacedBy` VARCHAR(160) NULL,
    `holdPlacedAt` DATETIME(3) NULL,
    `releaseKind` VARCHAR(16) NULL,
    `releaseReason` VARCHAR(1000) NULL,
    `releasedAt` DATETIME(3) NULL,
    `reserveReleaseAt` DATETIME(3) NULL,
    `reserveReleasedAt` DATETIME(3) NULL,
    `payoutId` CHAR(26) NULL,
    `lastEvaluatedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_fund_hold_status`(`status`, `lastEvaluatedAt`),
    INDEX `ix_seller_fund_hold_seller`(`sellerAccountId`, `status`),
    INDEX `ix_seller_fund_hold_order`(`orderId`),
    INDEX `ix_seller_fund_hold_reserve`(`reserveReleaseAt`),
    UNIQUE INDEX `uq_seller_fund_hold_group`(`sellerOrderGroupId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seller_fund_release_requests` (
    `id` CHAR(26) NOT NULL,
    `fundHoldId` CHAR(26) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `reason` VARCHAR(1000) NOT NULL,
    `requestedById` CHAR(26) NOT NULL,
    `requestedByLabel` VARCHAR(160) NOT NULL,
    `requestedAt` DATETIME(3) NOT NULL,
    `decidedById` CHAR(26) NULL,
    `decidedByLabel` VARCHAR(160) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` VARCHAR(1000) NULL,
    `pendingKey` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_seller_fund_release_hold`(`fundHoldId`, `requestedAt`),
    INDEX `ix_seller_fund_release_status`(`status`, `requestedAt`),
    UNIQUE INDEX `uq_seller_fund_release_pending`(`pendingKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payout_provider_events` (
    `id` CHAR(26) NOT NULL,
    `provider` VARCHAR(48) NOT NULL,
    `providerEventId` VARCHAR(128) NOT NULL,
    `eventType` VARCHAR(96) NOT NULL,
    `accountRef` VARCHAR(128) NULL,
    `status` VARCHAR(16) NOT NULL,
    `note` VARCHAR(512) NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,

    INDEX `ix_payout_provider_event_type`(`eventType`, `receivedAt`),
    UNIQUE INDEX `uq_payout_provider_event`(`provider`, `providerEventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ledger_reconciliation_runs` (
    `id` CHAR(26) NOT NULL,
    `provider` VARCHAR(48) NOT NULL,
    `periodStart` DATETIME(3) NOT NULL,
    `periodEnd` DATETIME(3) NOT NULL,
    `status` ENUM('RUNNING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'RUNNING',
    `providerTransactionCount` INTEGER NOT NULL DEFAULT 0,
    `matchedCount` INTEGER NOT NULL DEFAULT 0,
    `mismatchCount` INTEGER NOT NULL DEFAULT 0,
    `startedByLabel` VARCHAR(160) NOT NULL,
    `errorMessage` VARCHAR(1000) NULL,
    `startedAt` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,

    INDEX `ix_ledger_recon_run_started`(`startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ledger_reconciliation_items` (
    `id` CHAR(26) NOT NULL,
    `runId` CHAR(26) NOT NULL,
    `kind` ENUM('MATCHED', 'AMOUNT_MISMATCH', 'MISSING_IN_LEDGER', 'MISSING_AT_PROVIDER', 'CURRENCY_CONVERTED', 'UNBALANCED_ENTRY', 'STATEMENT_MISMATCH') NOT NULL,
    `providerReference` VARCHAR(128) NULL,
    `providerType` VARCHAR(48) NULL,
    `providerAmountMinor` BIGINT NULL,
    `ledgerAmountMinor` BIGINT NULL,
    `currency` CHAR(3) NULL,
    `ledgerEntryId` CHAR(26) NULL,
    `note` VARCHAR(512) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_ledger_recon_item_run`(`runId`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ledger_lines` ADD CONSTRAINT `fk_ledger_line_entry` FOREIGN KEY (`entryId`) REFERENCES `ledger_entries`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `ledger_lines` ADD CONSTRAINT `fk_ledger_line_account` FOREIGN KEY (`accountId`) REFERENCES `ledger_accounts`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `ledger_reconciliation_items` ADD CONSTRAINT `fk_ledger_recon_item_run` FOREIGN KEY (`runId`) REFERENCES `ledger_reconciliation_runs`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;


-- The rules the database can hold on its own.
ALTER TABLE `ledger_lines` ADD CONSTRAINT `chk_ledger_line_nonzero` CHECK (`amountMinor` <> 0);
ALTER TABLE `ledger_entries` ADD CONSTRAINT `chk_ledger_entry_reversal` CHECK ((`kind` = 'REVERSAL') = (`reversesEntryId` IS NOT NULL));
ALTER TABLE `seller_fund_holds` ADD CONSTRAINT `chk_fund_hold_amounts` CHECK (`releasedMinor` >= 0 AND `reserveMinor` >= 0);
ALTER TABLE `seller_fund_holds` ADD CONSTRAINT `chk_fund_hold_code` CHECK ((`status` = 'ON_HOLD') = (`holdCode` IS NOT NULL));
ALTER TABLE `seller_fund_release_requests` ADD CONSTRAINT `chk_fund_release_pending` CHECK ((`status` = 'PENDING') = (`pendingKey` IS NOT NULL));
ALTER TABLE `seller_fund_release_requests` ADD CONSTRAINT `chk_fund_release_not_self` CHECK (`decidedById` IS NULL OR `decidedById` <> `requestedById`);
