-- Seller Hub idle session.
--
-- The Hub lock is carried through refresh-token rotation now, and ends after
-- SELLER_HUB_IDLE_TIMEOUT_SECONDS without deliberate Seller Hub activity.
-- This column records that activity, per session. Nullable: every existing
-- session starts without it, and an unlocked session without it is judged by
-- when it was unlocked.

-- AlterTable
ALTER TABLE `sessions` ADD COLUMN `sellerLastActivityAt` DATETIME(3) NULL;
