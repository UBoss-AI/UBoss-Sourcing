-- JOURNEY-061, 062, 064, 067 and LIVE-011: the operator's governance tools.
--
--   * admin_pending_actions - maker-checker for critical account actions
--     (suspending or refusing a seller, deactivating a customer, suspending a
--     buyer company). One member of staff asks, a different one approves, and
--     only then does the action run. `pendingKey` is set while a request is
--     PENDING and cleared when it is decided, so the UNIQUE index allows one
--     open request per action per record (a NULL is never a duplicate).
--   * exception_queue_settings - the SLA hours, owner role and escalation role
--     of each admin exception queue. A queue with no row uses its default.
--   * listing_prohibited_terms - words a listing may not contain; a hit is
--     saved as an automated flag on the listing when it is submitted.
--   * seller_listing_drafts - APPEALED status, the appeal and its decision,
--     and a structured evidence request.
--   * market_rules - LABEL_REQUIRED effect with its labelling text, and
--     market_rule_versions: a snapshot of every save and delete.
--   * content_blocks - an approval status and who submitted / approved, and
--     content_block_versions: a snapshot of every save, for rollback.
--   * feature_flags - critical_action_approval, on by default.

-- CreateTable
CREATE TABLE `admin_pending_actions` (
    `id` CHAR(26) NOT NULL,
    `kind` ENUM('SELLER_SUSPEND', 'SELLER_REJECT', 'CUSTOMER_DEACTIVATE', 'BUYER_COMPANY_SUSPEND') NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `resourceType` VARCHAR(48) NOT NULL,
    `resourceId` CHAR(26) NOT NULL,
    `resourceLabel` VARCHAR(255) NOT NULL,
    `payloadJson` JSON NOT NULL,
    `reason` VARCHAR(1000) NOT NULL,
    `pendingKey` VARCHAR(96) NULL,
    `requestedById` CHAR(26) NOT NULL,
    `requestedByEmail` VARCHAR(320) NOT NULL,
    `requestedAt` DATETIME(3) NOT NULL,
    `decidedById` CHAR(26) NULL,
    `decidedByEmail` VARCHAR(320) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` VARCHAR(1000) NULL,
    `failureMessage` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_admin_pending_action_open`(`pendingKey`),
    INDEX `ix_admin_pending_action_queue`(`status`, `requestedAt`),
    INDEX `ix_admin_pending_action_resource`(`resourceType`, `resourceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `exception_queue_settings` (
    `queueKey` VARCHAR(48) NOT NULL,
    `slaHours` INTEGER NOT NULL,
    `ownerRole` VARCHAR(64) NOT NULL,
    `escalationRole` VARCHAR(64) NOT NULL,
    `updatedById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`queueKey`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `listing_prohibited_terms` (
    `id` CHAR(26) NOT NULL,
    `term` VARCHAR(120) NOT NULL,
    `reason` VARCHAR(512) NOT NULL,
    `severity` ENUM('BLOCKER', 'WARNING', 'ADVISORY') NOT NULL DEFAULT 'WARNING',
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdById` CHAR(26) NULL,
    `updatedById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_listing_prohibited_term`(`term`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `seller_listing_drafts` MODIFY `status` ENUM('DRAFT', 'VALIDATION_FAILED', 'READY_FOR_SUBMISSION', 'PENDING_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED', 'APPEALED', 'ARCHIVED') NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN `evidenceRequestJson` JSON NULL,
    ADD COLUMN `appealReason` TEXT NULL,
    ADD COLUMN `appealedAt` DATETIME(3) NULL,
    ADD COLUMN `appealDecidedById` CHAR(26) NULL,
    ADD COLUMN `appealDecidedAt` DATETIME(3) NULL,
    ADD COLUMN `appealOutcome` VARCHAR(16) NULL;

-- AlterTable
ALTER TABLE `market_rules` MODIFY `effect` ENUM('BLOCK', 'DOCUMENTS_REQUIRED', 'LABEL_REQUIRED') NOT NULL,
    ADD COLUMN `labelText` TEXT NULL;

-- CreateTable
CREATE TABLE `market_rule_versions` (
    `id` CHAR(26) NOT NULL,
    `ruleId` CHAR(26) NOT NULL,
    `revision` INTEGER NOT NULL,
    `changeKind` ENUM('CREATED', 'UPDATED', 'DELETED') NOT NULL,
    `snapshotJson` JSON NOT NULL,
    `changedById` CHAR(26) NULL,
    `changedByEmail` VARCHAR(320) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_market_rule_version`(`ruleId`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `content_blocks` ADD COLUMN `status` ENUM('DRAFT', 'PENDING_APPROVAL', 'PUBLISHED') NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN `revision` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `submittedById` CHAR(26) NULL,
    ADD COLUMN `submittedAt` DATETIME(3) NULL,
    ADD COLUMN `approvedById` CHAR(26) NULL,
    ADD COLUMN `approvedAt` DATETIME(3) NULL;

-- A block already live before approval existed stays live.
UPDATE `content_blocks` SET `status` = 'PUBLISHED' WHERE `isPublished` = true;

-- CreateTable
CREATE TABLE `content_block_versions` (
    `id` CHAR(26) NOT NULL,
    `blockId` CHAR(26) NOT NULL,
    `revision` INTEGER NOT NULL,
    `snapshotJson` JSON NOT NULL,
    `savedById` CHAR(26) NULL,
    `savedByEmail` VARCHAR(320) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_content_block_version`(`blockId`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `content_block_versions` ADD CONSTRAINT `fk_content_block_version_block` FOREIGN KEY (`blockId`) REFERENCES `content_blocks`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- The email a member of staff sends a customer or seller from the admin panel.
-- Editable like any other template; the subject and message are what staff wrote.
INSERT IGNORE INTO `notification_settings` (`id`, `eventKey`, `name`, `emailEnabled`, `smsEnabled`, `whatsappEnabled`, `inAppEnabled`, `subjectTemplate`, `bodyTemplate`, `isActive`, `createdAt`, `updatedAt`)
VALUES ('01K8Z0STAFFMESSAGE00000000', 'account.staff_message', 'Message from the marketplace team', true, false, false, true,
        '{{subject}}', 'Hello {{recipientName}},\n\n{{message}}\n\n{{businessName}}\n{{supportEmail}}\n', true,
        CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

-- Maker-checker for critical account actions, on unless the operator turns it off.
INSERT IGNORE INTO `feature_flags` (`id`, `key`, `enabled`, `description`, `updatedAt`, `createdAt`)
VALUES ('01K8Z0CR1T1CA7APPR0VA7F7AG', 'critical_action_approval', true,
        'Suspending or refusing a seller, deactivating a customer and suspending a buyer company need a second member of staff to approve.',
        CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));
