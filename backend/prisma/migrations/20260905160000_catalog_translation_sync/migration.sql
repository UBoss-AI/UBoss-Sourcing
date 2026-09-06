-- Machine-translating the catalogue. One settings row, holding the encrypted
-- provider key and the outcome of the last run.
CREATE TABLE `catalog_translation_sync` (
    `id` CHAR(26) NOT NULL,
    `apiKeyEncrypted` TEXT NULL,
    `apiKeyHint` VARCHAR(8) NULL,
    `lastRunAt` DATETIME(3) NULL,
    `lastRunStatus` VARCHAR(16) NULL,
    `lastRunMessage` VARCHAR(512) NULL,
    `lastRunTranslated` INTEGER NOT NULL DEFAULT 0,
    `isRunning` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` CHAR(26) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
