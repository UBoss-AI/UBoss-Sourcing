-- Versioned legal documents, and Terms acceptance recorded against them.
-- See `LegalDocument` and `ConsentRecord` in schema.prisma.
--
-- One new table, and three nullable columns plus two enum members on
-- `consent_records`. Nothing is seeded: the wording of an agreement is the
-- operator's, and this software never supplies it. Until an operator publishes
-- Terms and Conditions in the admin console, account sign-up and invitation
-- activation refuse with TERMS_DOCUMENT_UNAVAILABLE - see README "Going live".

-- CreateTable
CREATE TABLE `legal_documents` (
    `id` CHAR(26) NOT NULL,
    `kind` ENUM('PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS') NOT NULL,
    `version` VARCHAR(32) NOT NULL,
    `locale` VARCHAR(10) NOT NULL,
    `status` ENUM('DRAFT', 'PUBLISHED') NOT NULL DEFAULT 'DRAFT',
    `title` VARCHAR(200) NOT NULL,
    `body` MEDIUMTEXT NOT NULL,
    `changeSummary` TEXT NULL,
    `effectiveAt` DATETIME(3) NOT NULL,
    `contentSha256` CHAR(64) NULL,
    `publishedAt` DATETIME(3) NULL,
    `publishedById` CHAR(26) NULL,
    `supersedesId` CHAR(26) NULL,
    `createdById` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_legal_document_version_locale`(`kind`, `version`, `locale`),
    INDEX `ix_legal_document_current`(`kind`, `status`, `effectiveAt`),
    PRIMARY KEY (`id`),

    -- A published document always carries the hash and the moment it was
    -- frozen. Without them it could not be proved unchanged later.
    CONSTRAINT `chk_legal_document_published_is_sealed` CHECK (
        `status` <> 'PUBLISHED' OR (`contentSha256` IS NOT NULL AND `publishedAt` IS NOT NULL)
    )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `legal_documents` ADD CONSTRAINT `fk_legal_document_supersedes` FOREIGN KEY (`supersedesId`) REFERENCES `legal_documents`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AlterTable
ALTER TABLE `consent_records`
    MODIFY `purpose` ENUM('ACCURACY_DECLARATION', 'BUSINESS_TERMS', 'PRIVACY_NOTICE', 'AUTHORITY_TO_ACT', 'PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS') NOT NULL,
    ADD COLUMN `legalDocumentId` CHAR(26) NULL,
    ADD COLUMN `locale` VARCHAR(10) NULL,
    ADD COLUMN `acceptanceSource` VARCHAR(48) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `uq_consent_record_user_document` ON `consent_records`(`userId`, `legalDocumentId`);

-- CreateIndex
CREATE INDEX `ix_consent_record_legal_document` ON `consent_records`(`legalDocumentId`);

-- AddForeignKey
ALTER TABLE `consent_records` ADD CONSTRAINT `fk_consent_record_legal_document` FOREIGN KEY (`legalDocumentId`) REFERENCES `legal_documents`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A Terms acceptance always names the document that was accepted.
ALTER TABLE `consent_records` ADD CONSTRAINT `chk_consent_record_terms_names_document` CHECK (
    `purpose` NOT IN ('PLATFORM_TERMS', 'LOGISTICS_PARTNER_TERMS') OR `legalDocumentId` IS NOT NULL
);
