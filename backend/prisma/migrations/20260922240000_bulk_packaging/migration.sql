-- Bulk ordering: carton, UK pallet, US pallet and shipping container.
--
-- WHAT A BUYER COULD DO BEFORE THIS
--
-- Order a number of base units from a seller, and nothing else. A hospital
-- group buying four pallets of gloves had to type 4,800 into a box meant for
-- singles, and the seller then worked out by hand whether that was a whole
-- number of pallets. Half of them were not, and a part pallet is not something
-- a warehouse can pick.
--
-- WHAT THIS ADDS
--
-- A seller states, PER VARIANT, how their goods are actually packed - what is
-- in a carton, how cartons sit on a pallet, how pallets fill a container - and
-- a buyer chooses one of those packages and a number of them.
--
-- THE ONE THING THAT DOES NOT CHANGE
--
-- `cart_items.quantity` and `order_items.quantity` are still BASE UNITS.
-- Every price, tax line, stock reservation, pick list, settlement and ERP push
-- reads that one number and has never had to know that pallets exist, and none
-- of them is touched here. Two pallets of 50 cartons of 24 stores 2,400, and
-- the pallet count lives beside it in the new snapshot tables.
--
-- That is why NOTHING ALREADY SOLD CHANGES. Every existing basket line, order
-- line and schedule line keeps its `orderingUnit`, its `unitQuantity` and its
-- `piecesPerUnitSnapshot` exactly as written. No row is updated by this
-- migration. An offer with no packaging profile - which is every offer that
-- exists today - continues to sell precisely as it did yesterday.
--
-- THE ENUM WIDENING
--
-- `OrderingUnit` gains CARTON, UK_PALLET, US_PALLET and CONTAINER. Widening a
-- MySQL ENUM by APPENDING members is metadata-only on MariaDB 10.4 and does
-- not rewrite the table; the existing three members keep their ordinal
-- positions, so no stored value changes meaning.
--
-- `OUTER_CARTON` is deliberately left alone and the seller's carton is a NEW
-- member. They are two different cartons: `OUTER_CARTON` is sized by this
-- deployment's `PIECES_PER_CARTON` or the product's own `piecesPerCarton`, and
-- the storefront reads that figure off `/config` to draw a price. A seller's
-- carton is sized by the seller, per variant. Folding them together would put
-- the operator's multiplication on a seller's line, which is the
-- five-hundred-fold pricing error this schema has already been through once.
--
-- ROLLING BACK
--
--   DROP TABLE `seller_packaging_tiers`;
--   DROP TABLE `cart_item_packaging`;
--   DROP TABLE `order_item_packaging`;
--   DROP TABLE `seller_packaging_options`;
--   DROP TABLE `seller_packaging_profiles`;
--   DROP TABLE `seller_freight_quote_requests`;
--
-- and then narrow the four enums back, which is safe ONLY after checking that
-- no row uses a new member:
--
--   SELECT COUNT(*) FROM `cart_items`
--    WHERE `orderingUnit` IN ('CARTON','UK_PALLET','US_PALLET','CONTAINER');
--
-- repeated for `order_items`, `recurring_schedule_items` and `seller_offers`.
-- A non-zero count means live data would be destroyed; narrowing the enum
-- would silently coerce those rows to '' on 10.4. Do not narrow until they
-- are gone.

-- ---------------------------------------------------------------------------
-- 1. The enum, on all four tables that carry it
-- ---------------------------------------------------------------------------

ALTER TABLE `cart_items`
  MODIFY `orderingUnit` ENUM(
    'PIECE', 'INNER_PACK', 'OUTER_CARTON',
    'CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER'
  ) NOT NULL DEFAULT 'PIECE';

ALTER TABLE `order_items`
  MODIFY `orderingUnit` ENUM(
    'PIECE', 'INNER_PACK', 'OUTER_CARTON',
    'CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER'
  ) NOT NULL DEFAULT 'PIECE';

ALTER TABLE `recurring_schedule_items`
  MODIFY `orderingUnit` ENUM(
    'PIECE', 'INNER_PACK', 'OUTER_CARTON',
    'CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER'
  ) NOT NULL DEFAULT 'PIECE';

ALTER TABLE `seller_offers`
  MODIFY `orderingUnit` ENUM(
    'PIECE', 'INNER_PACK', 'OUTER_CARTON',
    'CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER'
  ) NOT NULL DEFAULT 'PIECE';

-- ---------------------------------------------------------------------------
-- 2. The seller's packaging configuration
-- ---------------------------------------------------------------------------

CREATE TABLE `seller_packaging_profiles` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `offerId` CHAR(26) NOT NULL,
    `baseUnitLabel` VARCHAR(48) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `notes` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_seller_packaging_profile_offer`(`offerId`),
    INDEX `ix_packaging_profile_seller`(`sellerAccountId`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `seller_packaging_options` (
    `id` CHAR(26) NOT NULL,
    `profileId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `packageType` ENUM('CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER') NOT NULL,
    `isEnabled` BOOLEAN NOT NULL DEFAULT false,
    `state` ENUM('DRAFT', 'INCOMPLETE', 'ACTIVE', 'DISABLED') NOT NULL DEFAULT 'DRAFT',
    `validationMessage` VARCHAR(512) NULL,
    `packageSku` VARCHAR(64) NULL,
    `unitsPerCarton` INTEGER NULL,
    `unitsPerPackage` INTEGER NULL,
    `unitsPerPackageDerived` INTEGER NULL,
    `unitsPerPackageIsOverride` BOOLEAN NOT NULL DEFAULT false,
    `palletStandard` ENUM('UK_1200_1000', 'US_1219_1016') NULL,
    `cartonsPerLayer` INTEGER NULL,
    `layerCount` INTEGER NULL,
    `cartonsPerPallet` INTEGER NULL,
    `loadedHeightMm` INTEGER NULL,
    `isStackable` BOOLEAN NOT NULL DEFAULT false,
    `maxStackCount` INTEGER NULL,
    `containerType` ENUM('DRY_20GP', 'DRY_40GP', 'HIGH_CUBE_40HC', 'CUSTOM') NULL,
    `containerLoadMode` ENUM('FCL', 'LCL') NULL,
    `containerLoadingMethod` ENUM('PALLET_LOADED', 'CARTON_LOADED', 'CUSTOM') NULL,
    `palletsPerContainer` INTEGER NULL,
    `cartonsPerContainer` INTEGER NULL,
    `originPortLabel` VARCHAR(160) NULL,
    `incoterm` VARCHAR(8) NULL,
    `lengthMm` INTEGER NULL,
    `widthMm` INTEGER NULL,
    `heightMm` INTEGER NULL,
    `enteredDimensionUnit` ENUM('MM', 'CM', 'M', 'IN') NOT NULL DEFAULT 'MM',
    `netWeightGrams` BIGINT NULL,
    `grossWeightGrams` BIGINT NULL,
    `enteredWeightUnit` ENUM('G', 'KG', 'LB') NOT NULL DEFAULT 'G',
    `maxGrossWeightGrams` BIGINT NULL,
    `cargoVolumeCm3` BIGINT NULL,
    `minimumPackages` INTEGER NOT NULL DEFAULT 1,
    `packageIncrement` INTEGER NOT NULL DEFAULT 1,
    `maximumPackages` INTEGER NULL,
    `priceMode` ENUM('PER_PACKAGE', 'DERIVED_FROM_UNIT', 'FREIGHT_QUOTE') NOT NULL DEFAULT 'DERIVED_FROM_UNIT',
    `pricePerPackageMinor` BIGINT NULL,
    `currency` CHAR(3) NULL,
    `handlingLeadTimeDays` INTEGER NULL,
    `productionLeadTimeDays` INTEGER NULL,
    `originLocationId` CHAR(26) NULL,
    `isHazardous` BOOLEAN NOT NULL DEFAULT false,
    `temperatureNotes` VARCHAR(500) NULL,
    `specialHandlingNotes` VARCHAR(1000) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_packaging_option_type`(`profileId`, `packageType`),
    INDEX `ix_packaging_option_seller`(`sellerAccountId`, `packageType`, `state`),
    INDEX `ix_packaging_option_buyable`(`state`, `isEnabled`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `seller_packaging_tiers` (
    `id` CHAR(26) NOT NULL,
    `optionId` CHAR(26) NOT NULL,
    `minPackages` INTEGER NOT NULL,
    `pricePerPackageMinor` BIGINT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_packaging_tier_band`(`optionId`, `minPackages`),
    INDEX `ix_packaging_tier_band`(`optionId`, `minPackages`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. The snapshots
--
-- One row per basket line and per order line that was bought in a package.
-- Absent on every other line, which is every line that exists today.
-- ---------------------------------------------------------------------------

CREATE TABLE `cart_item_packaging` (
    `id` CHAR(26) NOT NULL,
    `cartItemId` CHAR(26) NOT NULL,
    `packageType` ENUM('CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER') NOT NULL,
    `palletStandard` ENUM('UK_1200_1000', 'US_1219_1016') NULL,
    `containerType` ENUM('DRY_20GP', 'DRY_40GP', 'HIGH_CUBE_40HC', 'CUSTOM') NULL,
    `containerLoadMode` ENUM('FCL', 'LCL') NULL,
    `containerLoadingMethod` ENUM('PALLET_LOADED', 'CARTON_LOADED', 'CUSTOM') NULL,
    `packageQuantity` INTEGER NOT NULL,
    `unitsPerPackage` INTEGER NOT NULL,
    `totalBaseUnits` INTEGER NOT NULL,
    `unitsPerCarton` INTEGER NULL,
    `cartonsPerPallet` INTEGER NULL,
    `palletsPerContainer` INTEGER NULL,
    `cartonsPerContainer` INTEGER NULL,
    `lengthMm` INTEGER NULL,
    `widthMm` INTEGER NULL,
    `heightMm` INTEGER NULL,
    `grossWeightGrams` BIGINT NULL,
    `cargoVolumeCm3` BIGINT NULL,
    `packagePriceMinor` BIGINT NOT NULL,
    `unitPriceMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `appliedTierMinPackages` INTEGER NULL,
    `profileVersion` INTEGER NOT NULL,
    `snapshotAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `requiresFreightQuote` BOOLEAN NOT NULL DEFAULT false,

    UNIQUE INDEX `uq_cart_item_packaging`(`cartItemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `order_item_packaging` (
    `id` CHAR(26) NOT NULL,
    `orderItemId` CHAR(26) NOT NULL,
    `packageType` ENUM('CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER') NOT NULL,
    `palletStandard` ENUM('UK_1200_1000', 'US_1219_1016') NULL,
    `containerType` ENUM('DRY_20GP', 'DRY_40GP', 'HIGH_CUBE_40HC', 'CUSTOM') NULL,
    `containerLoadMode` ENUM('FCL', 'LCL') NULL,
    `containerLoadingMethod` ENUM('PALLET_LOADED', 'CARTON_LOADED', 'CUSTOM') NULL,
    `packageQuantity` INTEGER NOT NULL,
    `unitsPerPackage` INTEGER NOT NULL,
    `totalBaseUnits` INTEGER NOT NULL,
    `unitsPerCarton` INTEGER NULL,
    `cartonsPerPallet` INTEGER NULL,
    `palletsPerContainer` INTEGER NULL,
    `cartonsPerContainer` INTEGER NULL,
    `lengthMm` INTEGER NULL,
    `widthMm` INTEGER NULL,
    `heightMm` INTEGER NULL,
    `grossWeightGrams` BIGINT NULL,
    `cargoVolumeCm3` BIGINT NULL,
    `packagePriceMinor` BIGINT NOT NULL,
    `unitPriceMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `appliedTierMinPackages` INTEGER NULL,
    `profileVersion` INTEGER NOT NULL,
    `snapshotAt` DATETIME(3) NOT NULL,
    `requiresFreightQuote` BOOLEAN NOT NULL DEFAULT false,
    `packageSkuSnapshot` VARCHAR(64) NULL,
    `incotermSnapshot` VARCHAR(8) NULL,
    `originPortLabelSnapshot` VARCHAR(160) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_order_item_packaging`(`orderItemId`),
    INDEX `ix_order_item_packaging_type`(`packageType`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4. Freight for loads a parcel carrier cannot take
-- ---------------------------------------------------------------------------

CREATE TABLE `seller_freight_quote_requests` (
    `id` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `cartId` CHAR(26) NULL,
    `orderId` CHAR(26) NULL,
    `sellerOrderGroupId` CHAR(26) NULL,
    `state` ENUM('REQUESTED', 'QUOTED', 'ACCEPTED', 'DECLINED', 'EXPIRED', 'CANCELLED') NOT NULL DEFAULT 'REQUESTED',
    `loadType` ENUM('PARCEL', 'CARTON', 'PALLET', 'FCL', 'LCL') NOT NULL,
    `totalPackages` INTEGER NOT NULL,
    `totalBaseUnits` INTEGER NOT NULL,
    `totalCartons` INTEGER NULL,
    `totalPallets` INTEGER NULL,
    `totalContainers` INTEGER NULL,
    `grossWeightGrams` BIGINT NULL,
    `volumeCm3` BIGINT NULL,
    `originCountry` CHAR(2) NULL,
    `destinationCountry` CHAR(2) NULL,
    `originPortLabel` VARCHAR(160) NULL,
    `incoterm` VARCHAR(8) NULL,
    `isHazardous` BOOLEAN NOT NULL DEFAULT false,
    `requiresColdChain` BOOLEAN NOT NULL DEFAULT false,
    `linesJson` JSON NULL,
    `logisticsPartnerId` CHAR(26) NULL,
    `quotedAmountMinor` BIGINT NULL,
    `quotedCurrency` CHAR(3) NULL,
    `serviceName` VARCHAR(160) NULL,
    `carrierReference` VARCHAR(120) NULL,
    `trackingReference` VARCHAR(120) NULL,
    `expectedPickupAt` DATETIME(3) NULL,
    `expectedDeliveryAt` DATETIME(3) NULL,
    `quoteExpiresAt` DATETIME(3) NULL,
    `responseNote` VARCHAR(1000) NULL,
    `requestedByProfileId` CHAR(26) NULL,
    `quotedByUserId` CHAR(26) NULL,
    `quotedAt` DATETIME(3) NULL,
    `decidedAt` DATETIME(3) NULL,
    `correlationId` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_freight_quote_seller_state`(`sellerAccountId`, `state`, `createdAt`),
    INDEX `ix_freight_quote_order`(`orderId`),
    INDEX `ix_freight_quote_cart`(`cartId`),
    INDEX `ix_freight_quote_sweep`(`state`, `quoteExpiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 5. Foreign keys
--
-- The snapshots CASCADE from the line they describe: a basket line deleted
-- takes its breakdown with it, and an order line is never deleted, so the
-- order snapshot is in practice permanent.
--
-- `originLocationId` on an option and every reference on a freight request are
-- deliberately NOT foreign keys - see the columns' own notes in the schema.
-- ---------------------------------------------------------------------------

ALTER TABLE `seller_packaging_profiles`
  ADD CONSTRAINT `fk_packaging_profile_seller`
    FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_packaging_profile_offer`
    FOREIGN KEY (`offerId`) REFERENCES `seller_offers`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_packaging_options`
  ADD CONSTRAINT `fk_packaging_option_profile`
    FOREIGN KEY (`profileId`) REFERENCES `seller_packaging_profiles`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_packaging_tiers`
  ADD CONSTRAINT `fk_packaging_tier_option`
    FOREIGN KEY (`optionId`) REFERENCES `seller_packaging_options`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `cart_item_packaging`
  ADD CONSTRAINT `fk_cart_item_packaging_item`
    FOREIGN KEY (`cartItemId`) REFERENCES `cart_items`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `order_item_packaging`
  ADD CONSTRAINT `fk_order_item_packaging_item`
    FOREIGN KEY (`orderItemId`) REFERENCES `order_items`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `seller_freight_quote_requests`
  ADD CONSTRAINT `fk_freight_quote_seller`
    FOREIGN KEY (`sellerAccountId`) REFERENCES `seller_accounts`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 6. CHECK constraints
--
-- MariaDB 10.4 does enforce CHECK - verified, and this schema relies on it
-- elsewhere. These are the invariants an application bug would otherwise write
-- silently, and every one of them is a figure somebody would be charged for.
-- ---------------------------------------------------------------------------

ALTER TABLE `seller_packaging_options`
  ADD CONSTRAINT `chk_packaging_option_counts` CHECK (
    (`unitsPerCarton`   IS NULL OR `unitsPerCarton`   > 0) AND
    (`unitsPerPackage`  IS NULL OR `unitsPerPackage`  > 0) AND
    (`cartonsPerLayer`  IS NULL OR `cartonsPerLayer`  > 0) AND
    (`layerCount`       IS NULL OR `layerCount`       > 0) AND
    (`cartonsPerPallet` IS NULL OR `cartonsPerPallet` > 0) AND
    (`palletsPerContainer` IS NULL OR `palletsPerContainer` > 0) AND
    (`cartonsPerContainer` IS NULL OR `cartonsPerContainer` > 0) AND
    `minimumPackages` > 0 AND
    `packageIncrement` > 0 AND
    (`maximumPackages` IS NULL OR `maximumPackages` >= `minimumPackages`)
  ),
  ADD CONSTRAINT `chk_packaging_option_price` CHECK (
    (`pricePerPackageMinor` IS NULL OR `pricePerPackageMinor` >= 0) AND
    (`priceMode` <> 'PER_PACKAGE' OR `pricePerPackageMinor` IS NOT NULL)
  ),
  ADD CONSTRAINT `chk_packaging_option_weight` CHECK (
    (`netWeightGrams`   IS NULL OR `netWeightGrams`   >= 0) AND
    (`grossWeightGrams` IS NULL OR `grossWeightGrams` >= 0) AND
    (`maxGrossWeightGrams` IS NULL OR `maxGrossWeightGrams` > 0) AND
    (`netWeightGrams` IS NULL OR `grossWeightGrams` IS NULL
       OR `grossWeightGrams` >= `netWeightGrams`)
  );

ALTER TABLE `seller_packaging_tiers`
  ADD CONSTRAINT `chk_packaging_tier` CHECK (
    `minPackages` > 0 AND `pricePerPackageMinor` >= 0
  );

-- The snapshot must add up. This is the one invariant that, broken, silently
-- charges somebody for a quantity they did not order - and it is exactly the
-- kind of thing a refactor breaks without any test noticing.
ALTER TABLE `cart_item_packaging`
  ADD CONSTRAINT `chk_cart_packaging_total` CHECK (
    `packageQuantity` > 0 AND `unitsPerPackage` > 0 AND
    `totalBaseUnits` = `packageQuantity` * `unitsPerPackage`
  );

ALTER TABLE `order_item_packaging`
  ADD CONSTRAINT `chk_order_packaging_total` CHECK (
    `packageQuantity` > 0 AND `unitsPerPackage` > 0 AND
    `totalBaseUnits` = `packageQuantity` * `unitsPerPackage`
  );

ALTER TABLE `seller_freight_quote_requests`
  ADD CONSTRAINT `chk_freight_quote_amounts` CHECK (
    `totalPackages` > 0 AND `totalBaseUnits` > 0 AND
    (`quotedAmountMinor` IS NULL OR `quotedAmountMinor` >= 0) AND
    (`state` <> 'QUOTED' OR (`quotedAmountMinor` IS NOT NULL AND `quotedCurrency` IS NOT NULL))
  );
