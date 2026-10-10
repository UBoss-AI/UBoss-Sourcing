-- The Individual / B2C buyer agreement screen: two new kinds of document and
-- the CONSUMER scope.
--
-- Additive. No acceptance is invented and none is back-filled: an individual
-- who accepted the Terms of Use keeps that record, and is asked for the B2C
-- documents only once all three are published and in force.

ALTER TABLE `legal_documents` MODIFY `kind` ENUM('PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'PRIVACY_POLICY', 'INSPECTION_POLICY', 'BUYER_PROTECTION_POLICY', 'PROHIBITED_PRODUCTS', 'RETURNS_POLICY', 'STAFF_TERMS', 'AUDIT_CONSOLE_TERMS', 'SELLER_SERVICES_AGREEMENT', 'B2B_BUYER_TERMS', 'B2B_BUYER_SERVICES_AGREEMENT', 'B2C_CONSUMER_TERMS', 'B2C_PLATFORM_SERVICES_AGREEMENT') NOT NULL;

ALTER TABLE `consent_records`
    MODIFY `purpose` ENUM('ACCURACY_DECLARATION', 'BUSINESS_TERMS', 'PRIVACY_NOTICE', 'AUTHORITY_TO_ACT', 'PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'SELLER_SERVICES_AGREEMENT', 'STAFF_TERMS', 'AUDIT_CONSOLE_TERMS', 'B2B_BUYER_TERMS', 'B2B_BUYER_SERVICES_AGREEMENT', 'B2C_CONSUMER_TERMS', 'B2C_PLATFORM_SERVICES_AGREEMENT') NOT NULL,
    MODIFY `scope` ENUM('BUYER', 'SELLER', 'LOGISTICS', 'STAFF', 'AUDIT', 'COMPANY_BUYER', 'CONSUMER') NULL;

-- The two CHECKs that name every terms purpose, redefined with the new ones
-- (copied from 20261112100000_b2b_buyer_agreements).
ALTER TABLE `consent_records` DROP CONSTRAINT `chk_consent_record_terms_names_document`;
ALTER TABLE `consent_records` ADD CONSTRAINT `chk_consent_record_terms_names_document` CHECK (
    `purpose` NOT IN ('PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'SELLER_SERVICES_AGREEMENT', 'STAFF_TERMS', 'AUDIT_CONSOLE_TERMS', 'B2B_BUYER_TERMS', 'B2B_BUYER_SERVICES_AGREEMENT', 'B2C_CONSUMER_TERMS', 'B2C_PLATFORM_SERVICES_AGREEMENT') OR `legalDocumentId` IS NOT NULL
);

ALTER TABLE `consent_records` DROP CONSTRAINT `chk_consent_record_action_matches_purpose`;
ALTER TABLE `consent_records` ADD CONSTRAINT `chk_consent_record_action_matches_purpose` CHECK (
    `action` IS NULL
    OR (`action` = 'PRIVACY_NOTICE_ACKNOWLEDGED' AND `purpose` = 'PRIVACY_NOTICE')
    OR (`action` = 'TERMS_ACCEPTED' AND `purpose` IN ('PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'SELLER_SERVICES_AGREEMENT', 'STAFF_TERMS', 'AUDIT_CONSOLE_TERMS', 'B2B_BUYER_TERMS', 'B2B_BUYER_SERVICES_AGREEMENT', 'B2C_CONSUMER_TERMS', 'B2C_PLATFORM_SERVICES_AGREEMENT'))
);
