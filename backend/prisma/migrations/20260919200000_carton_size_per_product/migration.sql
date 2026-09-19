-- The carton stops being a property of the shop and becomes one of the product.
--
-- WHAT WAS WRONG
--
-- `PIECES_PER_CARTON` is one number for the whole deployment, and every
-- product the operator owns was priced and counted by it. That is correct for
-- the consumables range this shop started as - a box of cannulas really does
-- ship five hundred to a carton - and plainly wrong the moment the same
-- catalogue also lists a cordless drill, a laptop and a pair of safety boots.
-- Those were being shown at five hundred times their price with "One carton
-- has 500 pieces" printed underneath, and a basket would have charged it.
--
-- WHAT THIS DOES
--
-- Adds a nullable `piecesPerCarton` to `products`. NULL means sold as a
-- piece, and that is the default every new product gets. A number means one
-- purchasable unit holds that many pieces.
--
-- THE BACKFILL IS THE IMPORTANT HALF
--
-- Every product that already carries a packing description with a readable
-- outer-carton count keeps exactly the behaviour it has today, taken from its
-- OWN sheet rather than from the deployment-wide setting. Anything with no
-- such description becomes a piece - which is what it always was, and what the
-- shop was failing to say.
--
-- Nothing already sold changes. `cart_items`, `order_items` and the schedule
-- lines each snapshot the carton size they were agreed at, so a quantity on an
-- invoice from last year still means the pieces it meant last year.
--
-- ROLLING BACK
--
--   ALTER TABLE `products` DROP COLUMN `piecesPerCarton`;
--
-- Every product then returns to the deployment-wide carton size.

ALTER TABLE `products`
    ADD COLUMN `piecesPerCarton` INT NULL AFTER `unavailabilityReason`;

-- The base packing row only - `variantKey` is the empty string for the family,
-- and a per-variant row describes one size rather than the product.
UPDATE `products` p
    JOIN `product_packaging` k
        ON k.`productId` = p.`id`
       AND k.`variantKey` = ''
       AND k.`piecesPerOuterCarton` IS NOT NULL
       AND k.`piecesPerOuterCarton` > 1
SET p.`piecesPerCarton` = k.`piecesPerOuterCarton`;
