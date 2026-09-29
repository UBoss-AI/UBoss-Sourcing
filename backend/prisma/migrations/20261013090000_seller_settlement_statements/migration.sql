-- Seller settlement statements (FEATURE_SELLER_SETTLEMENT_STATEMENTS).
--
-- One statement per seller, period and currency. The worker that closes a
-- period relies on this to be idempotent: a retried or concurrent close
-- collides on the key instead of writing the same money twice. No rows existed
-- before this migration - nothing had ever written a statement.

-- CreateIndex
CREATE UNIQUE INDEX `uq_seller_settlement_period_currency` ON `seller_settlements`(`sellerAccountId`, `periodStart`, `periodEnd`, `currency`);
