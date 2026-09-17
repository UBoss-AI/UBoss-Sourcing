-- Who put this driver on it, when that may have been either side.
--
-- `assignedByPartnerUserId` names somebody in the CARRIER's own team, and that
-- was the only answer the column could give. Now that the marketplace's
-- operations desk can assign a driver too - a carrier has gone quiet and their
-- parcels are still on vans - an operator has no row in that table, so the id
-- stays null and the history loses who acted.
--
-- Null already meant "a record from before the column existed", so overloading
-- it with "the marketplace did this" would make the chain unreadable in
-- exactly the situation it is read: after a bad delivery, with somebody asking
-- who moved it.
--
-- A label rather than a second id column, because the two sides are different
-- tables and a second FK would be a second nullable id nobody could join on
-- reliably. The individual is recorded either way - in the carrier's own
-- `logistics_audit_logs` for a carrier action, and in the operator's `audit_log`
-- for an operator one - so this is the readable summary beside the chain
-- rather than the authoritative record of it.

ALTER TABLE `logistics_driver_assignments`
    ADD COLUMN `assignedByLabel` VARCHAR(160) NULL AFTER `assignedByPartnerUserId`;

-- Back-filled from the member who made each existing assignment, so a chain
-- written before today reads the same way as one written after it.
UPDATE `logistics_driver_assignments` a
JOIN `logistics_partner_users` u ON u.`id` = a.`assignedByPartnerUserId`
SET a.`assignedByLabel` = u.`fullName`
WHERE a.`assignedByLabel` IS NULL;
