-- A price that is a placeholder, and is known to be one.
--
-- A catalogue imported from a supplier sheet arrives with no prices at all.
-- Until the real figures exist somebody still has to be able to open the shop,
-- press Add to basket, walk a checkout and see a total - none of which is
-- possible against a product priced on request. So a placeholder gets set.
--
-- The column exists because of what happens afterwards. Without it, "which of
-- these two hundred prices did we make up?" has no answer once the run has
-- finished: a placeholder and a real price are the same BIGINT. A placeholder
-- that cannot be found again is a placeholder that ships, and this one would
-- ship attached to medical consumables.
--
-- It is cleared automatically the moment an administrator types a price by
-- hand (see `updateProduct`), so it never marks a figure somebody has
-- confirmed - and it is not in the public product select, so it changes
-- nothing a customer sees. The price displays and behaves like any other.
--
-- Defaults to false, so every product already in a running installation keeps
-- behaving exactly as it did.

ALTER TABLE `products`
  ADD COLUMN `hasProvisionalPrice` BOOLEAN NOT NULL DEFAULT false;
