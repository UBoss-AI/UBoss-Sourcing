-- LIVE-004 and JOURNEY-019: an approved RFQ purchase order becomes a
-- fulfilable marketplace order, and its final inspection is measured against
-- the RFQ's approved reference sample.
--
-- Additive. The new order source is appended at the end: MariaDB stores an
-- enum by position, so every existing order keeps its source.

ALTER TABLE `orders` MODIFY `source` ENUM('ONE_TIME', 'RECURRING', 'PREORDER', 'RFQ_SAMPLE', 'RFQ_PURCHASE_ORDER') NOT NULL DEFAULT 'ONE_TIME';

-- One purchase order makes one live order: the unique index is what keeps two
-- concurrent conversions from both creating one.
ALTER TABLE `rfq_purchase_orders` ADD COLUMN `orderId` CHAR(26) NULL,
    ADD COLUMN `convertedAt` DATETIME(3) NULL,
    ADD COLUMN `convertedByUserId` CHAR(26) NULL;

CREATE UNIQUE INDEX `uq_rfq_po_order` ON `rfq_purchase_orders`(`orderId`);

ALTER TABLE `rfq_purchase_orders` ADD CONSTRAINT `fk_rfq_po_order` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- The reference sample a final inspection is measured against.
ALTER TABLE `inspection_requirements` ADD COLUMN `referenceSampleId` CHAR(26) NULL;

CREATE INDEX `ix_insp_requirement_reference_sample` ON `inspection_requirements`(`referenceSampleId`);

ALTER TABLE `inspection_requirements` ADD CONSTRAINT `fk_insp_requirement_reference_sample` FOREIGN KEY (`referenceSampleId`) REFERENCES `rfq_samples`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;
