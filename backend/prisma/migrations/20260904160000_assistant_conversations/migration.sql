-- The storefront chat widget now identifies the visitor before it answers, and
-- the conversation is kept as a sales lead rather than living only in the
-- browser tab that had it.
--
-- `sessionTokenHash` is a hash, not the token: the raw value is handed to the
-- browser that started the conversation and never written down, so this table
-- holds nothing that could be replayed to read or append to somebody else's
-- transcript.
--
-- `customerProfileId` is ON DELETE SET NULL rather than CASCADE. Removing a
-- customer account must not erase the record that an enquiry was made - the
-- enquiry happened, and the name, phone and email on the row are the visitor's
-- own words, independent of any account.

-- CreateTable
CREATE TABLE `assistant_conversations` (
    `id` CHAR(26) NOT NULL,
    `visitorName` VARCHAR(120) NOT NULL,
    `visitorPhone` VARCHAR(32) NOT NULL,
    `visitorEmail` VARCHAR(320) NOT NULL,
    `visitorEmailNormalized` VARCHAR(320) NOT NULL,
    `sessionTokenHash` CHAR(64) NOT NULL,
    `customerProfileId` CHAR(26) NULL,
    `messageCount` INTEGER NOT NULL DEFAULT 0,
    `lastMessageAt` DATETIME(3) NULL,
    `ipAddress` VARCHAR(45) NULL,
    `userAgent` VARCHAR(512) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_assistant_conversation_created`(`createdAt`),
    INDEX `ix_assistant_conversation_email`(`visitorEmailNormalized`, `createdAt`),
    INDEX `ix_assistant_conversation_customer`(`customerProfileId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `assistant_messages` (
    `id` CHAR(26) NOT NULL,
    `conversationId` CHAR(26) NOT NULL,
    `role` ENUM('VISITOR', 'ASSISTANT') NOT NULL,
    `content` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_assistant_message_conversation`(`conversationId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `assistant_conversations`
    ADD CONSTRAINT `assistant_conversations_customerProfileId_fkey`
    FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `assistant_messages`
    ADD CONSTRAINT `assistant_messages_conversationId_fkey`
    FOREIGN KEY (`conversationId`) REFERENCES `assistant_conversations`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
