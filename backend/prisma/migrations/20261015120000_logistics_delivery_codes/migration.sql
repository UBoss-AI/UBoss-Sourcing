-- Delivery codes for a Proof of Delivery policy that requires one.
--
-- Until now a policy with `podRequiresOtp` could never be satisfied: nothing
-- ever sent the buyer a code. From this migration a code is sent to the buyer
-- by email when the consignment goes out for delivery, and can be sent again
-- from the carrier portal within limits. See `LogisticsDeliveryCode` in
-- schema.prisma and `modules/logistics/delivery-code.service.ts`.
--
-- One new table and nothing else, so it is safe on a live installation. The
-- code is never stored: `codeHash` is an HMAC of it keyed with a server
-- secret. No person's id is on the row.

-- CreateTable
CREATE TABLE `logistics_delivery_codes` (
    `id` CHAR(26) NOT NULL,
    `shipmentId` CHAR(26) NOT NULL,
    `codeHash` CHAR(64) NOT NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `origin` VARCHAR(24) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `supersededAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_logistics_delivery_code_shipment`(`shipmentId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `logistics_delivery_codes` ADD CONSTRAINT `fk_logistics_delivery_code_shipment` FOREIGN KEY (`shipmentId`) REFERENCES `logistics_shipments`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
