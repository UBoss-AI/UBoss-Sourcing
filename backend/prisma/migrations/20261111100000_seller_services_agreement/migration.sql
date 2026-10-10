-- The Seller Platform Services Agreement: a seventh kind of agreement,
-- accepted on the Seller Hub's agreement screen under its own box, and the
-- seller each SELLER-scope acceptance was given for.
--
-- Additive. No acceptance is invented and none is back-filled: existing
-- seller records keep a NULL seller, because nothing recorded says for
-- certain which seller a person was acting for at the time.

ALTER TABLE `legal_documents` MODIFY `kind` ENUM('PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'PRIVACY_POLICY', 'INSPECTION_POLICY', 'BUYER_PROTECTION_POLICY', 'PROHIBITED_PRODUCTS', 'RETURNS_POLICY', 'STAFF_TERMS', 'AUDIT_CONSOLE_TERMS', 'SELLER_SERVICES_AGREEMENT') NOT NULL;

ALTER TABLE `consent_records`
    MODIFY `purpose` ENUM('ACCURACY_DECLARATION', 'BUSINESS_TERMS', 'PRIVACY_NOTICE', 'AUTHORITY_TO_ACT', 'PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'SELLER_SERVICES_AGREEMENT', 'STAFF_TERMS', 'AUDIT_CONSOLE_TERMS') NOT NULL,
    ADD COLUMN `sellerAccountId` CHAR(26) NULL;

CREATE INDEX `ix_consent_record_seller_document` ON `consent_records`(`sellerAccountId`, `legalDocumentId`);

ALTER TABLE `consent_records` ADD CONSTRAINT `fk_consent_record_seller_account` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- The two CHECKs that name every terms purpose, redefined with the new one.
ALTER TABLE `consent_records` DROP CONSTRAINT `chk_consent_record_terms_names_document`;
ALTER TABLE `consent_records` ADD CONSTRAINT `chk_consent_record_terms_names_document` CHECK (
    `purpose` NOT IN ('PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'SELLER_SERVICES_AGREEMENT', 'STAFF_TERMS', 'AUDIT_CONSOLE_TERMS') OR `legalDocumentId` IS NOT NULL
);

ALTER TABLE `consent_records` DROP CONSTRAINT `chk_consent_record_action_matches_purpose`;
ALTER TABLE `consent_records` ADD CONSTRAINT `chk_consent_record_action_matches_purpose` CHECK (
    `action` IS NULL
    OR (`action` = 'PRIVACY_NOTICE_ACKNOWLEDGED' AND `purpose` = 'PRIVACY_NOTICE')
    OR (`action` = 'TERMS_ACCEPTED' AND `purpose` IN ('PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'SELLER_SERVICES_AGREEMENT', 'STAFF_TERMS', 'AUDIT_CONSOLE_TERMS'))
);
