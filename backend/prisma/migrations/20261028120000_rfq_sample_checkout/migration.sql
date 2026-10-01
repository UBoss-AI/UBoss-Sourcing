-- Master row 20: paying for an RFQ sample through the ordinary checkout.
--
-- A charged sample is paid through an order (source RFQ_SAMPLE) with no
-- lines; the sample is marked PAID only when that order is confirmed by a
-- verified payment webhook. The supplier may add a shipping charge.

ALTER TABLE `orders` MODIFY `source` ENUM('ONE_TIME', 'RECURRING', 'PREORDER', 'RFQ_SAMPLE') NOT NULL DEFAULT 'ONE_TIME';

ALTER TABLE `rfq_samples` ADD COLUMN `shippingMinor` BIGINT NULL,
    ADD COLUMN `orderId` CHAR(26) NULL;

CREATE UNIQUE INDEX `uq_rfq_sample_order` ON `rfq_samples`(`orderId`);

ALTER TABLE `rfq_samples` ADD CONSTRAINT `fk_rfq_sample_order` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- A shipping charge is never negative.
ALTER TABLE `rfq_samples` ADD CONSTRAINT `chk_rfq_sample_shipping` CHECK (`shippingMinor` IS NULL OR `shippingMinor` >= 0);
