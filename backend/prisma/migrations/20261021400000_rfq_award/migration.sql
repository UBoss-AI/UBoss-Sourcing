-- Master row 19: the one accepted quote on a request.
--
-- Written only by the acceptance transaction, conditionally on the column
-- being NULL; the UNIQUE index keeps a quote from being the award of two
-- requests. NULLs are distinct, so every unawarded request is allowed.

-- AlterTable
ALTER TABLE `rfq_requests` ADD COLUMN `awardedAt` DATETIME(3) NULL,
    ADD COLUMN `awardedQuoteId` CHAR(26) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `uq_rfq_request_awarded_quote` ON `rfq_requests`(`awardedQuoteId`);
