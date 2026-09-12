-- Packaging, pack ordering, price-on-request, and where a catalogue row came
-- from.
--
-- A supplier product sheet is the way most of this industry actually hands
-- over a catalogue, and three things in one make it impossible to load into
-- the schema as it stood:
--
--   1. It has no prices. Not "prices we have not typed yet" - a B2B range is
--      quoted per account, and the sheet is right not to carry one. The only
--      ways to list such an item today were to invent a number or to leave it
--      out, and both are worse than saying "ask us".
--
--   2. It sells in packs. "100Pcs x 20Box=2000Pcs" is the whole commercial
--      relationship: a hospital orders two cartons, not four thousand
--      syringes. Nothing in the schema could say what a carton was.
--
--   3. It carries the operator's own workflow - licence status, production
--      capacity, "Working on it" - mixed into the same rows as the product
--      facts a buyer is allowed to see.
--
-- FIVE DECISIONS WORTH STATING BEFORE THE SQL
--
--   1. Quantity stays pieces. `cart_items.quantity`, `order_items.quantity`
--      and `recurring_schedule_items.quantity` keep meaning exactly what they
--      meant yesterday, and every price, tax, reservation and stock path reads
--      them unchanged. The three new columns beside each are a record of what
--      the buyer chose, not a second way of counting. Had the quantity column
--      itself learned about packs, every one of those paths would have had to
--      learn too, and one of them would have been missed.
--
--   2. `piecesPerUnitSnapshot` is a snapshot for the same reason the name and
--      the price on `order_items` are. Packing gets corrected. "2 cartons"
--      has to keep meaning the 4,000 pieces it meant on the day it was agreed,
--      and that matters most on a schedule, where the charge happens months
--      later inside a worker with nobody watching.
--
--   3. The operator-internal columns go on their own table rather than on
--      `products`. The public product select is an allowlist, so they would
--      have been safe either way - but a separate table makes the boundary
--      structural instead of a rule somebody has to remember on every future
--      read, and there will be future reads.
--
--   4. `importFingerprint` is UNIQUE and NULLABLE, and both halves are
--      load-bearing. MariaDB treats every NULL in a UNIQUE index as distinct,
--      so every hand-made product can leave it empty while the index still
--      guarantees that re-importing a workbook updates the row it made last
--      time instead of creating a second one.
--
--   5. Every column added to an existing table is nullable or defaulted to the
--      behaviour that was already there - price-on-request off, orderable on,
--      counted in pieces - so an installation already running takes this
--      without a backfill it has to think about. The one backfill below is
--      arithmetic, not a decision.

-- ---------------------------------------------------------------------------
-- Products: a price that is deliberately not published, and a listing that is
-- readable without being buyable.
-- ---------------------------------------------------------------------------

ALTER TABLE `products`
  -- Relaxes exactly one publication rule, the price-above-zero check, and
  -- tightens one behaviour: nothing priced on request reaches a cart.
  ADD COLUMN `isPriceOnRequest` BOOLEAN NOT NULL DEFAULT false,
  -- Not the same axis as status/isPublished. Unpublishing hides a product
  -- completely and 404s its URL; this keeps the listing and its
  -- specifications readable while refusing every purchase path.
  ADD COLUMN `isOrderable` BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN `unavailabilityReason` VARCHAR(255) NULL,
  ADD COLUMN `importFingerprint` CHAR(64) NULL;

CREATE UNIQUE INDEX `uq_product_import_fingerprint` ON `products`(`importFingerprint`);

-- ---------------------------------------------------------------------------
-- Variants: the two identifiers that belong to the thing in the box.
--
-- A barcode belongs to the item, and two sizes of one product are two items in
-- two boxes with two barcodes. Reading them off the parent would hand a
-- scanner the wrong number for every variant but one.
-- ---------------------------------------------------------------------------

ALTER TABLE `product_variants`
  ADD COLUMN `gtin` VARCHAR(14) NULL,
  ADD COLUMN `modelIdentifier` VARCHAR(64) NULL,
  ADD COLUMN `importFingerprint` CHAR(64) NULL;

CREATE UNIQUE INDEX `uq_variant_import_fingerprint` ON `product_variants`(`importFingerprint`);

-- ---------------------------------------------------------------------------
-- What the buyer chose to count in.
--
-- Added to all three item tables at once, on purpose. A basket that remembers
-- cartons and an order that forgets them is worse than neither remembering:
-- the customer sees their own choice disappear at the moment they commit to it.
-- ---------------------------------------------------------------------------

ALTER TABLE `cart_items`
  ADD COLUMN `orderingUnit` ENUM('PIECE', 'INNER_PACK', 'OUTER_CARTON') NOT NULL DEFAULT 'PIECE',
  ADD COLUMN `unitQuantity` INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN `piecesPerUnitSnapshot` INTEGER NOT NULL DEFAULT 1;

ALTER TABLE `order_items`
  ADD COLUMN `orderingUnit` ENUM('PIECE', 'INNER_PACK', 'OUTER_CARTON') NOT NULL DEFAULT 'PIECE',
  ADD COLUMN `unitQuantity` INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN `piecesPerUnitSnapshot` INTEGER NOT NULL DEFAULT 1;

ALTER TABLE `recurring_schedule_items`
  ADD COLUMN `orderingUnit` ENUM('PIECE', 'INNER_PACK', 'OUTER_CARTON') NOT NULL DEFAULT 'PIECE',
  ADD COLUMN `unitQuantity` INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN `piecesPerUnitSnapshot` INTEGER NOT NULL DEFAULT 1;

-- Every row that already exists was counted in pieces, so its unit quantity is
-- its piece count. The column default of 1 is right for a new row and wrong
-- for an existing one, which is what this fixes - a line of five pieces would
-- otherwise read back as "1 piece" on every screen that shows the unit.
UPDATE `cart_items` SET `unitQuantity` = `quantity`;
UPDATE `order_items` SET `unitQuantity` = `quantity`;
UPDATE `recurring_schedule_items` SET `unitQuantity` = `quantity`;

-- ---------------------------------------------------------------------------
-- Packing: the figures, and the text they were read out of.
--
-- The raw text is NOT redundant with the numbers beside it. It is the only
-- thing that can settle an argument about what the supplier actually said, and
-- the parser's reading of a format nobody standardised is a best effort that
-- somebody will eventually need to check.
-- ---------------------------------------------------------------------------

CREATE TABLE `product_packaging` (
  `id` CHAR(26) NOT NULL,
  `productId` CHAR(26) NOT NULL,
  `variantId` CHAR(26) NULL,
  -- The variant ULID, or '' for the base product. Never NULL: a nullable
  -- column inside the UNIQUE below would let one SKU hold two packing rows,
  -- because MariaDB counts every NULL as distinct.
  `variantKey` VARCHAR(26) NOT NULL DEFAULT '',
  `packingType` VARCHAR(128) NULL,
  `packingRawText` VARCHAR(255) NULL,
  `piecesPerInnerPack` INTEGER NULL,
  `innerPacksPerOuterCarton` INTEGER NULL,
  `piecesPerOuterCarton` INTEGER NULL,
  `innerPackType` VARCHAR(64) NULL,
  `outerPackType` VARCHAR(64) NULL,
  -- PARTIAL is not a failure: a source that gives a total and no breakdown has
  -- been read correctly and completely.
  `parseStatus` ENUM('PARSED', 'PARTIAL', 'NEEDS_REVIEW', 'UNPARSED') NOT NULL DEFAULT 'UNPARSED',
  `validationMessage` VARCHAR(512) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `ix_product_packaging_variant`(`variantId`),
  UNIQUE INDEX `uq_product_packaging_sku`(`productId`, `variantKey`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `product_packaging`
  ADD CONSTRAINT `fk_product_packaging_product`
    FOREIGN KEY (`productId`) REFERENCES `products`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_product_packaging_variant`
    FOREIGN KEY (`variantId`) REFERENCES `product_variants`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `product_packaging`
  -- Quantities are counts of physical things. A zero or negative one is a
  -- parser bug reaching the database, and it would surface as a division by
  -- zero in the pack calculator rather than as anything a reader could
  -- diagnose. NULL stays legal throughout: "the source does not say" is the
  -- commonest honest answer here.
  ADD CONSTRAINT `chk_packaging_quantities_positive` CHECK (
    (`piecesPerInnerPack` IS NULL OR `piecesPerInnerPack` > 0)
    AND (`innerPacksPerOuterCarton` IS NULL OR `innerPacksPerOuterCarton` > 0)
    AND (`piecesPerOuterCarton` IS NULL OR `piecesPerOuterCarton` > 0)
  );

-- ---------------------------------------------------------------------------
-- Dimensions, kept as written.
--
-- `unit` is nullable and stays NULL unless the source actually named one.
-- Assuming millimetres onto a measurement given in inches is a twenty-five-fold
-- error in a field somebody sizes a shelf from.
-- ---------------------------------------------------------------------------

CREATE TABLE `product_pack_dimensions` (
  `id` CHAR(26) NOT NULL,
  `packagingId` CHAR(26) NOT NULL,
  `kind` ENUM('PRIMARY_PACK', 'INNER_BOX', 'OUTER_CARTON', 'STICKER_ARTWORK') NOT NULL,
  `rawText` VARCHAR(255) NOT NULL,
  `displayValue` VARCHAR(128) NULL,
  `unit` VARCHAR(16) NULL,
  `parseStatus` ENUM('PARSED', 'UNIT_UNKNOWN', 'UNPARSED') NOT NULL DEFAULT 'UNPARSED',

  UNIQUE INDEX `uq_pack_dimension_kind`(`packagingId`, `kind`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `product_pack_dimensions`
  ADD CONSTRAINT `fk_pack_dimension_packaging`
    FOREIGN KEY (`packagingId`) REFERENCES `product_packaging`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Provenance, and the operator's own columns.
--
-- `rawJson` holds the source row exactly as it was read, keyed by column
-- letter. It is what makes "the sheet said something else" a question with an
-- answer, and it costs a few hundred bytes a product to keep.
-- ---------------------------------------------------------------------------

CREATE TABLE `product_import_records` (
  `id` CHAR(26) NOT NULL,
  `productId` CHAR(26) NOT NULL,
  `variantId` CHAR(26) NULL,
  `variantKey` VARCHAR(26) NOT NULL DEFAULT '',
  `fingerprint` CHAR(64) NOT NULL,
  `sourceFileName` VARCHAR(255) NOT NULL,
  `sourceSheet` VARCHAR(128) NOT NULL,
  `sourceRow` INTEGER NOT NULL,
  `importedAt` DATETIME(3) NOT NULL,
  `rawJson` JSON NOT NULL,
  `productCode` VARCHAR(128) NULL,
  -- The barcode as written, application identifier and spacing intact:
  -- "(01) 0 8904379800013". A string, always. Held as a number it loses its
  -- leading zero and its formatting in one step, and no later reader can tell.
  `gtinRaw` VARCHAR(64) NULL,
  `gtinNormalised` VARCHAR(14) NULL,
  `genericName` VARCHAR(255) NULL,
  `modelSize` VARCHAR(128) NULL,
  `sterilisation` VARCHAR(128) NULL,
  `brand` VARCHAR(128) NULL,
  `packingType` VARCHAR(128) NULL,
  `shelfLife` VARCHAR(64) NULL,
  `productionCapacityPerMonth` VARCHAR(64) NULL,
  `launchDate` DATE NULL,
  `manufacturingLicenceStatus` VARCHAR(64) NULL,
  `testLicenceStatus` VARCHAR(64) NULL,
  -- Recorded as written. What it does to the listing was decided once, by the
  -- importer, and is expressed in `products.isOrderable`; nothing reads this
  -- string later to make a decision, so a new word appearing in the column
  -- cannot quietly change who is allowed to buy what.
  `internalStatus` VARCHAR(64) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,

  INDEX `ix_import_record_fingerprint`(`fingerprint`),
  INDEX `ix_import_record_source`(`sourceFileName`, `sourceRow`),
  UNIQUE INDEX `uq_import_record_sku`(`productId`, `variantKey`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `product_import_records`
  ADD CONSTRAINT `fk_import_record_product`
    FOREIGN KEY (`productId`) REFERENCES `products`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_import_record_variant`
    FOREIGN KEY (`variantId`) REFERENCES `product_variants`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
