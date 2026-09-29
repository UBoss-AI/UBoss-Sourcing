-- The seller application review (checklist Master row 12).
--
--   * seller_business_profiles.legalForm: what the business is in law. It
--     decides which registration number is asked for - in India a company has
--     a CIN and an LLP an LLPIN, a proprietorship neither.
--   * seller_beneficial_owners.isPoliticallyExposed: the seller's own
--     declaration. Not a screening result; screening is seller_screening_checks,
--     recorded by the operator.
--   * seller_trust_profiles.intendedCategoryIdsJson: the categories the seller
--     says it will sell in, checked against categories when saved.
--
-- Data: India's company registration number is asked for by its own name.
-- Inserted only where this deployment already uses the India rows (its GSTIN
-- row exists) and has not written its own row for the field - a deployment
-- that never sells in India, or that has already defined this row, is left as
-- it is. Optional on purpose: a proprietorship or an ordinary partnership has
-- no CIN, and the application requires one only when the legal form does.
--
-- seller_beneficial_owners holds no userId/customerProfileId; nothing here
-- changes the GDPR export's scope.

-- AlterTable
ALTER TABLE `seller_business_profiles` ADD COLUMN `legalForm` ENUM('SOLE_PROPRIETORSHIP', 'PARTNERSHIP', 'LIMITED_LIABILITY_PARTNERSHIP', 'PRIVATE_LIMITED_COMPANY', 'PUBLIC_LIMITED_COMPANY', 'OTHER') NULL;

-- AlterTable
ALTER TABLE `seller_beneficial_owners` ADD COLUMN `isPoliticallyExposed` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `seller_trust_profiles` ADD COLUMN `intendedCategoryIdsJson` JSON NULL;

-- Data
INSERT INTO `seller_onboarding_requirements`
  (`id`, `countryCode`, `countryKey`, `stepKey`, `fieldKey`, `label`, `helpText`, `isRequired`, `isDocument`, `validationPattern`, `appliesToKind`, `sortOrder`, `createdAt`, `updatedAt`)
SELECT
  '01K6R12C1NREQ0000000000000', 'IN', 'IN', 'business_identity', 'company_registration_number',
  'CIN (companies) or LLPIN (LLPs)',
  'Companies: the 21-character Corporate Identity Number. LLPs: the LLP Identification Number, for example AAA-1234. Proprietorships and ordinary partnerships leave this empty.',
  false, false,
  '^([LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}|[A-Z]{3}-?[0-9]{4})$',
  NULL, 10, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
FROM DUAL
WHERE EXISTS (
  SELECT 1 FROM `seller_onboarding_requirements`
  WHERE `countryKey` = 'IN' AND `fieldKey` = 'tax_registration_number'
)
AND NOT EXISTS (
  SELECT 1 FROM `seller_onboarding_requirements`
  WHERE `countryKey` = 'IN' AND `stepKey` = 'business_identity' AND `fieldKey` = 'company_registration_number'
);
