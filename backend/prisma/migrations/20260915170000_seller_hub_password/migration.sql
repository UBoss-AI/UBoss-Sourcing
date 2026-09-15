-- The Seller Hub's own lock.
--
-- Selling keeps the same account as buying - one email, one identity, one order
-- history - and gains a second password in front of the Hub. Two questions,
-- answered separately: the sign-in asks whether this is their account, this
-- asks whether they are here to sell.
--
-- `seller_members.password_hash` is Argon2, the same as `users.password_hash`,
-- and NULL for every member that exists today. NULL is "has not chosen one
-- yet", not "has no lock": the Hub asks for it before it opens, the way the
-- carrier portal asks for a second factor. Nobody is locked out by this
-- migration and nobody keeps a Hub that opens without a password.
--
-- It sits on the member rather than the user because what it guards is
-- standing inside one seller organisation. A person selling for two businesses
-- holds two, and neither opens the other.

ALTER TABLE `seller_members`
  ADD COLUMN `passwordHash` VARCHAR(255) NULL AFTER `role`,
  ADD COLUMN `passwordSetAt` DATETIME(3) NULL AFTER `passwordHash`;

-- Proof that THIS session opened the lock, and for which seller.
--
-- The mirror of `sessions.mfaVerifiedAt`, which already draws the same line for
-- the second factor: the member row says the lock exists, this says the browser
-- in front of us has opened it. The seller id is stored alongside the time
-- because unlocking one business must never unlock another.

ALTER TABLE `sessions`
  ADD COLUMN `sellerUnlockedAt` DATETIME(3) NULL AFTER `mfaVerifiedAt`,
  ADD COLUMN `sellerUnlockedForId` CHAR(26) NULL AFTER `sellerUnlockedAt`;
