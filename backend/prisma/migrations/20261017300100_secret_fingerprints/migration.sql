-- When each application secret was first seen in use. infra/secret-age.ts
-- records a fingerprint (a truncated, domain-separated SHA-256 - never the
-- secret) of each application secret at start-up; the age of a secret is now
-- minus the first time that exact value was seen. Feeds
-- `uboss_secret_age_seconds`, the SECRET_MAX_AGE_DAYS start-up warning and
-- `npm run secrets:status`.
--
-- A new table only, so it is safe on a live installation.

-- CreateTable
CREATE TABLE `secret_fingerprints` (
    `id` CHAR(26) NOT NULL,
    `secretName` VARCHAR(64) NOT NULL,
    `fingerprint` CHAR(16) NOT NULL,
    `firstSeenAt` DATETIME(3) NOT NULL,
    `lastSeenAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_secret_fingerprint`(`secretName`, `fingerprint`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
