-- LIVE-015: a privileged-access review of the marketplace's own staff.
--
-- One row per decision a Business Owner records about one staff account:
-- KEEP, REDUCE or REVOKE, with an optional note. What the account held at
-- that moment - its role keys, whether two-factor was on, its last sign-in
-- and whether it counted as dormant - is copied in, so the record still says
-- what was reviewed after the roles change. Rows are never edited.
--
-- Both keys are RESTRICT: a review is evidence, and deleting the account it
-- is about (or the owner who made it) must not quietly take it away.

-- CreateTable
CREATE TABLE `staff_access_reviews` (
    `id` CHAR(26) NOT NULL,
    `reviewedUserId` CHAR(26) NOT NULL,
    `reviewerUserId` CHAR(26) NOT NULL,
    `decision` ENUM('KEEP', 'REDUCE', 'REVOKE') NOT NULL,
    `note` VARCHAR(1000) NULL,
    `rolesJson` JSON NOT NULL,
    `mfaEnabled` BOOLEAN NOT NULL,
    `lastSignInAt` DATETIME(3) NULL,
    `dormant` BOOLEAN NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_staff_access_review_subject`(`reviewedUserId`, `createdAt`),
    INDEX `ix_staff_access_review_reviewer`(`reviewerUserId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `staff_access_reviews` ADD CONSTRAINT `fk_staff_access_review_subject` FOREIGN KEY (`reviewedUserId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `staff_access_reviews` ADD CONSTRAINT `fk_staff_access_review_reviewer` FOREIGN KEY (`reviewerUserId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
