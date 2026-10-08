-- Seller turnover eligibility.
--
-- The marketplace's own policy (SELLER_TURNOVER_*): only a business whose
-- turnover for its most recently completed financial year EXCEEDS the
-- configured minimum may apply to sell. One row per declaration; rows
-- accumulate and `isCurrent` marks the live one, like seller_screening_checks.
-- The declaration, its verification and the seller's approval stay separate.
--
-- Additive: no existing row changes and no approved seller is affected.

-- CreateTable
CREATE TABLE `seller_turnover_declarations` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `amountMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `financialYearStart` DATE NOT NULL,
    `financialYearEnd` DATE NOT NULL,
    `minimumMinor` BIGINT NOT NULL,
    `policyVersion` VARCHAR(32) NOT NULL,
    `declaredAt` DATETIME(3) NOT NULL,
    `declaredByProfileId` CHAR(26) NULL,
    `verificationState` ENUM('NOT_STARTED', 'AWAITING_INPUT', 'IN_PROGRESS', 'VERIFIED', 'FAILED', 'PROVIDER_UNCONFIGURED', 'EXPIRED') NOT NULL DEFAULT 'AWAITING_INPUT',
    `decisionReason` TEXT NULL,
    `internalNote` TEXT NULL,
    `reviewedByUserId` CHAR(26) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `supersededReason` VARCHAR(32) NULL,
    `isCurrent` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_seller_turnover_current`(`sellerAccountId`, `isCurrent`),
    INDEX `ix_seller_turnover_state`(`verificationState`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `seller_turnover_declarations` ADD CONSTRAINT `fk_seller_turnover_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
