-- Every table has createdAt and updatedAt (tests/unit/row-timestamps.test.ts).
-- An access review is written once; updatedAt equals createdAt for existing rows.
ALTER TABLE `team_access_reviews` ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
UPDATE `team_access_reviews` SET `updatedAt` = `createdAt`;
