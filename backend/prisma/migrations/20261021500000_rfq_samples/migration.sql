-- Master row 20: sample requests on a request for quotation.
--
-- One row per sample asked of one seller; files about it are rfq_attachments
-- rows with purpose SAMPLE. The CHECK keeps a cost whole (amount and
-- currency, or neither). Neither column is touched by a referential action.

-- AlterTable
ALTER TABLE `rfq_attachments` ADD COLUMN `sampleId` CHAR(26) NULL,
    MODIFY `purpose` ENUM('REQUIREMENT', 'QUOTE', 'NEGOTIATION', 'SAMPLE') NOT NULL;

-- CreateTable
CREATE TABLE `rfq_samples` (
    `id` CHAR(26) NOT NULL,
    `reference` VARCHAR(32) NOT NULL,
    `rfqId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `quoteId` CHAR(26) NULL,
    `status` ENUM('REQUESTED', 'ACCEPTED', 'DECLINED', 'SHIPPED', 'DELIVERED', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'REQUESTED',
    `version` INTEGER NOT NULL DEFAULT 0,
    `quantity` DECIMAL(15, 3) NOT NULL,
    `unitOfMeasure` VARCHAR(16) NULL,
    `deliveryAddress` VARCHAR(500) NOT NULL,
    `requestedByDate` DATE NULL,
    `approvalCriteria` TEXT NOT NULL,
    `notes` TEXT NULL,
    `costMinor` BIGINT NULL,
    `currency` CHAR(3) NULL,
    `paymentStatus` ENUM('NOT_REQUIRED', 'PAYMENT_PENDING', 'PAID') NOT NULL DEFAULT 'NOT_REQUIRED',
    `supplierNote` VARCHAR(1000) NULL,
    `courier` VARCHAR(80) NULL,
    `trackingNumber` VARCHAR(80) NULL,
    `shippedAt` DATETIME(3) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionReason` VARCHAR(1000) NULL,
    `referenceCode` VARCHAR(40) NULL,
    `requestedByUserId` CHAR(26) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_rfq_sample_reference`(`reference`),
    UNIQUE INDEX `uq_rfq_sample_reference_code`(`referenceCode`),
    INDEX `ix_rfq_sample_rfq`(`rfqId`, `sellerAccountId`),
    INDEX `ix_rfq_sample_seller`(`sellerAccountId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `rfq_samples` ADD CONSTRAINT `fk_rfq_sample_rfq` FOREIGN KEY (`rfqId`) REFERENCES `rfq_requests`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- A sample cost is an amount AND a currency, or neither.
ALTER TABLE `rfq_samples` ADD CONSTRAINT `chk_rfq_sample_cost_pair` CHECK ((`costMinor` IS NULL) = (`currency` IS NULL));
