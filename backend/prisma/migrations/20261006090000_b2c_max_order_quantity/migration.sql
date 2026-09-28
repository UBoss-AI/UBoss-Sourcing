-- The B2C maximum order quantity: the most units of one product a buyer who
-- is not an approved company may put in one order. See
-- `domain/b2c-order-limit.ts`.
--
-- Nullable, and NULL means "not configured". Every product and offer that
-- exists today gets NULL and keeps selling exactly as it did; Seller Hub
-- flags the listing so its seller can set a figure. No figure is invented
-- here - that would be a business decision nobody made.
--
-- Two homes, because two people own the two kinds of stock:
--   - `seller_offers`: the seller sets it on their own listing. Every offer
--     one listing produced carries the same figure.
--   - `products`: the operator's own stock (a basket line with no seller
--     offer), set by an administrator.

ALTER TABLE `products`
    ADD COLUMN `b2cMaxOrderQuantity` INT NULL;

ALTER TABLE `seller_offers`
    ADD COLUMN `b2cMaxOrderQuantity` INT NULL;

-- The backstop for what the services already refuse: a whole number from 1
-- to 1,000,000 (`B2C_MAX_ORDER_QUANTITY_CEILING`). INT already refuses a
-- fraction or a string.
ALTER TABLE `products`
    ADD CONSTRAINT `chk_product_b2c_max_order_quantity` CHECK (
        `b2cMaxOrderQuantity` IS NULL
        OR (`b2cMaxOrderQuantity` >= 1 AND `b2cMaxOrderQuantity` <= 1000000));

ALTER TABLE `seller_offers`
    ADD CONSTRAINT `chk_seller_offer_b2c_max_order_quantity` CHECK (
        `b2cMaxOrderQuantity` IS NULL
        OR (`b2cMaxOrderQuantity` >= 1 AND `b2cMaxOrderQuantity` <= 1000000));

-- What was applied when the order was placed, frozen with the rest of the
-- order. A seller who changes the limit next week must not change what an
-- old order says was allowed.
--
-- `orders.buyerContextKind`: who the order was placed as. NULL on orders
-- placed before this column, which were all individual unless
-- `buyerCompanyId` says otherwise.
ALTER TABLE `orders`
    ADD COLUMN `buyerContextKind` ENUM('INDIVIDUAL', 'COMPANY') NULL;

-- `b2cMaxOrderQuantityApplied`: the limit in force for this line's product
-- at checkout, or NULL when none was configured.
-- `b2cCompanyExemptionApplied`: true when an approved company placed the
-- order, so the limit did not bind it. Both describe the rule, not the
-- company - nothing from the company's verification is copied here.
ALTER TABLE `order_items`
    ADD COLUMN `b2cMaxOrderQuantityApplied` INT NULL,
    ADD COLUMN `b2cCompanyExemptionApplied` BOOLEAN NOT NULL DEFAULT FALSE;
