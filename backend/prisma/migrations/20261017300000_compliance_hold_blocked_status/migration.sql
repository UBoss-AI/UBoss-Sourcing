-- `seller_offer_compliance_holds.previousStatus` stores the status an offer
-- had before a compliance hold, so it uses the same SellerOfferStatus enum as
-- `seller_offers.status`. 20261017100000_seller_hub_trade_production added
-- BLOCKED to `seller_offers.status` only; a hold placed on a BLOCKED offer
-- could not then record where it came from. Appending an enum member is safe
-- on a live installation: existing values keep their positions.

-- AlterTable
ALTER TABLE `seller_offer_compliance_holds` MODIFY `previousStatus` ENUM('INACTIVE', 'ACTIVE', 'PAUSED', 'NEEDS_CHANGES', 'ARCHIVED', 'BLOCKED') NOT NULL;
