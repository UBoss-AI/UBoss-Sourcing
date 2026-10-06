-- An inconclusive pre-shipment report holds the goods. Its own requirement
-- status, ON_HOLD, so a hold is never shown as a failure. Additive.
-- AlterTable
ALTER TABLE `inspection_requirements` MODIFY `status` ENUM('NOT_REQUIRED', 'AWAITING_BOOKING', 'BOOKED', 'IN_PROGRESS', 'REPORT_IN_REVIEW', 'FAILED', 'BLOCKED_BY_NCR', 'RELEASE_PENDING_APPROVAL', 'RELEASED', 'RELEASED_CONDITIONALLY', 'REEVALUATION_REQUIRED', 'DISPATCHED', 'ON_HOLD') NOT NULL;

