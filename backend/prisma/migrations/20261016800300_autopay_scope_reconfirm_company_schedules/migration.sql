-- AutoPay authority scope and period cap, price reconfirmation for scheduled
-- deliveries, and plans bought for a buyer company.
--
-- Everything is additive: new nullable columns and one new enum value. A
-- deployment behaves exactly as before until a customer sets a start date, a
-- period cap or a scope, a price moves beyond a plan's tolerance, or a member
-- creates a plan while buying for a company.
--
--   * `customer_autopay_settings` - a start date, a cap per calendar period,
--     and the suppliers and categories the authority covers.
--   * `schedule_occurrences.status` gains AWAITING_CONFIRMATION, with the
--     columns that record the deadline and the total the customer accepted.
--   * `recurring_schedules.buyerCompanyId` - the company a plan buys for.

ALTER TABLE `customer_autopay_settings`
    ADD COLUMN `authorityStartsAt` DATETIME(3) NULL,
    ADD COLUMN `periodCapMinor` BIGINT NULL,
    ADD COLUMN `capPeriod` ENUM('WEEK', 'MONTH', 'QUARTER', 'YEAR') NULL,
    ADD COLUMN `scopeSellerKeysJson` JSON NULL,
    ADD COLUMN `scopeCategoryIdsJson` JSON NULL;

-- A period cap is an amount, a period and a currency, or it is nothing.
ALTER TABLE `customer_autopay_settings`
    ADD CONSTRAINT `chk_autopay_period_cap` CHECK (
        `periodCapMinor` IS NULL
        OR (`periodCapMinor` > 0 AND `capPeriod` IS NOT NULL AND `limitCurrency` IS NOT NULL)
    );

ALTER TABLE `schedule_occurrences`
    MODIFY `status` ENUM(
        'SCHEDULED', 'AWAITING_VALIDATION', 'PAYMENT_PENDING', 'ACTION_REQUIRED',
        'PROCESSING', 'PAID_ERP_PENDING', 'COMPLETED', 'SKIPPED', 'CANCELLED', 'FAILED',
        'AWAITING_CONFIRMATION',
        'PENDING', 'ORDER_CREATED', 'PAID'
    ) NOT NULL DEFAULT 'SCHEDULED',
    ADD COLUMN `confirmationDueAt` DATETIME(3) NULL,
    ADD COLUMN `confirmedTotalMinor` BIGINT NULL,
    ADD COLUMN `confirmedAt` DATETIME(3) NULL,
    ADD COLUMN `confirmedByUserId` CHAR(26) NULL;

ALTER TABLE `recurring_schedules`
    ADD COLUMN `buyerCompanyId` CHAR(26) NULL;

CREATE INDEX `ix_schedule_buyer_company` ON `recurring_schedules`(`buyerCompanyId`);

ALTER TABLE `recurring_schedules`
    ADD CONSTRAINT `fk_schedule_buyer_company` FOREIGN KEY (`buyerCompanyId`)
        REFERENCES `buyer_companies`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
