-- Two indexes, so a warehouse that was never used can be deleted cheaply.
--
-- `/warehouses` gained a delete beside its retire. The two are different acts
-- and both are needed: retiring archives a warehouse that has been used and
-- keeps every movement ever booked against it readable, while deleting removes
-- a row that never held anything - the duplicate somebody created with a typo
-- in the code, the site that was planned and never opened.
--
-- Deleting is only ever allowed when nothing points at the row, because
-- `inventory_movements`, `inventory_balances`, `stock_reservations` and
-- `recurring_schedules` all reference it with ON DELETE RESTRICT. So the guard
-- asks each of those tables "is there anything here for this warehouse?", and
-- two of them had no index that could answer it.
--
-- The cost falls in exactly the wrong place without these. A warehouse with
-- history matches on the first row it reads and answers instantly; a warehouse
-- with none has to read to the end of the table to prove it - and that is the
-- case where the answer is "yes, delete it", the one an administrator is
-- actually waiting for. `inventory_movements` grows with every receipt,
-- adjustment and commit this deployment has ever made.
--
-- `inventory_balances` already had `ix_inventory_balance_location` and
-- `recurring_schedules` already had `ix_schedule_location`, so those two are
-- untouched. Nothing else changes: both statements are additive, neither
-- rewrites a row, and every existing query is unaffected.

-- CreateIndex
CREATE INDEX `ix_inventory_movement_location` ON `inventory_movements`(`locationId`);

-- The reservation guard counts every status, not only ACTIVE. A RELEASED or
-- EXPIRED reservation is finished business and still holds the row in place
-- with its foreign key, so `ix_reservation_sweep` (status, expiresAt) is the
-- wrong shape for this question.
CREATE INDEX `ix_reservation_location` ON `stock_reservations`(`locationId`);
