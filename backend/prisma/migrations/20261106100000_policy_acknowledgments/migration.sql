-- Terms acceptance and privacy-notice acknowledgment after sign-in, for every
-- kind of account. See `LegalDocument`, `ConsentRecord` and
-- `modules/legal/agreement.service.ts`.
--
-- Additive. No acceptance is invented: existing rows are only labelled with
-- facts they already carry (a Terms row that names a document was a Terms
-- acceptance; where it was given says which kind of account gave it).

-- A sixth kind of terms: the Audit Console's, for inspectors and auditors.
ALTER TABLE `legal_documents` MODIFY `kind` ENUM('PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'PRIVACY_POLICY', 'INSPECTION_POLICY', 'BUYER_PROTECTION_POLICY', 'PROHIBITED_PRODUCTS', 'RETURNS_POLICY', 'STAFF_TERMS', 'AUDIT_CONSOLE_TERMS') NOT NULL;

-- Whether people who accepted an earlier version must accept this one again.
-- TRUE for every existing row: each was the first version of its kind, or the
-- operator published it expecting it to be accepted.
ALTER TABLE `legal_documents` ADD COLUMN `requiresReacceptance` BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE `consent_records`
    MODIFY `purpose` ENUM('ACCURACY_DECLARATION', 'BUSINESS_TERMS', 'PRIVACY_NOTICE', 'AUTHORITY_TO_ACT', 'PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'STAFF_TERMS', 'AUDIT_CONSOLE_TERMS') NOT NULL,
    ADD COLUMN `action` ENUM('TERMS_ACCEPTED', 'PRIVACY_NOTICE_ACKNOWLEDGED') NULL,
    ADD COLUMN `scope` ENUM('BUYER', 'SELLER', 'LOGISTICS', 'STAFF', 'AUDIT') NULL,
    ADD COLUMN `activeDocumentId` CHAR(26) NULL,
    ADD COLUMN `clearedAt` DATETIME(3) NULL;

UPDATE `consent_records`
    SET `action` = 'TERMS_ACCEPTED'
    WHERE `legalDocumentId` IS NOT NULL AND `purpose` IN ('PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS');

UPDATE `consent_records`
    SET `scope` = CASE `acceptanceSource`
        WHEN 'STOREFRONT_SIGN_UP' THEN 'BUYER'
        WHEN 'CUSTOMER_INVITATION' THEN 'BUYER'
        WHEN 'LOGISTICS_INVITATION' THEN 'LOGISTICS'
        ELSE NULL
    END
    WHERE `legalDocumentId` IS NOT NULL;

UPDATE `consent_records`
    SET `activeDocumentId` = `legalDocumentId`
    WHERE `legalDocumentId` IS NOT NULL AND `withdrawnAt` IS NULL;

-- One ACTIVE record per person per document. A record cleared on the
-- agreement screen keeps its row (with `clearedAt` and no active id) and a
-- later acceptance is a new row. NULL is distinct in a MariaDB UNIQUE index,
-- so cleared rows and the company declarations never collide.
CREATE UNIQUE INDEX `uq_consent_record_user_active_document` ON `consent_records`(`userId`, `activeDocumentId`);
CREATE INDEX `ix_consent_record_user_document` ON `consent_records`(`userId`, `legalDocumentId`);
DROP INDEX `uq_consent_record_user_document` ON `consent_records`;

ALTER TABLE `consent_records` DROP CONSTRAINT `chk_consent_record_terms_names_document`;
ALTER TABLE `consent_records` ADD CONSTRAINT `chk_consent_record_terms_names_document` CHECK (
    `purpose` NOT IN ('PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'STAFF_TERMS', 'AUDIT_CONSOLE_TERMS') OR `legalDocumentId` IS NOT NULL
);

-- The active id is the document id or nothing, and only while the record is
-- neither withdrawn nor cleared. Clearing is not withdrawing: a person who
-- unticks a box before pressing Continue has withdrawn no consent.
ALTER TABLE `consent_records` ADD CONSTRAINT `chk_consent_record_active_document` CHECK (
    `activeDocumentId` IS NULL OR (`activeDocumentId` = `legalDocumentId` AND `withdrawnAt` IS NULL AND `clearedAt` IS NULL)
);

-- The action matches the purpose: a privacy notice is acknowledged, never
-- "accepted", and terms are accepted, never "acknowledged".
ALTER TABLE `consent_records` ADD CONSTRAINT `chk_consent_record_action_matches_purpose` CHECK (
    `action` IS NULL
    OR (`action` = 'PRIVACY_NOTICE_ACKNOWLEDGED' AND `purpose` = 'PRIVACY_NOTICE')
    OR (`action` = 'TERMS_ACCEPTED' AND `purpose` IN ('PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS', 'SELLER_TERMS', 'STAFF_TERMS', 'AUDIT_CONSOLE_TERMS'))
);
