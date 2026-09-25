-- Customer acknowledgements: the bulk preorder information note.
--
-- One row per person, type and version. A new PREORDER_INFO_VERSION matches
-- no existing row, so every buyer is asked to read the note again, and the
-- older rows remain as the record of what each buyer read and when.

-- CreateTable
CREATE TABLE `customer_acknowledgements` (
    `id` CHAR(26) NOT NULL,
    `userId` CHAR(26) NOT NULL,
    `type` ENUM('PREORDER_INFO') NOT NULL,
    `policyVersion` VARCHAR(32) NOT NULL,
    `acknowledgedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_customer_ack`(`userId`, `type`, `policyVersion`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `customer_acknowledgements` ADD CONSTRAINT `fk_customer_ack_user` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
