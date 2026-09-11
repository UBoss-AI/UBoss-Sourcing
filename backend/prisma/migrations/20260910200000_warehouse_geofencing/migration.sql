-- Geofencing: how far a warehouse reaches, and where it refuses to go.
--
-- Until now "which countries can this warehouse deliver to" was answered from
-- one deployment-wide setting, DELIVERY_COVERAGE_RADIUS_KM, and answered for
-- nobody but the admin panel's map. This migration turns it into a stored fact
-- per building, and adds the two things a buyer actually chooses between.
--
-- FOUR DECISIONS WORTH STATING BEFORE THE SQL
--
--   1. `deliveryRadiusKm` is NULL by default, and NULL is not zero. It means
--      "use the deployment's default radius". Every warehouse that exists when
--      this migration runs keeps behaving exactly as it did, and an operator
--      who wants to raise the promise everywhere still changes one setting -
--      the column is the override, not the source of truth for the ones that
--      have not been overridden.
--
--   2. The exclusion table has NO foreign key to `countries`, and that is the
--      whole reason it is a table of its own rather than a column. `countries`
--      is the list of markets this deployment *prices in* - a few dozen rows,
--      each needing a currency behind it. The radius is measured against the
--      whole world, all two hundred and forty-odd shapes in Natural Earth. An
--      operator has to be able to close a country the circle reaches whether
--      or not they sell there, and an FK would make precisely the countries
--      they most want to shut the ones they cannot name. The code's shape is
--      checked here and its existence is checked against the ISO list in
--      `location.service.ts`.
--
--   3. Reachable and offered are two different questions, kept in two
--      different places. The radius decides what geometry can reach; the
--      exclusions decide what the business will serve. Collapsing them would
--      mean that raising a radius from 500 to 800 next year silently re-opened
--      a country somebody deliberately closed, which is the kind of quiet
--      change that ends up on an invoice nobody can explain.
--
--   4. The fee is BigInt minor units with its own currency column, like every
--      other amount in this schema. A delivery fee is money, and money here is
--      never a float and never carries an implied currency.
--
-- Every column is additive and nullable, so an installation already running
-- takes this without a backfill it has to think about.

-- AlterTable
ALTER TABLE `inventory_locations`
    ADD COLUMN `deliveryRadiusKm`        INT     NULL AFTER `longitude`,
    ADD COLUMN `deliveryLeadTimeMinDays` INT     NULL AFTER `deliveryRadiusKm`,
    ADD COLUMN `deliveryLeadTimeMaxDays` INT     NULL AFTER `deliveryLeadTimeMinDays`,
    ADD COLUMN `deliveryFeeMinor`        BIGINT  NULL AFTER `deliveryLeadTimeMaxDays`,
    ADD COLUMN `deliveryFeeCurrency`     CHAR(3) NULL AFTER `deliveryFeeMinor`;

-- CreateTable
--
-- ON DELETE CASCADE, unlike every other table that points at a warehouse.
--
-- The four existing ones - balances, movements, reservations, schedules - are
-- RESTRICT because they are history: deleting a warehouse would orphan the
-- ledger that explains where stock went, so the panel refuses and offers to
-- retire instead. An exclusion is not history. It is a line of configuration
-- that only means anything while the warehouse it belongs to exists, and
-- keeping it after the row is gone would be the only thing standing between an
-- operator and deleting a warehouse they created by mistake.
CREATE TABLE `warehouse_country_exclusions` (
    `id`          CHAR(26)     NOT NULL,
    `locationId`  CHAR(26)     NOT NULL,
    `countryCode` CHAR(2)      NOT NULL,
    `reason`      VARCHAR(256) NULL,
    `createdAt`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_warehouse_exclusion_country`(`locationId`, `countryCode`),
    INDEX `ix_warehouse_exclusion_country`(`countryCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `warehouse_country_exclusions`
    ADD CONSTRAINT `warehouse_country_exclusions_locationId_fkey`
    FOREIGN KEY (`locationId`) REFERENCES `inventory_locations`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The invariants, in the same spirit as 20260902143000_add_check_constraints.
--
-- The API checks all of these and puts the message on the field somebody
-- typed in, which is the half a constraint cannot do. These exist for the
-- other half: an import, a hand-written UPDATE, and a future caller that
-- forgets. A radius of zero is the one worth naming - it would silently mean
-- "this warehouse delivers nowhere", which is what retiring a warehouse is
-- for, and nobody types a zero radius on purpose.
ALTER TABLE `inventory_locations`
  ADD CONSTRAINT `chk_location_delivery_radius` CHECK (
    `deliveryRadiusKm` IS NULL OR (`deliveryRadiusKm` >= 1 AND `deliveryRadiusKm` <= 20000)
  ),
  -- Both days or neither. Half a range is not partial knowledge: a minimum
  -- with no maximum is a promise with no end, and the storefront would have
  -- nothing to print after the dash.
  ADD CONSTRAINT `chk_location_lead_time_pair` CHECK (
    (`deliveryLeadTimeMinDays` IS NULL AND `deliveryLeadTimeMaxDays` IS NULL)
    OR (`deliveryLeadTimeMinDays` IS NOT NULL AND `deliveryLeadTimeMaxDays` IS NOT NULL)
  ),
  ADD CONSTRAINT `chk_location_lead_time_order` CHECK (
    `deliveryLeadTimeMinDays` IS NULL
    OR (`deliveryLeadTimeMinDays` >= 0
        AND `deliveryLeadTimeMaxDays` <= 365
        AND `deliveryLeadTimeMinDays` <= `deliveryLeadTimeMaxDays`)
  ),
  -- An amount with no currency on it is the one shape of money this schema
  -- never allows. Zero is a legitimate fee - "we deliver here for nothing" -
  -- so it is the NULL pairing that is constrained, not the value.
  ADD CONSTRAINT `chk_location_delivery_fee_pair` CHECK (
    (`deliveryFeeMinor` IS NULL AND `deliveryFeeCurrency` IS NULL)
    OR (`deliveryFeeMinor` IS NOT NULL AND `deliveryFeeCurrency` IS NOT NULL)
  ),
  ADD CONSTRAINT `chk_location_delivery_fee_sign` CHECK (
    `deliveryFeeMinor` IS NULL OR `deliveryFeeMinor` >= 0
  );

-- Two letters, upper case. The shape is all a constraint can check without an
-- FK, and it is what catches the two things that actually get written into a
-- country column by hand: a three-letter alpha-3 ("DEU") and a lower-case
-- pair.
ALTER TABLE `warehouse_country_exclusions`
  ADD CONSTRAINT `chk_warehouse_exclusion_country_shape` CHECK (
    `countryCode` REGEXP '^[A-Z]{2}$'
  );
