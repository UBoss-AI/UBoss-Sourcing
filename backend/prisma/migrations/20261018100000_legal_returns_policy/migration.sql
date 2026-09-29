-- Master row 9: the returns policy joins the operator's published policies.
-- The other policy kinds were added in 20261016700000; this is the one the
-- checklist names that was missing. Additive: no row changes.
ALTER TABLE `legal_documents` MODIFY `kind` ENUM('PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'PRIVACY_POLICY', 'INSPECTION_POLICY', 'BUYER_PROTECTION_POLICY', 'PROHIBITED_PRODUCTS', 'RETURNS_POLICY') NOT NULL;
