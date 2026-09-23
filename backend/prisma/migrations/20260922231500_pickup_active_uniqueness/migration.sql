-- One live collection per consignment, enforced by the database.
--
-- Two vans is the failure mode here, and it is an expensive one: the second
-- booking is chargeable, the second van is the one nobody remembers to cancel,
-- and a warehouse that hands the same cartons to two drivers has lost them.
--
-- A read-then-insert cannot prevent it. Two dispatchers pressing "book a
-- collection" in the same second both read no live pickup and both write one,
-- and no amount of care in the service closes that window.
--
-- So it is the NULL-IS-DISTINCT IDIOM this schema uses throughout:
-- `activeForShipmentId` holds the consignment's id for as long as the
-- collection is live, and is set to NULL the moment it completes, fails or is
-- cancelled. MariaDB treats every NULL in a UNIQUE index as distinct, so any
-- number of finished collections coexist for one consignment while a second
-- LIVE one collides in the index.
--
-- BACKFILLED, because the table may already hold rows. Every pickup that is
-- not in a terminal state gets its shipment id; the rest stay NULL. Where the
-- data somehow already holds two live collections for one consignment the
-- CREATE UNIQUE INDEX fails, which is correct - that is a real double booking
-- and somebody has to look at it rather than have it silently kept.
--
-- ROLLBACK: drop the index, drop the column.

ALTER TABLE `logistics_pickup_requests`
    ADD COLUMN `activeForShipmentId` CHAR(26) NULL AFTER `shipmentId`;

UPDATE `logistics_pickup_requests`
   SET `activeForShipmentId` = `shipmentId`
 WHERE `shipmentId` IS NOT NULL
   AND `state` IN ('REQUESTED', 'SCHEDULED', 'CONFIRMED');

CREATE UNIQUE INDEX `uq_logistics_pickup_active` ON `logistics_pickup_requests`(`activeForShipmentId`);
