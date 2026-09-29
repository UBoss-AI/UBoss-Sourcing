-- Master row 17: questions and answers on a request for quotation.
--
-- One thread per invited seller (`sellerAccountId`). The UNIQUE index on the
-- sender's own message id makes a resend find the first message instead of
-- writing a second one.

-- CreateTable
CREATE TABLE `rfq_messages` (
    `id` CHAR(26) NOT NULL,
    `rfqId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `authorParty` ENUM('BUYER', 'SUPPLIER', 'SYSTEM') NOT NULL,
    `authorUserId` CHAR(26) NOT NULL,
    `body` TEXT NOT NULL,
    `clientMessageId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_rfq_message_thread`(`rfqId`, `sellerAccountId`, `id`),
    UNIQUE INDEX `uq_rfq_message_client`(`rfqId`, `sellerAccountId`, `clientMessageId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `rfq_messages` ADD CONSTRAINT `fk_rfq_message_rfq` FOREIGN KEY (`rfqId`) REFERENCES `rfq_requests`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
