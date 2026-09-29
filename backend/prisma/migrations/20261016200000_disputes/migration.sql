-- Disputes (buyer claims and payment chargebacks), their history and evidence,
-- the operator's dispute settings, and support-ticket service levels.
-- See the DISPUTES block and `SupportSlaPolicy` in schema.prisma.
--
-- New tables and nullable/defaulted columns only, so it is safe on a live
-- installation. Every foreign key is ON UPDATE RESTRICT: the parents' keys are
-- ULIDs that never change, and it keeps MariaDB 11.4 content with the CHECKs.

-- AlterTable
ALTER TABLE `support_ticket_attachments` ADD COLUMN `uploadedByStaff` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `support_tickets` ADD COLUMN `firstRespondedAt` DATETIME(3) NULL,
    ADD COLUMN `firstResponseDueAt` DATETIME(3) NULL,
    ADD COLUMN `resolutionCode` ENUM('ANSWERED', 'FIXED', 'REFUNDED', 'REPLACED', 'REFERRED', 'DUPLICATE', 'NO_RESPONSE', 'NO_ACTION') NULL,
    ADD COLUMN `resolutionDueAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `support_sla_policies` (
    `id` CHAR(26) NOT NULL,
    `category` ENUM('ORDERS', 'PAYMENTS', 'PREORDERS', 'PRODUCTS', 'SELLER_HUB', 'LOGISTICS', 'COMPANY_VERIFICATION', 'ERP_INTEGRATION', 'ACCOUNT_SECURITY', 'OTHER') NOT NULL,
    `firstResponseHours` SMALLINT NOT NULL,
    `resolutionHours` SMALLINT NOT NULL,
    `updatedById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_support_sla_policy_category`(`category`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `disputes` (
    `id` CHAR(26) NOT NULL,
    `reference` VARCHAR(16) NOT NULL,
    `kind` ENUM('CLAIM', 'CHARGEBACK') NOT NULL,
    `status` ENUM('AWAITING_SELLER', 'UNDER_REVIEW', 'PENDING_APPROVAL', 'RESOLVED', 'REJECTED', 'APPEALED', 'WITHDRAWN', 'CHARGEBACK_OPEN', 'NEEDS_RESPONSE', 'CHARGEBACK_UNDER_REVIEW', 'WON', 'LOST') NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `orderItemId` CHAR(26) NULL,
    `sellerOrderGroupId` CHAR(26) NULL,
    `sellerAccountId` CHAR(26) NULL,
    `customerProfileId` CHAR(26) NOT NULL,
    `raisedByUserId` CHAR(26) NULL,
    `reasonCode` VARCHAR(40) NOT NULL,
    `description` TEXT NULL,
    `desiredOutcome` ENUM('REFUND_FULL', 'REFUND_PARTIAL', 'REPLACEMENT', 'REJECT') NULL,
    `requestedAmountMinor` BIGINT NULL,
    `currency` CHAR(3) NOT NULL,
    `sellerResponseDueAt` DATETIME(3) NULL,
    `decisionDueAt` DATETIME(3) NULL,
    `sellerRespondedAt` DATETIME(3) NULL,
    `sellerProposal` ENUM('REFUND_FULL', 'REFUND_PARTIAL', 'REPLACEMENT', 'REJECT') NULL,
    `sellerProposalAmountMinor` BIGINT NULL,
    `assignedAdminId` CHAR(26) NULL,
    `proposedResolution` ENUM('REFUND_FULL', 'REFUND_PARTIAL', 'REPLACEMENT', 'REJECT') NULL,
    `proposedAmountMinor` BIGINT NULL,
    `proposedReason` VARCHAR(1000) NULL,
    `proposedById` CHAR(26) NULL,
    `proposedAt` DATETIME(3) NULL,
    `resolution` ENUM('REFUND_FULL', 'REFUND_PARTIAL', 'REPLACEMENT', 'REJECT') NULL,
    `resolutionAmountMinor` BIGINT NULL,
    `decisionReason` VARCHAR(1000) NULL,
    `decidedById` CHAR(26) NULL,
    `approvedById` CHAR(26) NULL,
    `decidedAt` DATETIME(3) NULL,
    `refundId` CHAR(26) NULL,
    `appealDueAt` DATETIME(3) NULL,
    `appealCount` TINYINT NOT NULL DEFAULT 0,
    `providerDisputeId` VARCHAR(128) NULL,
    `paymentTransactionId` CHAR(26) NULL,
    `providerStatus` VARCHAR(40) NULL,
    `evidenceDueAt` DATETIME(3) NULL,
    `disputedAmountMinor` BIGINT NULL,
    `closedAt` DATETIME(3) NULL,
    `lastActivityAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_dispute_reference`(`reference`),
    UNIQUE INDEX `uq_dispute_provider_dispute`(`providerDisputeId`),
    INDEX `ix_dispute_status`(`status`, `lastActivityAt`),
    INDEX `ix_dispute_kind_status`(`kind`, `status`),
    INDEX `ix_dispute_order`(`orderId`),
    INDEX `ix_dispute_order_item`(`orderItemId`),
    INDEX `ix_dispute_seller_group`(`sellerOrderGroupId`),
    INDEX `ix_dispute_seller`(`sellerAccountId`, `status`),
    INDEX `ix_dispute_customer`(`customerProfileId`, `createdAt`),
    INDEX `ix_dispute_raised_by`(`raisedByUserId`),
    INDEX `ix_dispute_assignee`(`assignedAdminId`, `status`),
    INDEX `ix_dispute_refund`(`refundId`),
    INDEX `ix_dispute_payment`(`paymentTransactionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dispute_events` (
    `id` CHAR(26) NOT NULL,
    `disputeId` CHAR(26) NOT NULL,
    `kind` ENUM('CREATED', 'MESSAGE', 'INTERNAL_NOTE', 'EVIDENCE_ADDED', 'STATUS_CHANGED', 'SELLER_RESPONSE', 'ESCALATED', 'WITHDRAWN', 'ASSIGNED', 'DECISION_PROPOSED', 'DECISION_APPROVED', 'DECISION_REFUSED', 'DECISION_APPLIED', 'APPEALED', 'PROVIDER_UPDATE', 'EVIDENCE_NOTE') NOT NULL,
    `party` ENUM('BUYER', 'SELLER', 'STAFF', 'PROVIDER', 'SYSTEM') NOT NULL,
    `visibleToBuyer` BOOLEAN NOT NULL,
    `visibleToSeller` BOOLEAN NOT NULL,
    `actorUserId` CHAR(26) NULL,
    `body` TEXT NULL,
    `fromValue` VARCHAR(40) NULL,
    `toValue` VARCHAR(40) NULL,
    `amountMinor` BIGINT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_dispute_event_dispute`(`disputeId`, `createdAt`),
    INDEX `ix_dispute_event_actor`(`actorUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dispute_attachments` (
    `id` CHAR(26) NOT NULL,
    `disputeId` CHAR(26) NOT NULL,
    `party` ENUM('BUYER', 'SELLER', 'STAFF', 'PROVIDER', 'SYSTEM') NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `fileName` VARCHAR(255) NOT NULL,
    `contentType` VARCHAR(128) NOT NULL,
    `kind` ENUM('IMAGE', 'VIDEO', 'DOCUMENT') NOT NULL,
    `byteSize` INTEGER NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `scanState` ENUM('CLEAN', 'SCANNER_UNCONFIGURED') NOT NULL,
    `uploadedByUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_dispute_attachment_dispute`(`disputeId`, `createdAt`),
    INDEX `ix_dispute_attachment_uploader`(`uploadedByUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `dispute_settings` (
    `id` CHAR(26) NOT NULL,
    `version` INTEGER NOT NULL DEFAULT 0,
    `claimWindowDays` SMALLINT NOT NULL,
    `sellerResponseHours` SMALLINT NOT NULL,
    `decisionHours` SMALLINT NOT NULL,
    `appealWindowDays` SMALLINT NOT NULL,
    `approvalThresholdMinor` BIGINT NOT NULL,
    `approvalCurrency` CHAR(3) NOT NULL,
    `enabledReasonsJson` JSON NOT NULL,
    `updatedById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `disputes` ADD CONSTRAINT `fk_dispute_order` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `disputes` ADD CONSTRAINT `fk_dispute_order_item` FOREIGN KEY (`orderItemId`) REFERENCES `order_items`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `disputes` ADD CONSTRAINT `fk_dispute_seller_group` FOREIGN KEY (`sellerOrderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `disputes` ADD CONSTRAINT `fk_dispute_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `disputes` ADD CONSTRAINT `fk_dispute_customer` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `disputes` ADD CONSTRAINT `fk_dispute_raised_by` FOREIGN KEY (`raisedByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `disputes` ADD CONSTRAINT `fk_dispute_assignee` FOREIGN KEY (`assignedAdminId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `disputes` ADD CONSTRAINT `fk_dispute_refund` FOREIGN KEY (`refundId`) REFERENCES `refunds`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `disputes` ADD CONSTRAINT `fk_dispute_payment` FOREIGN KEY (`paymentTransactionId`) REFERENCES `payment_transactions`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `dispute_events` ADD CONSTRAINT `fk_dispute_event_dispute` FOREIGN KEY (`disputeId`) REFERENCES `disputes`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `dispute_events` ADD CONSTRAINT `fk_dispute_event_actor` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `dispute_attachments` ADD CONSTRAINT `fk_dispute_attachment_dispute` FOREIGN KEY (`disputeId`) REFERENCES `disputes`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `dispute_attachments` ADD CONSTRAINT `fk_dispute_attachment_uploader` FOREIGN KEY (`uploadedByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;


-- Money on a dispute is never negative.
ALTER TABLE `disputes` ADD CONSTRAINT `chk_dispute_amounts_non_negative` CHECK (
    (`requestedAmountMinor` IS NULL OR `requestedAmountMinor` >= 0)
    AND (`sellerProposalAmountMinor` IS NULL OR `sellerProposalAmountMinor` >= 0)
    AND (`proposedAmountMinor` IS NULL OR `proposedAmountMinor` >= 0)
    AND (`resolutionAmountMinor` IS NULL OR `resolutionAmountMinor` >= 0)
    AND (`disputedAmountMinor` IS NULL OR `disputedAmountMinor` >= 0)
);

-- A chargeback is always the provider's dispute, and is keyed on it.
ALTER TABLE `disputes` ADD CONSTRAINT `chk_dispute_chargeback_has_provider` CHECK (
    `kind` <> 'CHARGEBACK' OR `providerDisputeId` IS NOT NULL
);

-- Service levels are positive, and the resolution target is not before the first reply.
ALTER TABLE `support_sla_policies` ADD CONSTRAINT `chk_support_sla_policy_hours` CHECK (
    `firstResponseHours` > 0 AND `resolutionHours` >= `firstResponseHours`
);
