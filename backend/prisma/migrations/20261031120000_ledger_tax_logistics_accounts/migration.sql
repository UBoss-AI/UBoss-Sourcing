-- The transaction ledger gets four platform accounts, so every part of what
-- a buyer paid has a named home and BUYER_FUNDS_CLEARING nets to zero once an
-- order is allocated:
--
--   ORDER_TAX_COLLECTED         tax the buyer paid on top of the price, held
--                               for whoever must remit it
--   PLATFORM_LOGISTICS_REVENUE  delivery the buyer paid for levels the
--                               operator controls, and the operator's own
--                               shipping charge
--   PLATFORM_DISCOUNTS_FUNDED   discounts on marketplace lines; the seller's
--                               share is worked out on the undiscounted price
--   PLATFORM_DIRECT_SALES       the operator's own goods (no seller)
--
-- Enum members are added at the end; no existing row changes. MariaDB has no
-- ALTER TYPE, so the column is redefined with the longer list.

-- AlterTable
ALTER TABLE `ledger_accounts` MODIFY `code` ENUM('PROVIDER_BALANCE', 'BUYER_FUNDS_CLEARING', 'SELLER_HELD', 'SELLER_RESERVE', 'SELLER_AVAILABLE', 'PAYOUTS_IN_TRANSIT', 'PLATFORM_COMMISSION', 'PLATFORM_FEE_TAX', 'CHARGEBACK_RECEIVABLE', 'CHARGEBACK_LOSSES', 'ORDER_TAX_COLLECTED', 'PLATFORM_LOGISTICS_REVENUE', 'PLATFORM_DISCOUNTS_FUNDED', 'PLATFORM_DIRECT_SALES') NOT NULL;
