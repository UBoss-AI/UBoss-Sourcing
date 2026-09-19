-- Product variants become a system rather than a list.
--
-- Until now a variant was a name, a SKU, a price and a bag of free-text
-- options. That is enough for a medical catalogue where a buyer picks several
-- sizes at once off a list, and not enough for a shoe, where the buyer narrows
-- along colour and size and has to be stopped from choosing a combination
-- nobody stocks.
--
-- Everything here is additive and every new column is nullable or defaulted, so
-- a deployment that upgrades and changes nothing else behaves exactly as it did
-- the day before. The one constraint added - the unique index on
-- (productId, optionSignature) - is applied only AFTER the backfill below has
-- given every existing row a signature, because a unique index applied to
-- unnormalised data fails on the first duplicate and takes the upgrade with it.
--
-- ROLLING BACK
--
--   ALTER TABLE `product_variants` DROP INDEX `uq_variant_option_signature`;
--   DROP TABLE `product_variant_media`;
--   ALTER TABLE `product_variants`
--       DROP COLUMN `optionSignature`, DROP COLUMN `compareAtPriceMinor`,
--       DROP COLUMN `minOrderQty`, DROP COLUMN `qtyIncrement`,
--       DROP COLUMN `maxOrderQty`, DROP COLUMN `leadTimeDays`,
--       DROP COLUMN `multipackCount`, DROP COLUMN `netContentValue`,
--       DROP COLUMN `netContentUnit`, DROP COLUMN `unitPricingBaseValue`,
--       DROP COLUMN `unitPricingBaseUnit`, DROP COLUMN `manufacturerPackLabel`,
--       DROP COLUMN `shippingWeightGrams`, DROP COLUMN `shippingLengthMm`,
--       DROP COLUMN `shippingWidthMm`, DROP COLUMN `shippingHeightMm`,
--       DROP COLUMN `shippingClass`;
--   ALTER TABLE `products` DROP COLUMN `variantAxesJson`;
--
-- Nothing above loses data a previous version could read: every column dropped
-- is one only this version writes.

-- ---------------------------------------------------------------------------
-- 1. The product family declares which axes it sells along.
-- ---------------------------------------------------------------------------

ALTER TABLE `products`
    ADD COLUMN `variantAxesJson` JSON NULL AFTER `hasVariants`;

-- ---------------------------------------------------------------------------
-- 2. Variant identity, terms of trade, pack make-up and shipping.
-- ---------------------------------------------------------------------------

ALTER TABLE `product_variants`
    ADD COLUMN `optionSignature`       VARCHAR(512)   NOT NULL DEFAULT '' AFTER `optionsJson`,
    ADD COLUMN `compareAtPriceMinor`   BIGINT         NULL     AFTER `priceMinor`,
    ADD COLUMN `minOrderQty`           INT            NULL     AFTER `compareAtPriceMinor`,
    ADD COLUMN `qtyIncrement`          INT            NULL     AFTER `minOrderQty`,
    ADD COLUMN `maxOrderQty`           INT            NULL     AFTER `qtyIncrement`,
    ADD COLUMN `leadTimeDays`          INT            NULL     AFTER `maxOrderQty`,
    ADD COLUMN `multipackCount`        INT            NULL     AFTER `leadTimeDays`,
    ADD COLUMN `netContentValue`       DECIMAL(18, 6) NULL     AFTER `multipackCount`,
    ADD COLUMN `netContentUnit`        VARCHAR(16)    NULL     AFTER `netContentValue`,
    ADD COLUMN `unitPricingBaseValue`  DECIMAL(18, 6) NULL     AFTER `netContentUnit`,
    ADD COLUMN `unitPricingBaseUnit`   VARCHAR(16)    NULL     AFTER `unitPricingBaseValue`,
    ADD COLUMN `manufacturerPackLabel` VARCHAR(64)    NULL     AFTER `unitPricingBaseUnit`,
    ADD COLUMN `shippingWeightGrams`   INT            NULL     AFTER `manufacturerPackLabel`,
    ADD COLUMN `shippingLengthMm`      INT            NULL     AFTER `shippingWeightGrams`,
    ADD COLUMN `shippingWidthMm`       INT            NULL     AFTER `shippingLengthMm`,
    ADD COLUMN `shippingHeightMm`      INT            NULL     AFTER `shippingWidthMm`,
    ADD COLUMN `shippingClass`         VARCHAR(32)    NULL     AFTER `shippingHeightMm`;

-- ---------------------------------------------------------------------------
-- 3. Photographs of one particular size or colour.
-- ---------------------------------------------------------------------------

CREATE TABLE `product_variant_media` (
    `id`        CHAR(26)     NOT NULL,
    `variantId` CHAR(26)     NOT NULL,
    `mediaId`   CHAR(26)     NOT NULL,
    `sortOrder` INT          NOT NULL DEFAULT 0,
    `isPrimary` TINYINT(1)   NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    UNIQUE INDEX `uq_variant_media` (`variantId`, `mediaId`),
    INDEX `ix_variant_media_sort` (`variantId`, `sortOrder`)
) ENGINE = InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `product_variant_media`
    ADD CONSTRAINT `fk_variant_media_variant`
        FOREIGN KEY (`variantId`) REFERENCES `product_variants` (`id`)
        ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `fk_variant_media_asset`
        FOREIGN KEY (`mediaId`) REFERENCES `media_assets` (`id`)
        ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. Backfill: give every existing variant a signature.
-- ---------------------------------------------------------------------------
--
-- Done in SQL rather than in a script so that a deployment cannot end up with
-- the constraint applied and the backfill un-run. The folding here is the SQL
-- equivalent of `normaliseValue`: lower case, then every run of anything that
-- is not a letter or a digit collapsed to one hyphen.
--
-- MariaDB 10.4 has no JSON_TABLE, so a row's option keys cannot be iterated in
-- pure SQL. What it does have is a deterministic serialisation of a JSON
-- object, and that is enough: `JSON_EXTRACT(optionsJson, '$')` returns the
-- object with its keys in a stable order for a given row, so folding that
-- whole string gives one value per distinct combination and the SAME value for
-- two rows that carry the same options.
--
-- That is a coarser signature than the application computes - it keeps the
-- keys in it, and it does not sort them - and it is deliberately so. Its only
-- job is to be UNIQUE PER COMBINATION for data written before this migration,
-- so that the index below can be created. Every row written afterwards, and
-- every row the admin panel touches, carries the application's own signature.

UPDATE `product_variants`
SET `optionSignature` = LEFT(
        TRIM(BOTH '-' FROM
            REGEXP_REPLACE(
                LOWER(CAST(JSON_EXTRACT(`optionsJson`, '$') AS CHAR)),
                '[^a-z0-9]+',
                '-'
            )
        ),
        512
    )
WHERE `optionSignature` = '';

-- A variant whose options serialised to nothing readable - an empty object, or
-- a value that is entirely punctuation - keeps the empty signature, and two of
-- those on one product WOULD collide. Give each a signature of its own id,
-- which is unique by construction and can never be confused with a real
-- combination because a ULID contains no colon.
UPDATE `product_variants`
SET `optionSignature` = CONCAT('legacy-', `id`)
WHERE `optionSignature` = '';

-- ---------------------------------------------------------------------------
-- 4b. Legacy rows whose options do not actually tell them apart.
-- ---------------------------------------------------------------------------
--
-- This is not a hypothetical. The imported medical catalogue in this
-- repository holds products with four variants all carrying
-- `{"Size": "3ml"}` - the thing that distinguishes them (the tip, the
-- sterilisation) went into the NAME and the SKU when they were imported and
-- never into the options. They are four genuinely different things to pick and
-- ship, and the options map simply does not say so.
--
-- Refusing the upgrade would be wrong: nothing about those rows is invalid,
-- and an operator cannot be asked to re-key a catalogue before they can
-- install a release. Merging them would be far worse - it would delete four
-- real SKUs that appear on real orders.
--
-- So each colliding row's signature gains its own SKU, which is unique across
-- this table by an index that has always existed. Every row survives, every
-- row stays sellable, and the index below can be created. What has been lost
-- is nothing; what is now visible is that those products describe their
-- variants incompletely, and `npm run variants:audit` lists exactly which,
-- so an operator can fix the data rather than discover it by accident.
--
-- Only rows that actually collide are touched, so a catalogue whose options
-- are complete comes through with clean, readable signatures.
UPDATE `product_variants` v
JOIN (
    SELECT `productId`, `optionSignature`
      FROM `product_variants`
     GROUP BY `productId`, `optionSignature`
    HAVING COUNT(*) > 1
) dup
  ON dup.`productId` = v.`productId`
 AND dup.`optionSignature` = v.`optionSignature`
SET v.`optionSignature` = LEFT(
        CONCAT(
            v.`optionSignature`,
            '|sku:',
            TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(v.`sku`), '[^a-z0-9]+', '-'))
        ),
        512
    );

-- ---------------------------------------------------------------------------
-- 5. The constraint, now that the data satisfies it.
-- ---------------------------------------------------------------------------

ALTER TABLE `product_variants`
    ADD UNIQUE INDEX `uq_variant_option_signature` (`productId`, `optionSignature`);
