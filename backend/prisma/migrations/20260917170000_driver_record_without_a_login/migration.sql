-- A driver is somebody the carrier writes down, not somebody with an account.
--
-- WHAT WAS WRONG
--
-- `logistics_driver_profiles.partnerUserId` was NOT NULL, so every driver had
-- to be a `logistics_partner_users` row, which had to be a `users` row, which
-- could only be created by the MARKETPLACE sending an invitation. A carrier
-- could not add its own driver at all: it had to ask the operator to invite the
-- person, wait for them to redeem a link and choose a password, and only then
-- put them on the fleet.
--
-- That is the wrong shape for the business. A haulage company employs people
-- who will never open this software - a subcontracted van driver, an agency
-- stand-in for a week, somebody who started on Monday - and a fleet register
-- that can only hold people with a login is a register that does not describe
-- the fleet. Whoever runs the depot has to be able to type a name and get on
-- with the day.
--
-- WHAT CHANGES
--
--   * `fullName` moves ONTO this row. It was read through
--     `partnerUser.fullName`, which is exactly the coupling this removes. It is
--     now the source of truth for every screen that names a driver - the
--     consignment, the timeline, the manifest, both fleet lists.
--   * `phone` and `email` come with it, for the same reason: a dispatcher
--     ringing a late van needs a number, and that number is a fact about the
--     driver rather than about an account they may not have.
--   * `partnerUserId` becomes NULLABLE, and null is the ordinary case. It is
--     filled only for a driver who signs in on a phone, and it remains what
--     gates every device feature: the task list, the scanner, proof of
--     delivery, and the trip that permits a location ping. A record-only
--     driver can be put on a consignment and can do none of those, because
--     there is nobody to do them as.
--
-- The UNIQUE index stays. One account maps to one driver record, and a MariaDB
-- unique index treats every NULL as distinct - so any number of record-only
-- drivers sit beside each other without colliding. The same property
-- `activeShipmentId` relies on next door.
--
-- THE FOREIGN KEY CHANGES FROM CASCADE TO SET NULL
--
-- It used to delete the driver record when the member was deleted, taking the
-- record of who carried what with it. Now that the name lives here, removing
-- an account leaves the driver - and every assignment naming them - intact,
-- and only the link goes. A fleet register that forgets who drove last month
-- cannot answer the one question asked after a bad delivery.
--
-- BACKWARD COMPATIBLE
--
-- `fullName` is back-filled from the linked member before it is made NOT NULL,
-- so every existing driver keeps the name every existing screen already showed
-- for them, and every existing link is left in place. Nothing is deleted and
-- no existing driver loses their sign-in.

-- ---------------------------------------------------------------------------
-- 1. The columns, added nullable so the back-fill has somewhere to land
-- ---------------------------------------------------------------------------

ALTER TABLE `logistics_driver_profiles`
    ADD COLUMN `fullName` VARCHAR(160) NOT NULL DEFAULT '' AFTER `logisticsPartnerId`,
    ADD COLUMN `phone`    VARCHAR(32)  NULL               AFTER `fullName`,
    ADD COLUMN `email`    VARCHAR(320) NULL               AFTER `phone`;

-- ---------------------------------------------------------------------------
-- 2. Back-fill from the member each driver is currently tied to
-- ---------------------------------------------------------------------------

UPDATE `logistics_driver_profiles` d
JOIN `logistics_partner_users` u ON u.`id` = d.`partnerUserId`
SET d.`fullName` = u.`fullName`,
    d.`phone`    = u.`phone`;

-- A driver whose member somehow carries no name still needs one: the column is
-- about to become NOT NULL, and an empty name on a fleet screen is a row
-- nobody can identify. Unreachable through the API - `fullName` is required on
-- a member - and cheap insurance against a hand-written row.
UPDATE `logistics_driver_profiles`
SET `fullName` = 'Unnamed driver'
WHERE `fullName` = '';

-- ---------------------------------------------------------------------------
-- 3. Drop the default, and let the link be absent
-- ---------------------------------------------------------------------------

ALTER TABLE `logistics_driver_profiles`
    MODIFY `fullName` VARCHAR(160) NOT NULL;

-- The foreign key has to go before the column it constrains can change
-- nullability, and it comes back below with the new delete rule.
ALTER TABLE `logistics_driver_profiles`
    DROP FOREIGN KEY `logistics_driver_profiles_partnerUserId_fkey`;

ALTER TABLE `logistics_driver_profiles`
    MODIFY `partnerUserId` CHAR(26) NULL;

ALTER TABLE `logistics_driver_profiles`
    ADD CONSTRAINT `logistics_driver_profiles_partnerUserId_fkey`
        FOREIGN KEY (`partnerUserId`) REFERENCES `logistics_partner_users`(`id`)
        ON DELETE SET NULL ON UPDATE CASCADE;

-- The fleet list reads by name within a carrier, and the picker on a
-- consignment reads the same order. Without this it is a filesort on every
-- open of either.
CREATE INDEX `ix_logistics_driver_name` ON `logistics_driver_profiles` (`logisticsPartnerId`, `fullName`);
