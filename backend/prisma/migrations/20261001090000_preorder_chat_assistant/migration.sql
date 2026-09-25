-- The preorder assistant: automated answers to common questions, and the
-- customer asking for a person. See `modules/preorder-chat/assistant/`.

ALTER TABLE `preorder_chat_messages`
    MODIFY `senderType` ENUM('CUSTOMER', 'ADMIN', 'SYSTEM', 'AUTOMATION') NOT NULL,
    MODIFY `messageType` ENUM('TEXT', 'ATTACHMENT', 'SYSTEM_EVENT', 'STRUCTURED_OFFER', 'FAQ_QUESTION', 'AUTOMATED_REPLY', 'HANDOFF_REQUEST') NOT NULL DEFAULT 'TEXT';

ALTER TABLE `preorder_chat_conversations`
    MODIFY `lastMessageSender` ENUM('CUSTOMER', 'ADMIN', 'SYSTEM', 'AUTOMATION') NULL,
    ADD COLUMN `handoffRequestedAt` DATETIME(3) NULL AFTER `closedAt`,
    ADD COLUMN `handoffTopic` VARCHAR(64) NULL AFTER `handoffRequestedAt`;

ALTER TABLE `preorder_chat_attachments`
    MODIFY `uploaderType` ENUM('CUSTOMER', 'ADMIN', 'SYSTEM', 'AUTOMATION') NOT NULL;
