-- Master rows 11 and 14: invitations to join a buyer company in one role.
--
-- Only the SHA-256 of the token is stored. `liveKey` is set while an
-- invitation can still be accepted and cleared when it is accepted, revoked
-- or replaced; its UNIQUE index keeps one live invitation per address per
-- company while retired rows (NULL) stay as the record.

CREATE TABLE `buyer_company_invitations` (
    `id` CHAR(26) NOT NULL,
    `companyId` CHAR(26) NOT NULL,
    `email` VARCHAR(320) NOT NULL,
    `emailNormalized` VARCHAR(320) NOT NULL,
    `role` ENUM('OWNER', 'COMPANY_ADMIN', 'BUYER', 'ORDER_APPROVER', 'FINANCE', 'VIEWER') NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `liveKey` VARCHAR(360) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `sendCount` INTEGER NOT NULL DEFAULT 1,
    `lastSentAt` DATETIME(3) NOT NULL,
    `invitedByUserId` CHAR(26) NOT NULL,
    `acceptedAt` DATETIME(3) NULL,
    `acceptedByUserId` CHAR(26) NULL,
    `revokedAt` DATETIME(3) NULL,
    `revokedByUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_buyer_company_invitation_token`(`tokenHash`),
    UNIQUE INDEX `uq_buyer_company_invitation_live`(`liveKey`),
    INDEX `ix_buyer_company_invitation_company`(`companyId`, `createdAt`),
    INDEX `ix_buyer_company_invitation_email`(`emailNormalized`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `buyer_company_invitations` ADD CONSTRAINT `fk_buyer_company_invitation_company` FOREIGN KEY (`companyId`) REFERENCES `buyer_companies`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
