-- Incoterms a seller quotes a listing on (JOURNEY-002/004/029). Additive.
ALTER TABLE `seller_listing_trust` ADD COLUMN `incotermsJson` JSON NULL;
