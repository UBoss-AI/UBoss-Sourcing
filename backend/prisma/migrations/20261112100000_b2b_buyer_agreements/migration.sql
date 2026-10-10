-- The Company / B2B Buyer agreement screen: two new kinds of document, the
-- COMPANY_BUYER scope, and a company key on active consent records.
--
-- Additive. No acceptance is invented and none is back-filled: every existing
-- record gets activeCompanyKey '' and keeps its place in the unique index.

ALTER TABLE `legal_documents` MODIFY `kind` ENUM('PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'PRIVACY_POLICY', 'INSPECTION_POLICY', 'BUYER_PROTECTION_POLICY', 'PROHIBITED_PRODUCTS', 'RETURNS_POLICY', 'STAFF_TERMS', 'AUDIT_CONSOLE_TERMS', 'SELLER_SERVICES_AGREEMENT', 'B2B_BUYER_TERMS', 'B2B_BUYER_SERVICES_AGREEMENT') NOT NULL;

ALTER TABLE `consent_records`
    MODIFY `purpose` ENUM('ACCURACY_DECLARATION', 'BUSINESS_TERMS', 'PRIVACY_NOTICE', 'AUTHORITY_TO_ACT', 'PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'SELLER_SERVICES_AGREEMENT', 'STAFF_TERMS', 'AUDIT_CONSOLE_TERMS', 'B2B_BUYER_TERMS', 'B2B_BUYER_SERVICES_AGREEMENT') NOT NULL,
    MODIFY `scope` ENUM('BUYER', 'SELLER', 'LOGISTICS', 'STAFF', 'AUDIT', 'COMPANY_BUYER') NULL,
    ADD COLUMN `activeCompanyKey` VARCHAR(26) NOT NULL DEFAULT '';

-- One active record per person, document AND company: a member of two
-- companies accepts once for each. '' rather than NULL for "no company",
-- because MariaDB treats every NULL in a UNIQUE index as distinct.
DROP INDEX `uq_consent_record_user_active_document` ON `consent_records`;
CREATE UNIQUE INDEX `uq_consent_record_user_active_document` ON `consent_records`(`userId`, `activeDocumentId`, `activeCompanyKey`);

-- The two CHECKs that name every terms purpose, redefined with the new ones.
ALTER TABLE `consent_records` DROP CONSTRAINT `chk_consent_record_terms_names_document`;
ALTER TABLE `consent_records` ADD CONSTRAINT `chk_consent_record_terms_names_document` CHECK (
    `purpose` NOT IN ('PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'SELLER_SERVICES_AGREEMENT', 'STAFF_TERMS', 'AUDIT_CONSOLE_TERMS', 'B2B_BUYER_TERMS', 'B2B_BUYER_SERVICES_AGREEMENT') OR `legalDocumentId` IS NOT NULL
);

ALTER TABLE `consent_records` DROP CONSTRAINT `chk_consent_record_action_matches_purpose`;
ALTER TABLE `consent_records` ADD CONSTRAINT `chk_consent_record_action_matches_purpose` CHECK (
    `action` IS NULL
    OR (`action` = 'PRIVACY_NOTICE_ACKNOWLEDGED' AND `purpose` = 'PRIVACY_NOTICE')
    OR (`action` = 'TERMS_ACCEPTED' AND `purpose` IN ('PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'SELLER_SERVICES_AGREEMENT', 'STAFF_TERMS', 'AUDIT_CONSOLE_TERMS', 'B2B_BUYER_TERMS', 'B2B_BUYER_SERVICES_AGREEMENT'))
);

