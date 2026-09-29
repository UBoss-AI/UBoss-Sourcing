-- Payment receipts.
--
-- A buyer can download a receipt for every captured payment and every refund
-- the provider confirmed. The receipt NUMBER is issued the first time somebody
-- downloads it, from number_sequences inside the same transaction as this
-- insert, so the sequence stays gapless: a second request for the same payment
-- collides on uq_payment_receipt_source and rolls its increment back.
--
-- Additive only: one new table. It holds no person's id - the payer's name is
-- read from the order when the receipt is rendered, never stored here - so the
-- GDPR export test has nothing new to account for; the receipt is disclosed as
-- part of the buyer's orders and payments.

CREATE TABLE `payment_receipts` (
    `id` CHAR(26) NOT NULL,
    `receiptNumber` VARCHAR(32) NOT NULL,
    `kind` ENUM('PAYMENT', 'REFUND') NOT NULL,
    `sourceKey` VARCHAR(64) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `paymentTransactionId` CHAR(26) NOT NULL,
    `refundId` CHAR(26) NULL,
    `amountMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `snapshotJson` JSON NOT NULL,
    `issuedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_payment_receipt_number`(`receiptNumber`),
    UNIQUE INDEX `uq_payment_receipt_source`(`sourceKey`),
    INDEX `ix_payment_receipt_order`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `payment_receipts` ADD CONSTRAINT `fk_payment_receipt_order` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
