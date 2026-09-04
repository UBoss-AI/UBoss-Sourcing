-- Staff onboarding moves from an emailed activation link to an emailed
-- temporary password.
--
-- `mustChangePassword` is the enforcement point, not a UI hint: while it is set
-- the account can authenticate but every admin route refuses it, so the only
-- thing the session can do is set a real password.
--
-- `temporaryPasswordExpiresAt` exists because a password sent in plaintext
-- stays in the recipient's inbox indefinitely. The link it replaces expired on
-- its own; this restores that property.
--
-- Both default to "no temporary password outstanding", which is the correct
-- state for every account that already exists.

ALTER TABLE `users`
    ADD COLUMN `mustChangePassword` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `temporaryPasswordExpiresAt` DATETIME(3) NULL;
