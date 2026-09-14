-- Which seller's offer a basket line and an order line came from.
--
-- Until now a line knew a PRODUCT and nothing else, which was correct while the
-- deployment had exactly one supplier: whoever runs it. A marketplace breaks
-- that assumption at the first product two businesses both sell. "Two cartons
-- of IV cannula" is then not an instruction anybody can act on - it does not
-- say whose cannula, at whose price, out of whose warehouse, or who gets paid.
--
-- NULL IS NOT MISSING DATA. Null means the operator's own stock, which is what
-- every row that exists today is and what most rows on a single-supplier
-- deployment will always be. Making it NOT NULL would require inventing an
-- offer for the operator, and the operator is not a seller - they have no
-- commission, no settlement and no seller order number.
--
-- ON DELETE RESTRICT, deliberately. An offer that has been ordered cannot be
-- deleted, because the order line is evidence of what was sold and deleting the
-- offer would leave a line pointing at nothing. Archiving an offer is the
-- supported way to retire one, and it leaves this intact.
ALTER TABLE `cart_items`
  ADD COLUMN `sellerOfferId` CHAR(26) NULL AFTER `variantKey`,
  ADD CONSTRAINT `fk_cart_item_seller_offer`
    FOREIGN KEY (`sellerOfferId`) REFERENCES `seller_offers` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX `ix_cart_item_seller_offer` ON `cart_items` (`sellerOfferId`);

ALTER TABLE `order_items`
  ADD COLUMN `sellerOfferId` CHAR(26) NULL AFTER `variantId`,
  ADD CONSTRAINT `fk_order_item_seller_offer`
    FOREIGN KEY (`sellerOfferId`) REFERENCES `seller_offers` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX `ix_order_item_seller_offer` ON `order_items` (`sellerOfferId`);

-- The commission the marketplace takes when a seller's offer is bought.
--
-- Basis points, so 250 is 2.50% - a percentage stored as a decimal is how a
-- rate ends up as 0.024999999 and a settlement stops reconciling. Zero by
-- default, and that default is the honest one: a deployment that has not
-- decided what it charges must not silently start charging something.
--
-- This is the PLATFORM rate. `seller_accounts.commissionBasisPoints` overrides
-- it per seller and is already nullable for exactly that reason - a seller
-- negotiated onto a different schedule keeps it when the platform rate moves.
ALTER TABLE `business_profile`
  ADD COLUMN `sellerCommissionBasisPoints` SMALLINT NOT NULL DEFAULT 0;

-- The companion key for the basket's unique index.
--
-- MariaDB treats every NULL in a UNIQUE index as distinct, so extending
-- `uq_cart_item_sku` with the nullable `sellerOfferId` would stop re-adding the
-- operator's own SKU from bumping the quantity and start creating a second row
-- every time. `''` for the operator, the offer id otherwise - exactly the trick
-- `variantKey` already plays on this table, for exactly the same reason.
ALTER TABLE `cart_items`
  ADD COLUMN `sellerOfferKey` VARCHAR(26) NOT NULL DEFAULT '' AFTER `sellerOfferId`;

-- The old unique index cannot simply be dropped. It is leftmost on `cartId`,
-- which makes it the index the cart foreign key relies on, and MariaDB refuses
-- to drop an index a constraint needs. Giving that key an index of its own
-- frees it -- and `cartId` alone is an index this table wants anyway, since
-- every read of a basket is by cart.
--
-- MariaDB 10.4 has no `ALTER TABLE ... RENAME INDEX` (that arrived in 10.5), so
-- the replacement has to be created under the old name after the drop rather
-- than built beside it and renamed.
CREATE INDEX `ix_cart_item_cart` ON `cart_items` (`cartId`);

DROP INDEX `uq_cart_item_sku` ON `cart_items`;
CREATE UNIQUE INDEX `uq_cart_item_sku`
  ON `cart_items` (`cartId`, `productId`, `variantKey`, `sellerOfferKey`);
