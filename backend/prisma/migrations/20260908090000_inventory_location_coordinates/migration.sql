-- Where each warehouse is.
--
-- The console has always known that stock sits at a location - every balance,
-- movement and reservation carries a `locationId` - and has never known where
-- that location is. `addressJson` is free-form text a person wrote for another
-- person to read; it cannot be drawn, measured or sorted by distance.
--
-- DECIMAL(9,6) rather than DOUBLE, and for the same reason money is BIGINT in
-- this schema: a stored fact must read back exactly as it was written. Six
-- decimal places is roughly 11cm, which is finer than a postal address
-- resolves to, and the 9 total digits hold both axes in full - latitude needs
-- 2 integer digits and longitude 3, so the wider axis fits with a digit to
-- spare.
--
-- Additive and NULL-able, and NULL is an ordinary state rather than a missing
-- value. Every warehouse in a deployment that is already running predates this
-- column, and a warehouse whose address nobody has geocoded yet still holds
-- stock. The map lists those separately rather than dropping them, so nothing
-- disappears from a screen because of a column that was added later.
--
-- No index. There is one row per warehouse - a handful, not a table that grows
-- with trade - so every query here is a full scan of a few rows, and a spatial
-- index would cost writes to buy nothing. MariaDB 10.4 has SPATIAL indexes but
-- only on POINT columns, which would trade this readable pair for a geometry
-- blob no other query in the system wants.

-- AlterTable
ALTER TABLE `inventory_locations`
    ADD COLUMN `latitude`  DECIMAL(9, 6) NULL AFTER `isActive`,
    ADD COLUMN `longitude` DECIMAL(9, 6) NULL AFTER `latitude`;

-- The invariants, in the same spirit as 20260902143000_add_check_constraints:
-- the service enforces all three, and these are what stops a manual SQL fix or
-- a future import script leaving a warehouse in a state the map cannot draw.
--
-- The third one is the one worth spelling out. A latitude with no longitude is
-- not a partly-known position, it is an unusable one - it names a line around
-- the planet. Either both axes are known or neither is, and "neither" is what
-- puts the row in the unplaced list where somebody will notice it.
ALTER TABLE `inventory_locations`
  ADD CONSTRAINT `chk_location_latitude_range` CHECK (`latitude` IS NULL OR (`latitude` >= -90 AND `latitude` <= 90)),
  ADD CONSTRAINT `chk_location_longitude_range` CHECK (`longitude` IS NULL OR (`longitude` >= -180 AND `longitude` <= 180)),
  ADD CONSTRAINT `chk_location_coordinates_paired` CHECK ((`latitude` IS NULL) = (`longitude` IS NULL));
