-- An immutable snapshot of what was ordered: description, specifications,
-- packaging and the selections, written once when the order item is created.
-- See `domain/order-item-snapshot.ts`. NULL on items created before this.

ALTER TABLE `order_items`
    ADD COLUMN `productInfoSnapshotJson` JSON NULL,
    ADD COLUMN `productInfoCapturedAt` DATETIME(3) NULL;
