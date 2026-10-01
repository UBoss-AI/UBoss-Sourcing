-- Export documents a supplier promises on a quote version (JOURNEY-016). Additive.
ALTER TABLE `rfq_quote_versions` ADD COLUMN `exportDocumentsJson` JSON NULL;
