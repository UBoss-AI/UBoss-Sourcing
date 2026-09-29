-- Master row 14: sellers invite their own team, and owners and administrators
-- record periodic access reviews.
--
-- `seller_invitations` existed but nothing wrote to it. It gains what the
-- buyer-company invitations already have: the address as typed, a `liveKey`
-- whose UNIQUE index keeps one live invitation per address per seller (MariaDB
-- lets any number of NULLs through, so retired rows stay), a send counter for
-- the resend cap, and who withdrew it.
--
-- `team_access_reviews` is one row per "I have checked who has access",
-- belonging to exactly one seller or one buyer company.

ALTER TABLE `seller_invitations` ADD COLUMN `email` VARCHAR(320) NOT NULL,
    ADD COLUMN `lastSentAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `liveKey` VARCHAR(360) NULL,
    ADD COLUMN `revokedByProfileId` CHAR(26) NULL,
    ADD COLUMN `sendCount` INTEGER NOT NULL DEFAULT 1;

-- No code has ever written this table, but a row put there by hand keeps a
-- readable address rather than an empty one.
UPDATE `seller_invitations` SET `email` = `emailNormalized` WHERE `email` = '';

CREATE UNIQUE INDEX `uq_seller_invitation_live` ON `seller_invitations`(`liveKey`);

CREATE TABLE `team_access_reviews` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NULL,
    `buyerCompanyId` CHAR(26) NULL,
    `reviewedByUserId` CHAR(26) NOT NULL,
    `memberCount` INTEGER NOT NULL,
    `invitationCount` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_team_access_review_seller`(`sellerAccountId`, `createdAt`),
    INDEX `ix_team_access_review_company`(`buyerCompanyId`, `createdAt`),
    PRIMARY KEY (`id`),
    -- A review is of one team: a seller's or a buyer company's, never both,
    -- never neither. Both foreign keys are ON UPDATE RESTRICT (MariaDB 11.4
    -- refuses a CHECK column whose key cascades on update).
    CONSTRAINT `chk_team_access_review_one_owner` CHECK (
        (`sellerAccountId` IS NULL) <> (`buyerCompanyId` IS NULL)
    ),
    CONSTRAINT `chk_team_access_review_counts` CHECK (
        `memberCount` >= 0 AND `invitationCount` >= 0
    )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `team_access_reviews` ADD CONSTRAINT `fk_team_access_review_seller` FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE `team_access_reviews` ADD CONSTRAINT `fk_team_access_review_company` FOREIGN KEY (`buyerCompanyId`) REFERENCES `buyer_companies`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
