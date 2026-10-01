-- Fraud and risk controls (SEC-008): configurable rules and the signals they raise.
-- Signals are evidence for a reviewer; nothing here blocks an account or an order.
CREATE TABLE `risk_rules` (
    `code` VARCHAR(48) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `severity` ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL') NOT NULL,
    `threshold` INTEGER NOT NULL,
    `windowMinutes` INTEGER NOT NULL,
    `thresholdMinor` BIGINT NULL,
    `currency` CHAR(3) NULL,
    `approvedForProduction` BOOLEAN NOT NULL DEFAULT false,
    `updatedById` CHAR(26) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `risk_signals` (
    `id` CHAR(26) NOT NULL,
    `ruleCode` VARCHAR(48) NOT NULL,
    `severity` ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL') NOT NULL,
    `subjectType` VARCHAR(32) NOT NULL,
    `subjectId` VARCHAR(64) NOT NULL,
    `observed` INTEGER NOT NULL,
    `threshold` INTEGER NOT NULL,
    `facts` JSON NOT NULL,
    `dedupeKey` VARCHAR(191) NOT NULL,
    `status` ENUM('OPEN', 'CONFIRMED', 'FALSE_POSITIVE') NOT NULL DEFAULT 'OPEN',
    `reviewedById` CHAR(26) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `reviewReason` VARCHAR(1024) NULL,
    `detectedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_risk_signal_dedupe`(`dedupeKey`),
    INDEX `ix_risk_signal_queue`(`status`, `detectedAt`),
    INDEX `ix_risk_signal_subject`(`subjectType`, `subjectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Starting values only. They are NOT approved for production: the risk owner
-- reviews each one in the admin console before relying on it.
INSERT INTO `risk_rules` (`code`, `severity`, `threshold`, `windowMinutes`, `thresholdMinor`, `currency`) VALUES
    ('LOGIN_FAILURES', 'MEDIUM', 5, 15, NULL, NULL),
    ('SENSITIVE_CHANGE_AFTER_FAILURES', 'HIGH', 3, 60, NULL, NULL),
    ('DUPLICATE_SELLER_IDENTIFIER', 'HIGH', 2, 525600, NULL, NULL),
    ('EVIDENCE_REUSED', 'HIGH', 2, 525600, NULL, NULL),
    ('EVIDENCE_LATE_UPLOAD', 'MEDIUM', 1, 1440, NULL, NULL),
    ('REFUND_FREQUENCY', 'MEDIUM', 3, 43200, NULL, NULL),
    ('REFUND_VALUE', 'HIGH', 1, 43200, 5000000, 'INR'),
    ('PROMO_REDEMPTIONS', 'MEDIUM', 5, 1440, NULL, NULL),
    ('ORDER_VELOCITY', 'MEDIUM', 10, 60, NULL, NULL),
    ('MULTIPLE_HIGH_RISK', 'CRITICAL', 2, 1440, NULL, NULL);
