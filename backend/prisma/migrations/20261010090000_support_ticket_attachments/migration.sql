-- Files on a support ticket: photographs, screen recordings and PDFs the
-- sender attached. See `SupportTicketAttachment` in schema.prisma.
--
-- A new table and nothing else, so it is safe on a live installation. The
-- bytes live in private storage under a random key; this row is how the
-- console and the sender find them, and how an erasure finds them to delete.

-- CreateTable
CREATE TABLE `support_ticket_attachments` (
    `id`               CHAR(26)      NOT NULL,
    `ticketId`         CHAR(26)      NOT NULL,
    `storageKey`       VARCHAR(512)  NOT NULL,
    `fileName`         VARCHAR(255)  NOT NULL,
    `contentType`      VARCHAR(128)  NOT NULL,
    `kind`             ENUM('IMAGE', 'VIDEO', 'DOCUMENT') NOT NULL,
    `byteSize`         INTEGER       NOT NULL,
    `contentHash`      CHAR(64)      NOT NULL,
    `scanState`        ENUM('CLEAN', 'SCANNER_UNCONFIGURED') NOT NULL,
    `uploadedByUserId` CHAR(26)      NULL,
    `createdAt`        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_support_ticket_attachment_ticket`(`ticketId`, `createdAt`),
    INDEX `ix_support_ticket_attachment_uploader`(`uploadedByUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `support_ticket_attachments`
    ADD CONSTRAINT `fk_support_ticket_attachment_ticket` FOREIGN KEY (`ticketId`) REFERENCES `support_tickets`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `support_ticket_attachments`
    ADD CONSTRAINT `fk_support_ticket_attachment_uploader` FOREIGN KEY (`uploadedByUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
