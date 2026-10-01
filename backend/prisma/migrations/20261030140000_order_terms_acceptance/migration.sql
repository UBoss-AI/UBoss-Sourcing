-- The Terms version a buyer agreed to at checkout (JOURNEY-022). Additive; older
-- orders keep NULL.
ALTER TABLE `orders`
    ADD COLUMN `termsDocumentId` CHAR(26) NULL,
    ADD COLUMN `termsAcceptedAt` DATETIME(3) NULL;

CREATE INDEX `fk_order_terms_document` ON `orders`(`termsDocumentId`);

ALTER TABLE `orders`
    ADD CONSTRAINT `fk_order_terms_document` FOREIGN KEY (`termsDocumentId`) REFERENCES `legal_documents`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
