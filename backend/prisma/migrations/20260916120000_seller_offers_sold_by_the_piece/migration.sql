-- A third-party seller's offer is sold by the PIECE.
--
-- WHAT WAS WRONG
--
-- The shop began as an operator selling cartons of 500, and every basket line
-- was converted on that basis, because for a while every basket line belonged
-- to the operator. A seller's offer then arrived priced per piece, and the
-- basket converted "twelve pieces" into one carton of five hundred and charged
-- five hundred times the figure on the card. The offer column was right all
-- along - `seller_offers.orderingUnit` has defaulted to PIECE since the Seller
-- Hub landed - and nothing read it.
--
-- So the fix is in the code, not in the data: the cart now resolves WHO IS
-- SELLING a line before deciding what the line is counted in. This migration
-- exists for the deployments where that assumption might not hold, and it is
-- written to be safe on a database where it finds nothing to do - which is the
-- case on the deployment it was written against.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
--   * **It does not rewrite a single unit.** An offer stored as OUTER_CARTON
--     cannot be read as pieces without dividing the seller's price by five
--     hundred, nor left as cartons without multiplying the buyer's basket by
--     it. There is no safe guess, so nothing is guessed - the offer is taken
--     off sale and handed back to the seller to restate. `sellerSellUnit()` in
--     `domain/ordering-unit.ts` refuses it at runtime for the same reason.
--
--   * **It does not touch a single historical record.** `order_items`,
--     invoices, refunds and schedule occurrences keep the unit and the factor
--     agreed at purchase time, even where that factor came from the bug. An
--     invoice that rewords itself is an invoice that no longer matches what was
--     signed, and the two carton-denominated seller order lines on this
--     deployment are evidence of what was actually charged.
--
--   * **It adds no CHECK constraint.** A constraint saying "a seller offer is
--     PIECE" would be true of every offer this shop will write from now on, and
--     would refuse to apply on any deployment holding one of the rows above -
--     the exact deployments that need the flag most.

-- ---------------------------------------------------------------------------
-- 1. Hold any offer whose unit intent cannot be known
-- ---------------------------------------------------------------------------
--
-- NEEDS_CHANGES is the status that already means "something is wrong that the
-- seller must fix", and `statusReason` is already what the listings page prints
-- beside it - so this reuses the route a seller already knows rather than
-- inventing a state nobody has a screen for. It is not buyable in that status,
-- which is the point: better a listing the seller has to restate than a buyer
-- charged five hundred times what they read.
--
-- `archivedAt IS NULL` so a withdrawn offer is left alone; it is evidence, not
-- something anybody is going to fix.
UPDATE `seller_offers`
SET
  `status` = 'NEEDS_CHANGES',
  `statusReason` = 'This listing is set up in cartons. The marketplace now sells seller listings by the piece - please restate the price and stock per piece and put it back on sale.',
  `version` = `version` + 1
WHERE
  `orderingUnit` <> 'PIECE'
  AND `archivedAt` IS NULL
  AND `status` IN ('ACTIVE', 'INACTIVE', 'PAUSED');

-- ---------------------------------------------------------------------------
-- 2. Repair terms that make an offer unbuyable at any quantity
-- ---------------------------------------------------------------------------
--
-- Unlike the unit, these are safe to correct, and that is the whole difference:
-- neither one can change what a buyer is charged. A minimum of 0 and a step of
-- 0 are both simply broken - the first makes every quantity fail the minimum
-- check and the second divides by zero on the step - and 1 is the only value
-- either could have been meant to be. The service validates both now; this is
-- for rows written before it did.
UPDATE `seller_offers` SET `minimumOrderQuantity` = 1 WHERE `minimumOrderQuantity` < 1;
UPDATE `seller_offers` SET `orderIncrement` = 1 WHERE `orderIncrement` < 1;

-- A ceiling below the floor is the third way to make an offer unbuyable, and
-- the only non-destructive reading is that the ceiling was never meant. Cleared
-- rather than raised: raising it would invent a limit the seller never agreed
-- to, and NULL already means "no ceiling".
UPDATE `seller_offers`
SET `maximumOrderQuantity` = NULL
WHERE `maximumOrderQuantity` IS NOT NULL AND `maximumOrderQuantity` < `minimumOrderQuantity`;
