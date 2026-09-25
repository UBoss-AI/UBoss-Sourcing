-- Preorder chat: a signed-in buyer asking the operator's team about a preorder,
-- from the product page. Customer <-> operator staff only; no seller reads
-- these tables. See the PREORDER CHAT section of schema.prisma.
--
-- `activeKey` is UNIQUE and NULL once a conversation is closed: MariaDB treats
-- every NULL as distinct, so any number of closed conversations may share a
-- product while two live ones cannot.
--
-- `realtime_events` carries references between API processes under
-- REALTIME_BUS_DRIVER=database. Ids only, never message bodies, and pruned
-- within minutes.

-- CreateTable
CREATE TABLE `preorder_chat_conversations` (
    `id` CHAR(26) NOT NULL,
    `customerProfileId` CHAR(26) NOT NULL,
    `startedByUserId` CHAR(26) NOT NULL,
    `productId` CHAR(26) NOT NULL,
    `variantId` CHAR(26) NULL,
    `variantKey` VARCHAR(26) NOT NULL DEFAULT '',
    `sellerAccountId` CHAR(26) NULL,
    `offerId` CHAR(26) NULL,
    `preorderRequestId` CHAR(26) NULL,
    `preorderKey` VARCHAR(26) NOT NULL DEFAULT '',
    `activeKey` VARCHAR(120) NULL,
    `status` ENUM('NEW', 'OPEN', 'WAITING_FOR_CUSTOMER', 'WAITING_FOR_INTERNAL', 'RESOLVED', 'CLOSED', 'SPAM', 'BLOCKED') NOT NULL DEFAULT 'NEW',
    `priority` ENUM('LOW', 'NORMAL', 'HIGH', 'URGENT') NOT NULL DEFAULT 'NORMAL',
    `assignedAdminId` CHAR(26) NULL,
    `assignedAt` DATETIME(3) NULL,
    `customerLocale` VARCHAR(10) NOT NULL DEFAULT 'en',
    `contextSnapshotJson` JSON NOT NULL,
    `productName` VARCHAR(255) NOT NULL,
    `productSku` VARCHAR(96) NULL,
    `sellerName` VARCHAR(255) NULL,
    `tagsJson` JSON NULL,
    `lastSequence` INTEGER NOT NULL DEFAULT 0,
    `customerMessageCount` INTEGER NOT NULL DEFAULT 0,
    `staffMessageCount` INTEGER NOT NULL DEFAULT 0,
    `customerReadStaffCount` INTEGER NOT NULL DEFAULT 0,
    `staffReadCustomerCount` INTEGER NOT NULL DEFAULT 0,
    `customerDeliveredSeq` INTEGER NOT NULL DEFAULT 0,
    `customerReadSeq` INTEGER NOT NULL DEFAULT 0,
    `staffDeliveredSeq` INTEGER NOT NULL DEFAULT 0,
    `staffReadSeq` INTEGER NOT NULL DEFAULT 0,
    `lastMessagePreview` VARCHAR(200) NULL,
    `lastMessageSender` ENUM('CUSTOMER', 'ADMIN', 'SYSTEM') NULL,
    `lastMessageAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastCustomerMessageAt` DATETIME(3) NULL,
    `lastStaffMessageAt` DATETIME(3) NULL,
    `awaitingReplySince` DATETIME(3) NULL,
    `firstResponseAt` DATETIME(3) NULL,
    `customerEmailedSeq` INTEGER NOT NULL DEFAULT 0,
    `slaAlertedAt` DATETIME(3) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `reopenCount` INTEGER NOT NULL DEFAULT 0,
    `version` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_preorder_chat_active`(`activeKey`),
    INDEX `ix_preorder_chat_customer`(`customerProfileId`, `lastMessageAt`),
    INDEX `ix_preorder_chat_status`(`status`, `lastMessageAt`),
    INDEX `ix_preorder_chat_assignee`(`assignedAdminId`, `status`, `lastMessageAt`),
    INDEX `ix_preorder_chat_waiting`(`awaitingReplySince`),
    INDEX `ix_preorder_chat_product`(`productId`),
    INDEX `ix_preorder_chat_preorder`(`preorderRequestId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `preorder_chat_participants` (
    `id` CHAR(26) NOT NULL,
    `conversationId` CHAR(26) NOT NULL,
    `participantType` ENUM('CUSTOMER', 'ADMIN') NOT NULL,
    `userId` CHAR(26) NOT NULL,
    `lastReadSeq` INTEGER NOT NULL DEFAULT 0,
    `lastReadAt` DATETIME(3) NULL,
    `joinedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_preorder_chat_participant_user`(`userId`),
    UNIQUE INDEX `uq_preorder_chat_participant`(`conversationId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `preorder_chat_messages` (
    `id` CHAR(26) NOT NULL,
    `conversationId` CHAR(26) NOT NULL,
    `serverSequence` INTEGER NOT NULL,
    `senderType` ENUM('CUSTOMER', 'ADMIN', 'SYSTEM') NOT NULL,
    `senderUserId` CHAR(26) NULL,
    `senderKey` VARCHAR(40) NOT NULL,
    `clientMessageId` VARCHAR(80) NOT NULL,
    `messageType` ENUM('TEXT', 'ATTACHMENT', 'SYSTEM_EVENT', 'STRUCTURED_OFFER') NOT NULL DEFAULT 'TEXT',
    `body` TEXT NOT NULL,
    `systemEvent` VARCHAR(48) NULL,
    `systemMetaJson` JSON NULL,
    `replyToMessageId` CHAR(26) NULL,
    `proposalId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `deliveredAt` DATETIME(3) NULL,
    `editedAt` DATETIME(3) NULL,
    `redactedAt` DATETIME(3) NULL,
    `redactedByUserId` CHAR(26) NULL,
    `redactionReason` VARCHAR(255) NULL,

    INDEX `ix_preorder_chat_message_sender`(`senderKey`, `createdAt`),
    UNIQUE INDEX `uq_preorder_chat_message_seq`(`conversationId`, `serverSequence`),
    UNIQUE INDEX `uq_preorder_chat_message_client`(`senderKey`, `clientMessageId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `preorder_chat_notes` (
    `id` CHAR(26) NOT NULL,
    `conversationId` CHAR(26) NOT NULL,
    `authorUserId` CHAR(26) NOT NULL,
    `body` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_preorder_chat_note_conversation`(`conversationId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `preorder_chat_proposals` (
    `id` CHAR(26) NOT NULL,
    `conversationId` CHAR(26) NOT NULL,
    `revision` INTEGER NOT NULL,
    `state` ENUM('PROPOSED', 'SUPERSEDED', 'WITHDRAWN', 'DECLINED', 'SUBMITTED', 'EXPIRED') NOT NULL DEFAULT 'PROPOSED',
    `orderingUnit` ENUM('PIECE', 'CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER', 'CONTAINER_20_FT', 'CONTAINER_40_FT') NOT NULL,
    `unitQuantity` INTEGER NOT NULL,
    `equivalentBaseUnits` INTEGER NOT NULL,
    `indicativeUnitPriceMinor` BIGINT NULL,
    `currency` CHAR(3) NOT NULL,
    `availabilityNote` VARCHAR(500) NULL,
    `deliveryDate` DATE NOT NULL,
    `splitDeliveriesJson` JSON NULL,
    `termsNote` VARCHAR(1000) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `createdByUserId` CHAR(26) NOT NULL,
    `preorderRequestId` CHAR(26) NULL,
    `respondedAt` DATETIME(3) NULL,
    `declineReason` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_preorder_chat_proposal_request`(`preorderRequestId`),
    UNIQUE INDEX `uq_preorder_chat_proposal_revision`(`conversationId`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `preorder_chat_attachments` (
    `id` CHAR(26) NOT NULL,
    `conversationId` CHAR(26) NOT NULL,
    `messageId` CHAR(26) NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `fileName` VARCHAR(255) NOT NULL,
    `contentType` VARCHAR(128) NOT NULL,
    `byteSize` INTEGER NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `scanState` ENUM('CLEAN', 'SCANNER_UNCONFIGURED') NOT NULL,
    `uploadedByUserId` CHAR(26) NOT NULL,
    `uploaderType` ENUM('CUSTOMER', 'ADMIN', 'SYSTEM') NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_preorder_chat_attachment_message`(`messageId`),
    INDEX `ix_preorder_chat_attachment_conversation`(`conversationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `preorder_chat_customer_blocks` (
    `id` CHAR(26) NOT NULL,
    `customerProfileId` CHAR(26) NOT NULL,
    `reason` VARCHAR(500) NOT NULL,
    `blockedByUserId` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_preorder_chat_block_customer`(`customerProfileId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `realtime_events` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `instanceId` VARCHAR(40) NOT NULL,
    `payloadJson` JSON NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_realtime_event_time`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `preorder_chat_conversations` ADD CONSTRAINT `fk_preorder_chat_customer` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_chat_conversations` ADD CONSTRAINT `fk_preorder_chat_assignee` FOREIGN KEY (`assignedAdminId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_chat_conversations` ADD CONSTRAINT `fk_preorder_chat_preorder` FOREIGN KEY (`preorderRequestId`) REFERENCES `preorder_requests`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_chat_participants` ADD CONSTRAINT `fk_preorder_chat_participant_conversation` FOREIGN KEY (`conversationId`) REFERENCES `preorder_chat_conversations`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_chat_participants` ADD CONSTRAINT `fk_preorder_chat_participant_user` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_chat_messages` ADD CONSTRAINT `fk_preorder_chat_message_conversation` FOREIGN KEY (`conversationId`) REFERENCES `preorder_chat_conversations`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_chat_notes` ADD CONSTRAINT `fk_preorder_chat_note_conversation` FOREIGN KEY (`conversationId`) REFERENCES `preorder_chat_conversations`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_chat_proposals` ADD CONSTRAINT `fk_preorder_chat_proposal_conversation` FOREIGN KEY (`conversationId`) REFERENCES `preorder_chat_conversations`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_chat_attachments` ADD CONSTRAINT `fk_preorder_chat_attachment_conversation` FOREIGN KEY (`conversationId`) REFERENCES `preorder_chat_conversations`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_chat_attachments` ADD CONSTRAINT `fk_preorder_chat_attachment_message` FOREIGN KEY (`messageId`) REFERENCES `preorder_chat_messages`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_chat_customer_blocks` ADD CONSTRAINT `fk_preorder_chat_block_customer` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

