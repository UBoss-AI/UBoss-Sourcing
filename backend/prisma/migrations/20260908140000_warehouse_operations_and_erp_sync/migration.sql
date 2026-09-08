-- What a warehouse is, beyond a name and a pair of coordinates.
--
-- Five facts the map and the warehouse screen need, and one of them is a
-- distinction worth stating before the SQL:
--
--   `isActive` and `operationalStatus` are NOT the same axis, and the whole
--   point of adding the second is that the first was being asked to carry two
--   meanings. `isActive` answers "is this place part of the business at all" -
--   retiring one archives it and takes it out of every stock picker.
--   `operationalStatus` answers "of the places that are, can this one move a
--   box today". A warehouse closed for a roof repair is thoroughly active and
--   cannot ship a thing, and until now there was nowhere to record that.
--
-- `countryCode` comes out of `addressJson` and becomes a real column with a
-- foreign key, because it is asked questions JSON cannot answer: the console
-- filters and searches on it, and `countries` is the table that already
-- decides a country's currency, its interface language and whether it is
-- inside the EU VAT area. A warehouse in a country the deployment has never
-- heard of is a typo, and the FK is what catches it. It is backfilled from the
-- JSON below so nothing that was already recorded is lost.
--
-- `timezone` is stored rather than derived from the country, because the
-- country does not determine it: Spain spans two zones, and any deployment
-- with a warehouse in Madrid and one in the Canaries needs them to disagree.
-- Same reasoning as `recurring_schedules.timezone`.
--
-- The ERP columns are a per-warehouse view of the sync, which is not what
-- `sync_runs` records. One ERP connection syncs many warehouses; "when did
-- Antwerp last agree with the ERP" is the question somebody standing in
-- Antwerp asks, and the run history answers a different one. `erpExternalId`
-- is master data a person enters; the other three are written only by the
-- connector, through PUT /admin/inventory/warehouses/:id/erp-status.
--
-- Every column is additive and nullable or defaulted, so an installation that
-- is already running takes this migration without a backfill it has to think
-- about.

-- AlterTable
ALTER TABLE `inventory_locations`
    ADD COLUMN `countryCode`       CHAR(2)      NULL AFTER `addressJson`,
    ADD COLUMN `timezone`          VARCHAR(64)  NULL AFTER `countryCode`,
    ADD COLUMN `operationalStatus` ENUM('OPERATIONAL', 'LIMITED', 'MAINTENANCE', 'SUSPENDED') NOT NULL DEFAULT 'OPERATIONAL' AFTER `longitude`,
    ADD COLUMN `erpExternalId`     VARCHAR(64)  NULL AFTER `operationalStatus`,
    ADD COLUMN `erpSyncStatus`     ENUM('NEVER_SYNCED', 'SYNCED', 'PENDING', 'FAILED') NOT NULL DEFAULT 'NEVER_SYNCED' AFTER `erpExternalId`,
    ADD COLUMN `erpLastSyncAt`     DATETIME(3)  NULL AFTER `erpSyncStatus`,
    ADD COLUMN `erpSyncMessage`    VARCHAR(512) NULL AFTER `erpLastSyncAt`;

-- Lift the country out of the address JSON, for the rows that had one.
--
-- Both spellings are read: `countryCode` is what the admin panel's warehouse
-- form wrote, and `country` is what `addresses` and the order snapshots call
-- the same field, so an installation that populated this column by hand or by
-- import is likely to have used it. Anything that is not two letters is left
-- NULL rather than guessed at - the FK below would reject it anyway, and a
-- country invented by a migration is worse than a country nobody set.
UPDATE `inventory_locations`
   SET `countryCode` = UPPER(JSON_UNQUOTE(JSON_EXTRACT(`addressJson`, '$.countryCode')))
 WHERE `addressJson` IS NOT NULL
   AND JSON_UNQUOTE(JSON_EXTRACT(`addressJson`, '$.countryCode')) REGEXP '^[A-Za-z]{2}$';

UPDATE `inventory_locations`
   SET `countryCode` = UPPER(JSON_UNQUOTE(JSON_EXTRACT(`addressJson`, '$.country')))
 WHERE `countryCode` IS NULL
   AND `addressJson` IS NOT NULL
   AND JSON_UNQUOTE(JSON_EXTRACT(`addressJson`, '$.country')) REGEXP '^[A-Za-z]{2}$';

-- A backfilled code that names a country this deployment does not carry would
-- make the FK below fail to create, taking the whole migration with it. Drop
-- those back to NULL: the warehouse still works, and somebody can set the
-- country in the panel once the country exists in the reference table.
UPDATE `inventory_locations` l
  LEFT JOIN `countries` c ON c.`code` = l.`countryCode`
   SET l.`countryCode` = NULL
 WHERE l.`countryCode` IS NOT NULL
   AND c.`code` IS NULL;

-- CreateIndex
CREATE INDEX `ix_inventory_location_active_country` ON `inventory_locations`(`isActive`, `countryCode`);
CREATE INDEX `ix_inventory_location_operational` ON `inventory_locations`(`operationalStatus`);

-- AddForeignKey
--
-- RESTRICT rather than SET NULL: a country with a warehouse in it is a country
-- the deployment is trading from, and deleting the reference row should be
-- refused rather than quietly unplacing the building.
ALTER TABLE `inventory_locations`
    ADD CONSTRAINT `inventory_locations_countryCode_fkey`
    FOREIGN KEY (`countryCode`) REFERENCES `countries`(`code`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- The invariants, in the same spirit as 20260902143000_add_check_constraints.
--
-- A timezone is stored as an IANA name and this cannot check that it is a real
-- one - MariaDB has no zone table to join against unless one has been loaded.
-- What it can insist on is the shape, which is what catches the two things
-- that actually get typed into this field: a UTC offset ("+01:00") and a
-- Windows zone name ("W. Europe Standard Time"). Neither is an IANA zone, and
-- neither would work in `Intl.DateTimeFormat`.
ALTER TABLE `inventory_locations`
  ADD CONSTRAINT `chk_location_timezone_shape` CHECK (
    `timezone` IS NULL OR `timezone` REGEXP '^[A-Za-z][A-Za-z0-9+_-]*(/[A-Za-z0-9+_-]+)+$'
  );
