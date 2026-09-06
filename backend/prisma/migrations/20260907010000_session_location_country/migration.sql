-- Which country an admin session was opened from.
--
-- The coordinates and the place name have been recorded since the sign-in
-- gate landed, and both are written for a person to read. This one is read by
-- the console itself: it is the market the panel prices for, so a member of
-- staff sees what a customer where they are sitting actually pays.
--
-- Additive and nullable. Null is the honest answer for every session that
-- already exists and for every deployment with no geocoder configured, and
-- the console falls back to the seller's own country there - the same answer
-- a storefront gives a shopper who has not said where they are.

-- AlterTable
ALTER TABLE `sessions`
    ADD COLUMN `locationCountry` CHAR(2) NULL AFTER `locationLabel`;
