-- Quantity price bands that are actually applied (Work 3).
--
-- seller_price_tiers existed, was editable, and was never read by the cart:
-- a buyer adding 5,000 pieces paid the one-piece price. These columns make a
-- band something a seller can schedule, pause and aim at a kind of buyer, and
-- order_items.quantityTierJson freezes which band priced a line.
--
-- Additive only. Every existing band becomes active, unconditional and for the
-- basket, which is what it would always have meant had it been applied.

-- AlterTable
ALTER TABLE `order_items` ADD COLUMN `quantityTierJson` JSON NULL;

-- AlterTable
ALTER TABLE `seller_price_tiers` ADD COLUMN `businessBuyersOnly` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `countryCodes` JSON NULL,
    ADD COLUMN `endsAt` DATETIME(3) NULL,
    ADD COLUMN `isActive` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `maxQuantity` INTEGER NULL,
    ADD COLUMN `preorderOnly` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `startsAt` DATETIME(3) NULL;

-- A band starts at one piece or more, costs something, ends at or after it
-- starts, and a window closes after it opens.
ALTER TABLE `seller_price_tiers`
    ADD CONSTRAINT `chk_seller_price_tier_min` CHECK (`minQuantity` >= 1),
    ADD CONSTRAINT `chk_seller_price_tier_price` CHECK (`priceMinor` > 0),
    ADD CONSTRAINT `chk_seller_price_tier_range` CHECK (`maxQuantity` IS NULL OR `maxQuantity` >= `minQuantity`),
    ADD CONSTRAINT `chk_seller_price_tier_window` CHECK (`startsAt` IS NULL OR `endsAt` IS NULL OR `endsAt` > `startsAt`);
