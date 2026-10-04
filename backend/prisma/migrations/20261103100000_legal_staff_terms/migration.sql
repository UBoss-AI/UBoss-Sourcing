-- Admin console sign-in: the staff terms the operator writes and every staff
-- member agrees to when they sign in to the console. Shown in the same
-- read-to-the-end dialog as the buyer and carrier terms. Additive: no row
-- changes, and no acceptance is recorded for this kind.
ALTER TABLE `legal_documents` MODIFY `kind` ENUM('PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'PRIVACY_POLICY', 'INSPECTION_POLICY', 'BUYER_PROTECTION_POLICY', 'PROHIBITED_PRODUCTS', 'RETURNS_POLICY', 'STAFF_TERMS') NOT NULL;
