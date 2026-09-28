-- Company-buyer onboarding: the representative's relationship to the
-- business, a business-licence document, and a link to the seller account for
-- the same legal entity. See `domain/buyer-company-requirements.ts`.
--
-- Every column is nullable and every existing row keeps NULL. Nothing about
-- an application already in flight changes: a draft simply shows one more
-- question on its first step, and a submitted or approved company is not
-- re-opened or re-judged because a new question now exists.

-- How the applicant stands to the business. A code, not free text - the
-- service accepts only `APPLICANT_RELATIONSHIPS`, and the storefront shows it
-- in the reader's language.
ALTER TABLE `buyer_companies`
    ADD COLUMN `applicantRelationship` VARCHAR(32) NULL AFTER `applicantJobTitle`;

-- The seller account for the same legal entity, when the application was
-- started from it. A pointer for the reviewer and nothing more: the buyer
-- company keeps its own status, and no approval travels along it in either
-- direction. SET NULL rather than CASCADE, so removing a seller account never
-- removes a buyer company that has orders.
ALTER TABLE `buyer_companies`
    ADD COLUMN `linkedSellerAccountId` CHAR(26) NULL AFTER `applicantAuthorityConfirmedAt`;

CREATE INDEX `ix_buyer_company_linked_seller` ON `buyer_companies`(`linkedSellerAccountId`);

ALTER TABLE `buyer_companies`
    ADD CONSTRAINT `fk_buyer_company_linked_seller`
    FOREIGN KEY (`linkedSellerAccountId`) REFERENCES `seller_accounts`(`id`)
    ON DELETE SET NULL ON UPDATE RESTRICT;

-- A trade or operating licence. Appended to the enum, so every stored value
-- keeps its meaning.
ALTER TABLE `buyer_company_documents`
    MODIFY `kind` ENUM('CERTIFICATE_OF_INCORPORATION', 'REGISTRY_EXTRACT', 'TAX_REGISTRATION_CERTIFICATE', 'PROOF_OF_REGISTERED_ADDRESS', 'AUTHORIZATION_LETTER', 'BUSINESS_LICENCE', 'REPRESENTATIVE_IDENTITY', 'OWNERSHIP_DECLARATION', 'OTHER') NOT NULL;
