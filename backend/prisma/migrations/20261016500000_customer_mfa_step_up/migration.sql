-- Two-step sign-in for buyers and sellers, step-up confirmation, and an end
-- date on AutoPay authority.
--
-- Three added columns on existing tables. Nothing is dropped or narrowed and
-- every column is nullable or defaulted, so a deployment behaves exactly as it
-- did until somebody enrols a factor or sets an end date.
--
--   * `users.mfaFailedCount` - wrong two-step codes in a row. Held apart from
--     `failedLoginCount` because a correct password resets that one.
--   * `sessions.reauthenticatedAt` - when this session last confirmed it was
--     still the holder, for a sensitive act.
--   * `customer_autopay_settings.authorityExpiresAt` - the customer's own end
--     date for their standing payment authority.

ALTER TABLE `users` ADD COLUMN `mfaFailedCount` INTEGER NOT NULL DEFAULT 0;

ALTER TABLE `sessions` ADD COLUMN `reauthenticatedAt` DATETIME(3) NULL;

ALTER TABLE `customer_autopay_settings` ADD COLUMN `authorityExpiresAt` DATETIME(3) NULL;
