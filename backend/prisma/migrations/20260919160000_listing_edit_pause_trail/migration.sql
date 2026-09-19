-- Who took this listing off sale, and when.
--
-- Pausing already worked, and `seller_audit_logs` already recorded that it
-- happened. What neither could answer is the question the listings screen asks
-- on every row it draws: "this one is paused - who did that, and how long ago?"
-- An audit query per row is a table of forty listings issuing forty queries,
-- and the answer is wanted often enough that it belongs beside the status.
--
-- It matters more now than it did, because pausing has stopped being only a
-- way to hide something. "Pause & Edit" pauses a live listing so that its
-- structure - its category, its options, its combinations - can be changed
-- without a buyer watching the page rearrange itself underneath them. A seller
-- who comes back to a paused listing three days later needs to be told it was
-- one of their colleagues editing it, not a compliance hold.
--
-- Both columns are nullable, and null is the ordinary answer for every row
-- that exists today: a listing paused before this migration keeps its status
-- and simply has no trail, which the screen renders as "paused" with no
-- attribution rather than as an error. Nothing reads these to decide whether
-- something can be sold - `status` alone still does that - so a deployment
-- that upgrades and changes nothing behaves exactly as it did.
--
-- `pausedByProfileId` is deliberately NOT a foreign key. It names a customer
-- profile, and a profile that is later erased under Art. 17 must not make this
-- row undeletable or drag the listing's history out with it. The same reasoning
-- the audit log already uses for its actor columns.
--
-- ROLLING BACK
--
--   ALTER TABLE `seller_offers`
--       DROP COLUMN `pausedAt`, DROP COLUMN `pausedByProfileId`;
--
-- That loses the trail and nothing else. Every listing keeps its status.

ALTER TABLE `seller_offers`
    ADD COLUMN `pausedAt`          DATETIME(3) NULL AFTER `statusReason`,
    ADD COLUMN `pausedByProfileId` CHAR(26)    NULL AFTER `pausedAt`;
