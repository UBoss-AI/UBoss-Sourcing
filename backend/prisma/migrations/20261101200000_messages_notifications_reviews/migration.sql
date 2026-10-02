-- JOURNEY-055, 056 and 059: order messages, message reports, RFQ message
-- attachments, notification read marks and preferences, and seller scores
-- and seller responses on product reviews.
--
-- order_messages: one thread per seller order group, buyer and that seller.
-- message_reports: "report this message", one per person per message, for
--   staff to decide. Never hides anything by itself.
-- rfq_messages.attachmentId: a message may point at one file already
--   uploaded to the request.
-- notification_outbox.readAt: the recipient's own read mark (a row is one
--   recipient).
-- notification_preferences: a row is one family muted on one channel.
-- product_reviews: the seller the review counts towards (from the order
--   line), and the seller's moderated public answer.
-- risk_rules: two review rules, placeholders until the risk owner approves.
-- seller_notifications.kind: gains ORDER_MESSAGE (listed with every value, in
--   order, as MariaDB's MODIFY requires).
--
-- Rollback: drop the three new tables, the new columns and their foreign keys
-- and indexes, delete the two risk_rules rows, and MODIFY
-- seller_notifications.kind back without ORDER_MESSAGE (after deleting any
-- rows of that kind).

-- AlterTable: a seller notification for a buyer's order message.
ALTER TABLE `seller_notifications` MODIFY `kind` ENUM('APPLICATION_STATUS', 'LISTING_DECISION', 'NEW_ORDER', 'DISPATCH_SLA_WARNING', 'LOW_STOCK', 'ERP_SYNC_FAILURE', 'DOCUMENT_EXPIRING', 'PAYOUT_RESULT', 'RETURN_OR_DISPUTE', 'SECURITY_EVENT', 'BRAND_REQUEST_DECISION', 'CARRIER_ARRANGEMENT_DECISION', 'CARRIER_ACCEPTED', 'CARRIER_REJECTED', 'CARRIER_OFFER_EXPIRED', 'FULFILMENT_METHOD_DECISION', 'CARRIER_CONNECTION_FAILED', 'PARTNER_INVITATION_RESULT', 'CONSIGNMENT_AWAITING_METHOD', 'BULK_ORDER_RECEIVED', 'FREIGHT_QUOTE_REQUESTED', 'FREIGHT_QUOTE_AVAILABLE', 'PACKAGING_VALIDATION_FAILED', 'ERP_BRIDGE_OFFLINE', 'ERP_MAPPING_INCOMPLETE', 'ERP_SYNC_RECOVERED', 'ERP_INITIAL_SYNC_COMPLETE', 'CONSIGNMENT_NEEDS_CARRIER', 'CARRIER_BOOKING_INCOMPLETE', 'LOGISTICS_POLICY_UPDATE', 'LOGISTICS_PRICE_REQUIRED', 'LOGISTICS_UBOSS_PRICE_PUBLISHED', 'LOGISTICS_LEG_ASSIGNMENT_REQUIRED', 'LOGISTICS_LEG_UPDATE', 'SETTLEMENT_CALCULATED', 'PREORDER_REQUEST_RECEIVED', 'PREORDER_BUYER_RESPONSE', 'PREORDER_CONFIRMED', 'PREORDER_CLOSED', 'PREORDER_DELIVERY_RISK', 'INVOICE_CREDIT_NOTE_REQUIRED', 'INSPECTION_UPDATE', 'RFQ_INVITATION', 'RFQ_UPDATE', 'ORDER_MESSAGE') NOT NULL;

-- CreateTable
CREATE TABLE `order_messages` (
    `id` CHAR(26) NOT NULL,
    `sellerOrderGroupId` CHAR(26) NOT NULL,
    `authorParty` ENUM('BUYER', 'SELLER') NOT NULL,
    `authorUserId` CHAR(26) NOT NULL,
    `body` TEXT NOT NULL,
    `clientMessageId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_order_message_client`(`sellerOrderGroupId`, `clientMessageId`),
    INDEX `ix_order_message_thread`(`sellerOrderGroupId`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `message_reports` (
    `id` CHAR(26) NOT NULL,
    `threadKind` ENUM('PREORDER_CHAT', 'RFQ', 'ORDER') NOT NULL,
    `messageId` CHAR(26) NOT NULL,
    `threadId` CHAR(26) NOT NULL,
    `reporterUserId` CHAR(26) NOT NULL,
    `reporterParty` VARCHAR(16) NOT NULL,
    `reason` ENUM('SPAM', 'ABUSE', 'FRAUD', 'PERSONAL_DATA', 'OFF_PLATFORM', 'OTHER') NOT NULL,
    `note` VARCHAR(1000) NULL,
    `status` ENUM('OPEN', 'ACTIONED', 'DISMISSED') NOT NULL DEFAULT 'OPEN',
    `reviewedByUserId` CHAR(26) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `reviewNote` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_message_report_once`(`threadKind`, `messageId`, `reporterUserId`),
    INDEX `ix_message_report_queue`(`status`, `createdAt`),
    INDEX `ix_message_report_reporter`(`reporterUserId`),
    INDEX `ix_message_report_reviewer`(`reviewedByUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notification_preferences` (
    `id` CHAR(26) NOT NULL,
    `userId` CHAR(26) NOT NULL,
    `family` VARCHAR(32) NOT NULL,
    `channel` ENUM('EMAIL', 'SMS', 'WHATSAPP', 'IN_APP') NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_notification_preference`(`userId`, `family`, `channel`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable
ALTER TABLE `rfq_messages` ADD COLUMN `attachmentId` CHAR(26) NULL;

-- CreateIndex
CREATE INDEX `ix_rfq_message_attachment` ON `rfq_messages`(`attachmentId`);

-- AlterTable
ALTER TABLE `notification_outbox` ADD COLUMN `readAt` DATETIME(3) NULL;

-- AlterTable
ALTER TABLE `product_reviews`
    ADD COLUMN `sellerAccountId` CHAR(26) NULL,
    ADD COLUMN `sellerResponse` VARCHAR(1000) NULL,
    ADD COLUMN `sellerResponseStatus` ENUM('PUBLISHED', 'HIDDEN') NULL,
    ADD COLUMN `sellerResponseAt` DATETIME(3) NULL,
    ADD COLUMN `sellerResponseByUserId` CHAR(26) NULL,
    ADD COLUMN `sellerResponseHiddenReason` VARCHAR(500) NULL;

-- CreateIndex
CREATE INDEX `ix_product_review_seller` ON `product_reviews`(`sellerAccountId`, `status`);

-- CreateIndex
CREATE INDEX `ix_product_review_responder` ON `product_reviews`(`sellerResponseByUserId`);

-- AddForeignKey
ALTER TABLE `order_messages` ADD CONSTRAINT `fk_order_message_group` FOREIGN KEY (`sellerOrderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `message_reports` ADD CONSTRAINT `fk_message_report_reporter` FOREIGN KEY (`reporterUserId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `message_reports` ADD CONSTRAINT `fk_message_report_reviewer` FOREIGN KEY (`reviewedByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `notification_preferences` ADD CONSTRAINT `fk_notification_preference_user` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `rfq_messages` ADD CONSTRAINT `fk_rfq_message_attachment` FOREIGN KEY (`attachmentId`) REFERENCES `rfq_attachments`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `product_reviews` ADD CONSTRAINT `fk_product_review_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `product_reviews` ADD CONSTRAINT `fk_product_review_responder` FOREIGN KEY (`sellerResponseByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- Backfill: the seller each existing review's qualifying order line came from.
UPDATE `product_reviews` pr
  JOIN `order_items` oi ON oi.`orderId` = pr.`orderId` AND oi.`productId` = pr.`productId`
  JOIN `seller_offers` so ON so.`id` = oi.`sellerOfferId`
   SET pr.`sellerAccountId` = so.`sellerAccountId`
 WHERE pr.`sellerAccountId` IS NULL;

-- Two review rules, placeholders until the risk owner approves them.
INSERT INTO `risk_rules` (`code`, `severity`, `threshold`, `windowMinutes`, `thresholdMinor`, `currency`) VALUES
    ('REVIEW_VELOCITY', 'MEDIUM', 5, 1440, NULL, NULL),
    ('REVIEW_SELF_DEALING', 'HIGH', 1, 1440, NULL, NULL);
