-- Separate preorder minimums for OEM and Original Brand.
--
-- Before this, a preorder policy had ONE minimum (`moqQuantity`) and a buyer
-- could only ever preorder the product as listed: the request form took no
-- design, no artwork and no brand of the buyer's own. So every existing
-- minimum was, in practice, the minimum for the product as listed - the
-- Original Brand. That is the mapping used below, and the only one:
--
--   - An existing minimum becomes the Original Brand minimum, and Original
--     Brand is switched on where a minimum existed. A product that took
--     preorders yesterday takes the same preorders today.
--   - OEM is never switched on, and no minimum is copied into it. A seller
--     who wants OEM preorders sets that minimum themselves.
--   - Where the seller ADVERTISES OEM on the product (`seller_listing_trust.
--     oemAvailable`), the old minimum might have been meant to cover OEM too.
--     Those policies are flagged `productOptionsReviewRequired` so the Seller
--     Hub asks the seller to confirm. A seller default is flagged when the
--     seller advertises OEM on any product.
--
-- Submitted preorders are not touched. Their four new columns stay NULL,
-- which means "made before the two were separate", and each keeps the policy
-- snapshot it was judged under.
--
-- `moqQuantity` stays, unread, so this split can be audited. Prisma names it
-- `legacyMoqQuantity`.

-- AlterTable
ALTER TABLE `preorder_policies`
    ADD COLUMN `originalBrandEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `originalBrandMoqQuantity` INTEGER NULL,
    ADD COLUMN `oemEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `oemMoqQuantity` INTEGER NULL,
    ADD COLUMN `productOptionsReviewRequired` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `preorder_requests`
    ADD COLUMN `productOption` ENUM('ORIGINAL_BRAND', 'OEM') NULL,
    ADD COLUMN `productOptionMoqQuantity` INTEGER NULL,
    ADD COLUMN `productOptionMoqUnit` ENUM('PIECE', 'CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER', 'CONTAINER_20_FT', 'CONTAINER_40_FT') NULL,
    ADD COLUMN `productOptionMinimumBaseUnits` INTEGER NULL;

-- The old minimum is the Original Brand minimum.
UPDATE `preorder_policies`
    SET `originalBrandMoqQuantity` = `moqQuantity`,
        `originalBrandEnabled` = true
    WHERE `moqQuantity` IS NOT NULL;

-- Ambiguous: the seller advertises OEM on this product.
UPDATE `preorder_policies` p
    SET p.`productOptionsReviewRequired` = true
    WHERE p.`moqQuantity` IS NOT NULL
      AND (
        (p.`scope` = 'PRODUCT' AND EXISTS (
            SELECT 1 FROM `seller_listing_trust` t
            WHERE t.`sellerAccountId` = p.`sellerAccountId`
              AND t.`productId` = p.`productId`
              AND t.`oemAvailable` = true))
        OR (p.`scope` = 'OFFER' AND EXISTS (
            SELECT 1 FROM `seller_offers` o
            JOIN `seller_listing_trust` t
              ON t.`sellerAccountId` = o.`sellerAccountId` AND t.`productId` = o.`productId`
            WHERE o.`id` = p.`offerId`
              AND t.`oemAvailable` = true))
        OR (p.`scope` = 'SELLER_DEFAULT' AND EXISTS (
            SELECT 1 FROM `seller_listing_trust` t
            WHERE t.`sellerAccountId` = p.`sellerAccountId`
              AND t.`oemAvailable` = true))
      );

-- A request names its option and minimum together, or (made before this) none.
ALTER TABLE `preorder_requests` ADD CONSTRAINT `chk_preorder_request_product_option` CHECK (
    (`productOption` IS NULL AND `productOptionMoqQuantity` IS NULL
        AND `productOptionMoqUnit` IS NULL AND `productOptionMinimumBaseUnits` IS NULL)
    OR (`productOption` IS NOT NULL AND `productOptionMoqQuantity` > 0
        AND `productOptionMoqUnit` IS NOT NULL AND `productOptionMinimumBaseUnits` > 0)
);
