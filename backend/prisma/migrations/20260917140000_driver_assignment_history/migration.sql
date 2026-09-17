-- One live driver per consignment, enforced by the database, and a readable
-- history of everyone who carried it.
--
-- WHAT WAS WRONG
--
-- `assignDriver` closed the previous assignment and created a new one inside a
-- transaction, which is correct and is not sufficient. Two dispatchers pressing
-- Assign in the same second both read "nothing live here", both close nothing,
-- and both insert - and the consignment is on two vans until one of them
-- telephones the other. Nothing in the schema said that could not happen, so
-- sooner or later it did.
--
-- HOW THIS FIXES IT, ON MARIADB 10.4
--
-- MariaDB has no partial indexes, so "UNIQUE among the live rows" cannot be
-- written directly. It does treat **every NULL in a UNIQUE index as distinct**
-- - the property `variantKey` exists elsewhere in this schema to work AROUND,
-- used here deliberately. A new `activeShipmentId` holds the shipment id while
-- an assignment is live and NULL once it is not, and
-- `uq_logistics_driver_active` over that one column therefore permits any
-- number of finished assignments per consignment and exactly one live one.
-- The loser of a race gets a unique-constraint error rather than a second van.
--
-- THE TWO HISTORY COLUMNS
--
--   * `unassignedReason` - why a driver was taken off, in the dispatcher's own
--     words. A driver who finished the job and a driver who was pulled off it
--     halfway are the same row shape today and very different facts; without
--     this, "why did three drivers have this parcel?" is a question the record
--     cannot answer.
--   * `previousAssignmentId` - the chain, A to B to C, each link carrying the
--     reason it moved. A self-reference rather than an ordering recomputed
--     from timestamps, which becomes guesswork the moment two rows share a
--     millisecond.
--
-- Both nullable. Every assignment written before this migration keeps reading
-- exactly as it did.
--
-- THE BACK-FILL, AND THE ONE THING IT REPAIRS
--
-- The UNIQUE index cannot be created over data that already violates it, and
-- data that already violates it is precisely what the old code could produce.
-- So the first statement closes any DUPLICATE live assignment, keeping the
-- newest per consignment and recording why the others were closed.
--
-- It deletes nothing. A duplicate live assignment is a row that should already
-- have been closed, and closing it is what the missing constraint would have
-- forced at the time - the record of who held the parcel survives intact,
-- which is the whole point of unassigning rather than deleting.
--
-- The anti-join is a multi-table UPDATE rather than a subquery, because MariaDB
-- refuses a subquery in FROM that names the table being updated and has no
-- LATERAL to work round it with.
--
-- ALSO HERE
--
-- Two members appended to `LogisticsNotificationKind`. Appending to a MySQL
-- ENUM rewrites no row and invalidates no index; every existing value stays
-- exactly what it was.

-- ---------------------------------------------------------------------------
-- 1. Columns
-- ---------------------------------------------------------------------------

ALTER TABLE `logistics_driver_assignments`
    ADD COLUMN `activeShipmentId`     CHAR(26)     NULL AFTER `shipmentId`,
    ADD COLUMN `unassignedReason`     VARCHAR(512) NULL AFTER `unassignedAt`,
    ADD COLUMN `previousAssignmentId` CHAR(26)     NULL AFTER `unassignedReason`;

-- ---------------------------------------------------------------------------
-- 2. Repair: at most one live assignment per consignment
-- ---------------------------------------------------------------------------

UPDATE `logistics_driver_assignments` a
JOIN `logistics_driver_assignments` b
  ON  b.`shipmentId`   = a.`shipmentId`
  AND b.`unassignedAt` IS NULL
  AND (
        b.`assignedAt` > a.`assignedAt`
        OR (b.`assignedAt` = a.`assignedAt` AND b.`id` > a.`id`)
      )
SET a.`unassignedAt`     = CURRENT_TIMESTAMP(3),
    a.`unassignedReason` = 'Closed when one live driver per consignment became a database rule: a newer assignment already existed for this consignment.'
WHERE a.`unassignedAt` IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Back-fill the live marker
-- ---------------------------------------------------------------------------

UPDATE `logistics_driver_assignments`
SET `activeShipmentId` = `shipmentId`
WHERE `unassignedAt` IS NULL;

-- ---------------------------------------------------------------------------
-- 4. The constraint the whole migration exists for
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX `uq_logistics_driver_active`
    ON `logistics_driver_assignments` (`activeShipmentId`);

-- The admin tracking filter: every consignment one driver is carrying, newest
-- first. `ix_logistics_driver_task` leads on the driver too but carries
-- `unassignedAt` second, so it cannot serve a date-ordered list of a driver's
-- whole history.
CREATE INDEX `ix_logistics_driver_assignment_driver_time`
    ON `logistics_driver_assignments` (`driverProfileId`, `assignedAt`);

CREATE INDEX `ix_logistics_driver_assignment_previous`
    ON `logistics_driver_assignments` (`previousAssignmentId`);

ALTER TABLE `logistics_driver_assignments`
    ADD CONSTRAINT `logistics_driver_assignments_previousAssignmentId_fkey`
        FOREIGN KEY (`previousAssignmentId`) REFERENCES `logistics_driver_assignments`(`id`)
        ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. Two notification kinds
-- ---------------------------------------------------------------------------

ALTER TABLE `logistics_notifications`
    MODIFY `kind` ENUM(
        'SHIPMENT_ASSIGNED',
        'DRIVER_ASSIGNED',
        'DRIVER_REASSIGNED',
        'ASSIGNMENT_ACCEPTED',
        'ASSIGNMENT_REJECTED',
        'PICKUP_SCHEDULED',
        'PICKUP_COMPLETED',
        'SHIPMENT_DISPATCHED',
        'SHIPMENT_IN_TRANSIT',
        'OUT_FOR_DELIVERY',
        'SHIPMENT_DELIVERED',
        'DELIVERY_ATTEMPTED',
        'SHIPMENT_DELAYED',
        'EXCEPTION_RAISED',
        'SLA_AT_RISK',
        'SLA_BREACHED',
        'POD_AVAILABLE',
        'RETURN_INITIATED',
        'INTEGRATION_FAILURE',
        'USER_INVITED',
        'SECURITY_EVENT'
    ) NOT NULL;
