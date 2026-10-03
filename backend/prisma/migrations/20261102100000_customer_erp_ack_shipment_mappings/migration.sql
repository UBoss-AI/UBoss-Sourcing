-- ENH-015: order acknowledgement and shipment mappings for the buyer's ERP.
ALTER TABLE `customer_erp_field_mappings` MODIFY `entity` ENUM('PRODUCT', 'WAREHOUSE', 'ORDER', 'INVENTORY', 'INVOICE', 'PAYMENT', 'STATUS', 'ACKNOWLEDGEMENT', 'SHIPMENT') NOT NULL;

ALTER TABLE `customer_erp_order_links`
    ADD COLUMN `erpAcknowledgementId` VARCHAR(191) NULL,
    ADD COLUMN `erpAcknowledgementStatus` VARCHAR(64) NULL,
    ADD COLUMN `acknowledgedAt` DATETIME(3) NULL,
    ADD COLUMN `erpPromisedDeliveryAt` DATETIME(3) NULL,
    ADD COLUMN `erpShipmentId` VARCHAR(191) NULL,
    ADD COLUMN `erpCarrier` VARCHAR(64) NULL,
    ADD COLUMN `erpShippedAt` DATETIME(3) NULL;
