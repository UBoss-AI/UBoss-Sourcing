-- Data subject requests (GDPR Art. 15, 17 and 20).
--
-- No foreign key to `users`. The subject id is a plain column on purpose: an
-- erasure rewrites the user row, and this record has to survive as the proof
-- that the erasure was carried out. A cascade here would delete the evidence
-- along with the account.

-- AlterTable
ALTER TABLE `users` ADD COLUMN `erasedAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `data_requests` (
    `id` CHAR(26) NOT NULL,
    `subjectUserId` CHAR(26) NOT NULL,
    `subjectEmail` VARCHAR(320) NOT NULL,
    `type` ENUM('EXPORT', 'ERASURE') NOT NULL,
    `status` ENUM('PENDING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'FAILED') NOT NULL DEFAULT 'PENDING',
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `dueAt` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,
    `subjectNote` VARCHAR(1024) NULL,
    `decisionNote` VARCHAR(1024) NULL,
    `handledById` CHAR(26) NULL,
    `handledAt` DATETIME(3) NULL,
    `fileKey` VARCHAR(512) NULL,
    `fileName` VARCHAR(255) NULL,
    `downloadTokenHash` CHAR(64) NULL,
    `downloadExpiresAt` DATETIME(3) NULL,
    `downloadedAt` DATETIME(3) NULL,
    `errorMessage` VARCHAR(1024) NULL,
    `resultJson` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_data_request_download_token`(`downloadTokenHash`),
    INDEX `ix_data_request_due`(`status`, `dueAt`),
    INDEX `ix_data_request_subject`(`subjectUserId`, `requestedAt`),
    INDEX `ix_data_request_type_status`(`type`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
