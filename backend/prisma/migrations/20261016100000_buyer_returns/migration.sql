-- Buyer-initiated returns.
--
-- Until now a return could only be recorded by staff, with a free-text reason
-- and nothing else. From this migration a buyer asks for one from their order
-- page: a reason code from the operator's list, a quantity per line, photos or
-- video of the problem, and whether they want a refund or a replacement. The
-- seller of those goods answers it, staff decide it, and the refund goes out
-- through the ordinary refund path. See ReturnRequest in schema.prisma and
-- modules/returns/return.service.ts.
--
-- Additive only: new nullable or defaulted columns on return_requests, and four
-- new tables. Existing return rows keep working; their lines stay in itemsJson.
-- No person's id sits in a column the GDPR export test watches; the return is
-- disclosed inside the buyer's orders.

-- AlterTable
ALTER TABLE `return_requests` ADD COLUMN `approvedAt` DATETIME(3) NULL,
    ADD COLUMN `inspectedAt` DATETIME(3) NULL,
    ADD COLUMN `instructionsSetAt` DATETIME(3) NULL,
    ADD COLUMN `origin` ENUM('BUYER', 'STAFF') NOT NULL DEFAULT 'STAFF',
    ADD COLUMN `preferredResolution` ENUM('REFUND', 'REPLACEMENT') NOT NULL DEFAULT 'REFUND',
    ADD COLUMN `reasonCode` VARCHAR(48) NULL,
    ADD COLUMN `receivedAt` DATETIME(3) NULL,
    ADD COLUMN `rejectedAt` DATETIME(3) NULL,
    ADD COLUMN `resolutionNote` VARCHAR(512) NULL,
    ADD COLUMN `returnInstructions` TEXT NULL,
    ADD COLUMN `sellerOrderGroupId` CHAR(26) NULL,
    ADD COLUMN `sellerRespondedAt` DATETIME(3) NULL,
    ADD COLUMN `sellerRespondedById` CHAR(26) NULL,
    ADD COLUMN `sellerResponse` ENUM('ACCEPT', 'CONTEST') NULL,
    ADD COLUMN `sellerResponseNote` TEXT NULL;

-- CreateTable
CREATE TABLE `return_request_lines` (
    `id` CHAR(26) NOT NULL,
    `returnRequestId` CHAR(26) NOT NULL,
    `orderItemId` CHAR(26) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `sellableQty` INTEGER NULL,
    `damagedQty` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    CONSTRAINT `chk_return_line_quantities` CHECK (`quantity` > 0 AND (`sellableQty` IS NULL OR `sellableQty` >= 0) AND (`damagedQty` IS NULL OR `damagedQty` >= 0) AND COALESCE(`sellableQty`, 0) + COALESCE(`damagedQty`, 0) <= `quantity`),

    INDEX `ix_return_line_order_item`(`orderItemId`),
    UNIQUE INDEX `uq_return_line_item`(`returnRequestId`, `orderItemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `return_request_events` (
    `id` CHAR(26) NOT NULL,
    `returnRequestId` CHAR(26) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `toStatus` ENUM('REQUESTED', 'APPROVED', 'REJECTED', 'RECEIVED', 'INSPECTED', 'COMPLETED') NULL,
    `note` TEXT NULL,
    `visibleToBuyer` BOOLEAN NOT NULL DEFAULT true,
    `actorType` VARCHAR(16) NOT NULL,
    `actorId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_return_event_request`(`returnRequestId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `return_request_files` (
    `id` CHAR(26) NOT NULL,
    `returnRequestId` CHAR(26) NOT NULL,
    `kind` ENUM('EVIDENCE', 'LABEL') NOT NULL,
    `storageKey` VARCHAR(512) NOT NULL,
    `fileName` VARCHAR(255) NOT NULL,
    `contentType` VARCHAR(128) NOT NULL,
    `mediaKind` ENUM('IMAGE', 'VIDEO', 'DOCUMENT') NOT NULL,
    `byteSize` INTEGER NOT NULL,
    `contentHash` CHAR(64) NOT NULL,
    `scanState` ENUM('CLEAN', 'SCANNER_UNCONFIGURED') NOT NULL,
    `uploadedById` CHAR(26) NULL,
    `uploaderType` VARCHAR(16) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_return_file_request`(`returnRequestId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `return_settings` (
    `id` CHAR(26) NOT NULL,
    `windowDays` SMALLINT NOT NULL DEFAULT 14,
    `reasonCodesJson` JSON NOT NULL,
    `evidenceRequiredJson` JSON NOT NULL,
    `replacementEnabled` BOOLEAN NOT NULL DEFAULT false,
    `operatorInstructions` TEXT NULL,
    `updatedById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ix_return_seller_group` ON `return_requests`(`sellerOrderGroupId`, `status`);

-- AddForeignKey
ALTER TABLE `return_requests` ADD CONSTRAINT `fk_return_seller_group` FOREIGN KEY (`sellerOrderGroupId`) REFERENCES `seller_order_groups`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `return_request_lines` ADD CONSTRAINT `fk_return_line_request` FOREIGN KEY (`returnRequestId`) REFERENCES `return_requests`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `return_request_lines` ADD CONSTRAINT `fk_return_line_order_item` FOREIGN KEY (`orderItemId`) REFERENCES `order_items`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `return_request_events` ADD CONSTRAINT `fk_return_event_request` FOREIGN KEY (`returnRequestId`) REFERENCES `return_requests`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `return_request_files` ADD CONSTRAINT `fk_return_file_request` FOREIGN KEY (`returnRequestId`) REFERENCES `return_requests`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
