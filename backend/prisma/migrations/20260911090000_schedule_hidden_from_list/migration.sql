-- Letting a customer clear a finished schedule off their own list.
--
-- A cancelled plan currently sits in the Schedule Cart list forever. There was
-- no way to put it away, and "cancel it again" is not one - it is already
-- cancelled.
--
-- WHY THIS IS A FLAG AND NOT A DELETE
--
-- The row is the record that somebody authorised recurring charges against
-- their card: `consentAcceptedAt`, `consentVersion`, the cart snapshot they
-- confirmed on the review screen, and every occurrence and order produced
-- from it. A customer tidying a list is not a reason to destroy the evidence
-- behind a charge that may be disputed months later.
--
-- It could not be a hard delete in any case. `schedule_occurrences.orderId`
-- and the plan's own foreign keys are ON DELETE RESTRICT, so a plan that has
-- ever run cannot be removed without taking real orders with it - which is
-- exactly the protection those constraints exist to give.
--
-- So the flag narrows the CUSTOMER's reads and nothing else. Staff still see
-- the plan under the admin console, the GDPR export still discloses it, and
-- erasure under Art. 17 stays a separate act with its own route that does
-- delete rows.
--
-- THE INVARIANT
--
-- Only a plan in a terminal status may be hidden - CANCELLED or COMPLETED.
-- Hiding an ACTIVE, PAUSED, DRAFT or FAILED plan would mean money leaving an
-- account for an arrangement the customer can no longer see, and a FAILED plan
-- is one the customer is still allowed to resume. `hideSchedule` refuses
-- anything else, and the CHECK below is the second lock: it is the one rule
-- here that must hold even if a future caller forgets to ask.
--
-- NULL is the default and means "on the list", so every plan that exists when
-- this migration runs behaves exactly as it did.

ALTER TABLE `recurring_schedules`
  ADD COLUMN `hiddenAt` DATETIME(3) NULL AFTER `cancelReason`;

-- MariaDB 10.4 enforces CHECK constraints, which is what makes this worth
-- writing: the status list is spelled out rather than referenced, because an
-- enum column here is a string and there is nothing to point at.
ALTER TABLE `recurring_schedules`
  ADD CONSTRAINT `chk_schedule_hidden_only_when_terminal`
  CHECK (`hiddenAt` IS NULL OR `status` IN ('CANCELLED', 'COMPLETED'));
