-- Fulfilment options at checkout, and the delivery zones that decide them.
--
-- Until now the only thing that answered "who can deliver this, and when" was
-- the geofence: a radius on the warehouse intersected with country polygons.
-- That is geometry, and geometry knows nothing about whether a carrier has
-- been appointed, what the lane costs, or how long it takes. This migration
-- adds the business half of the question and the record of the answer.
--
-- FIVE DECISIONS WORTH STATING BEFORE THE SQL
--
--   1. `warehouse_delivery_zones` - not the radius - is what decides
--      eligibility at checkout. The radius stays exactly as it is and keeps
--      driving the admin map and the public, pre-address /delivery/options
--      endpoint, so nothing that works today stops working. A warehouse with
--      no zone simply is not offered as a *fulfilment option*, which is the
--      honest answer: nobody has said what that lane costs or when it lands.
--
--   2. `postalPrefixes` is NOT NULL with a default of ''. Empty means "the
--      whole country". It cannot be nullable, because MariaDB treats every
--      NULL in a UNIQUE index as distinct - a nullable column here would let
--      one warehouse hold two "whole of Belgium" lanes at the same service
--      level and nothing would say which one priced an order.
--
--   3. `fulfilment_quotes` freezes an offer rather than letting checkout
--      recompute one. Two runs against a moving catalogue and a moving stock
--      ledger produce two answers, and the gap between them is a customer
--      charged something nobody showed them.
--
--   4. The columns on `orders` are the promise, copied. Not a join to the
--      quote: a lane gets repriced and retired, and what the buyer was told
--      on the day may not change with it. The same reasoning as the name and
--      price snapshots already on `order_items`.
--
--   5. Every column added to an existing table is nullable or defaulted, so
--      an installation already running takes this without a backfill it has
--      to think about, and every order placed before today keeps behaving
--      exactly as it did.

-- ---------------------------------------------------------------------------
-- Where a delivery address actually is, and what clock it reads.
-- ---------------------------------------------------------------------------
--
-- Decimal(9,6) to match `inventory_locations`, so the two can be measured
-- against each other without a conversion. NULL is an ordinary state: every
-- address that exists when this runs has no coordinates, the geocoder is
-- optional, and an option measured to a country border rather than to a front
-- door is still a true option - the storefront labels it "Estimated".
ALTER TABLE `addresses`
    ADD COLUMN `latitude`  DECIMAL(9, 6) NULL AFTER `country`,
    ADD COLUMN `longitude` DECIMAL(9, 6) NULL AFTER `latitude`,
    ADD COLUMN `timezone`  VARCHAR(64)   NULL AFTER `longitude`;

-- Both axes or neither, and each inside its own range. The same pair of
-- constraints `inventory_locations` carries, and for the same reason: half a
-- position names a line right around the planet.
ALTER TABLE `addresses`
  ADD CONSTRAINT `chk_address_coordinate_pair` CHECK (
    (`latitude` IS NULL AND `longitude` IS NULL)
    OR (`latitude` IS NOT NULL AND `longitude` IS NOT NULL)
  ),
  ADD CONSTRAINT `chk_address_latitude_range` CHECK (
    `latitude` IS NULL OR (`latitude` >= -90 AND `latitude` <= 90)
  ),
  ADD CONSTRAINT `chk_address_longitude_range` CHECK (
    `longitude` IS NULL OR (`longitude` >= -180 AND `longitude` <= 180)
  );

-- ---------------------------------------------------------------------------
-- What the goods themselves refuse.
-- ---------------------------------------------------------------------------
ALTER TABLE `products`
    ADD COLUMN `requiresColdChain` BOOLEAN NOT NULL DEFAULT FALSE AFTER `hasVariants`;

-- A country a product may not be delivered to, whatever warehouse it leaves.
--
-- CASCADE from the product, like every other row that only means something
-- while the product exists. No FK to `countries` - see the model comment; the
-- shape is checked here and the code is checked against ISO 3166-1 in the
-- service.
CREATE TABLE `product_country_restrictions` (
    `id`          CHAR(26)     NOT NULL,
    `productId`   CHAR(26)     NOT NULL,
    `countryCode` CHAR(2)      NOT NULL,
    `reason`      VARCHAR(256) NULL,
    `createdAt`   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_product_country_restriction`(`productId`, `countryCode`),
    INDEX `ix_product_restriction_country`(`countryCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `product_country_restrictions`
    ADD CONSTRAINT `product_country_restrictions_productId_fkey`
    FOREIGN KEY (`productId`) REFERENCES `products`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `product_country_restrictions`
  ADD CONSTRAINT `chk_product_restriction_country_shape` CHECK (
    `countryCode` REGEXP '^[A-Z]{2}$'
  );

-- ---------------------------------------------------------------------------
-- The lanes.
-- ---------------------------------------------------------------------------
--
-- CASCADE from the warehouse, on the same reasoning as
-- `warehouse_country_exclusions`: a lane is configuration that only means
-- anything while the building exists, not history that explains where stock
-- went.
CREATE TABLE `warehouse_delivery_zones` (
    `id`                  CHAR(26)     NOT NULL,
    `locationId`          CHAR(26)     NOT NULL,
    `countryCode`         CHAR(2)      NOT NULL,
    `postalPrefixes`      VARCHAR(512) NOT NULL DEFAULT '',
    `carrierName`         VARCHAR(64)  NOT NULL,
    `serviceLevel`        VARCHAR(64)  NOT NULL,
    `handlingDays`        INT          NOT NULL DEFAULT 1,
    `transitMinDays`      INT          NOT NULL,
    `transitMaxDays`      INT          NOT NULL,
    `usesBusinessDays`    BOOLEAN      NOT NULL DEFAULT TRUE,
    `shippingFeeMinor`    BIGINT       NOT NULL DEFAULT 0,
    `shippingFeeCurrency` CHAR(3)      NOT NULL,
    `freeAboveMinor`      BIGINT       NULL,
    `supportsColdChain`   BOOLEAN      NOT NULL DEFAULT FALSE,
    `maxWeightGrams`      INT          NULL,
    `isActive`            BOOLEAN      NOT NULL DEFAULT TRUE,
    `priority`            INT          NOT NULL DEFAULT 0,
    `createdAt`           DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`           DATETIME(3)  NOT NULL,

    UNIQUE INDEX `uq_warehouse_zone_lane`(`locationId`, `countryCode`, `postalPrefixes`, `serviceLevel`),
    INDEX `ix_warehouse_zone_country`(`countryCode`, `isActive`),
    INDEX `ix_warehouse_zone_location`(`locationId`, `isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `warehouse_delivery_zones`
    ADD CONSTRAINT `warehouse_delivery_zones_locationId_fkey`
    FOREIGN KEY (`locationId`) REFERENCES `inventory_locations`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The invariants, in the same spirit as 20260910200000_warehouse_geofencing.
-- The API checks every one of these and puts the message on the field
-- somebody typed into; these exist for the import, the hand-written UPDATE
-- and the caller written next year.
ALTER TABLE `warehouse_delivery_zones`
  ADD CONSTRAINT `chk_warehouse_zone_country_shape` CHECK (
    `countryCode` REGEXP '^[A-Z]{2}$'
  ),
  -- A negative handling time is a box leaving before it was ordered.
  ADD CONSTRAINT `chk_warehouse_zone_handling` CHECK (
    `handlingDays` >= 0 AND `handlingDays` <= 90
  ),
  -- Both ends of the transit window, in the right order. Zero is legitimate -
  -- a same-day courier inside one city - so it is the ordering that is held,
  -- not the floor.
  ADD CONSTRAINT `chk_warehouse_zone_transit` CHECK (
    `transitMinDays` >= 0
    AND `transitMaxDays` <= 365
    AND `transitMinDays` <= `transitMaxDays`
  ),
  -- Money is never negative and never carries an implied currency. The
  -- currency column is NOT NULL here rather than paired with the amount,
  -- because a lane always has a price even when that price is nothing, and
  -- "free" still has to be free *in* something.
  ADD CONSTRAINT `chk_warehouse_zone_fee_sign` CHECK (
    `shippingFeeMinor` >= 0 AND (`freeAboveMinor` IS NULL OR `freeAboveMinor` >= 0)
  ),
  ADD CONSTRAINT `chk_warehouse_zone_currency_shape` CHECK (
    `shippingFeeCurrency` REGEXP '^[A-Z]{3}$'
  ),
  ADD CONSTRAINT `chk_warehouse_zone_weight` CHECK (
    `maxWeightGrams` IS NULL OR `maxWeightGrams` > 0
  );

-- ---------------------------------------------------------------------------
-- The offers themselves.
-- ---------------------------------------------------------------------------
--
-- Four different delete rules on one table, and each of them is a decision:
--
--   * customerProfile CASCADE  - erasure under Art. 17 must be able to take
--                                quotes with it; they are short-lived offers,
--                                not accounting records.
--   * cart / address SET NULL  - a cart that converts and an address that is
--                                archived must not be blocked by a quote, and
--                                the quote keeps its own frozen copy anyway.
--   * location RESTRICT        - the same rule every other table pointing at a
--                                warehouse follows.
--   * zone SET NULL            - retiring a carrier is an ordinary act and must
--                                not be held up by offers nobody took.
CREATE TABLE `fulfilment_quotes` (
    `id`                    CHAR(26)     NOT NULL,
    `customerProfileId`     CHAR(26)     NOT NULL,
    `cartId`                CHAR(26)     NULL,
    `addressId`             CHAR(26)     NULL,
    `locationId`            CHAR(26)     NOT NULL,
    `zoneId`                CHAR(26)     NULL,
    `destinationCountry`    CHAR(2)      NOT NULL,
    `destinationPostalCode` VARCHAR(16)  NULL,
    `isEstimate`            BOOLEAN      NOT NULL DEFAULT FALSE,
    `currency`              CHAR(3)      NOT NULL,
    `subtotalMinor`         BIGINT       NOT NULL DEFAULT 0,
    `discountMinor`         BIGINT       NOT NULL DEFAULT 0,
    `taxMinor`              BIGINT       NOT NULL DEFAULT 0,
    `shippingMinor`         BIGINT       NOT NULL DEFAULT 0,
    `grandTotalMinor`       BIGINT       NOT NULL DEFAULT 0,
    `dispatchDate`          DATE         NOT NULL,
    `deliveryFromDate`      DATE         NOT NULL,
    `deliveryToDate`        DATE         NOT NULL,
    `transitMinDays`        INT          NOT NULL,
    `transitMaxDays`        INT          NOT NULL,
    `handlingDays`          INT          NOT NULL DEFAULT 0,
    `carrierName`           VARCHAR(64)  NOT NULL,
    `serviceLevel`          VARCHAR(64)  NOT NULL,
    `distanceKm`            DECIMAL(9,2) NULL,
    `basketHash`            CHAR(64)     NOT NULL,
    `itemsJson`             JSON         NOT NULL,
    `expiresAt`             DATETIME(3)  NOT NULL,
    `createdAt`             DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_fulfilment_quote_customer`(`customerProfileId`, `createdAt`),
    INDEX `ix_fulfilment_quote_expiry`(`expiresAt`),
    INDEX `ix_fulfilment_quote_location`(`locationId`),
    INDEX `ix_fulfilment_quote_cart`(`cartId`),
    INDEX `ix_fulfilment_quote_address`(`addressId`),
    INDEX `ix_fulfilment_quote_zone`(`zoneId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `fulfilment_quotes`
    ADD CONSTRAINT `fulfilment_quotes_customerProfileId_fkey`
      FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`)
      ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT `fulfilment_quotes_cartId_fkey`
      FOREIGN KEY (`cartId`) REFERENCES `carts`(`id`)
      ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT `fulfilment_quotes_addressId_fkey`
      FOREIGN KEY (`addressId`) REFERENCES `addresses`(`id`)
      ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT `fulfilment_quotes_locationId_fkey`
      FOREIGN KEY (`locationId`) REFERENCES `inventory_locations`(`id`)
      ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `fulfilment_quotes_zoneId_fkey`
      FOREIGN KEY (`zoneId`) REFERENCES `warehouse_delivery_zones`(`id`)
      ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `fulfilment_quotes`
  -- The arrival window cannot open before the box leaves, and cannot close
  -- before it opens. A quote that said otherwise would print a promise nobody
  -- could read.
  ADD CONSTRAINT `chk_fulfilment_quote_dates` CHECK (
    `dispatchDate` <= `deliveryFromDate` AND `deliveryFromDate` <= `deliveryToDate`
  ),
  ADD CONSTRAINT `chk_fulfilment_quote_transit` CHECK (
    `transitMinDays` >= 0 AND `transitMinDays` <= `transitMaxDays` AND `handlingDays` >= 0
  ),
  ADD CONSTRAINT `chk_fulfilment_quote_money` CHECK (
    `subtotalMinor` >= 0 AND `discountMinor` >= 0 AND `taxMinor` >= 0
    AND `shippingMinor` >= 0 AND `grandTotalMinor` >= 0
  );

-- ---------------------------------------------------------------------------
-- The promise, frozen onto the order.
-- ---------------------------------------------------------------------------
ALTER TABLE `orders`
    ADD COLUMN `fulfilmentLocationId`   CHAR(26)    NULL AFTER `paymentMode`,
    ADD COLUMN `fulfilmentQuoteId`      CHAR(26)    NULL AFTER `fulfilmentLocationId`,
    ADD COLUMN `fulfilmentCarrier`      VARCHAR(64) NULL AFTER `fulfilmentQuoteId`,
    ADD COLUMN `fulfilmentServiceLevel` VARCHAR(64) NULL AFTER `fulfilmentCarrier`,
    ADD COLUMN `fulfilmentDispatchDate` DATE        NULL AFTER `fulfilmentServiceLevel`,
    ADD COLUMN `fulfilmentDeliveryFrom` DATE        NULL AFTER `fulfilmentDispatchDate`,
    ADD COLUMN `fulfilmentDeliveryTo`   DATE        NULL AFTER `fulfilmentDeliveryFrom`;

CREATE INDEX `ix_order_fulfilment_location` ON `orders`(`fulfilmentLocationId`);
CREATE INDEX `ix_order_fulfilment_quote` ON `orders`(`fulfilmentQuoteId`);

ALTER TABLE `orders`
    ADD CONSTRAINT `orders_fulfilmentLocationId_fkey`
      FOREIGN KEY (`fulfilmentLocationId`) REFERENCES `inventory_locations`(`id`)
      ON DELETE RESTRICT ON UPDATE CASCADE,
    ADD CONSTRAINT `orders_fulfilmentQuoteId_fkey`
      FOREIGN KEY (`fulfilmentQuoteId`) REFERENCES `fulfilment_quotes`(`id`)
      ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `orders`
  -- The same ordering rule the quote carries. An order whose delivery window
  -- opened before dispatch would print a date range nobody can act on.
  ADD CONSTRAINT `chk_order_fulfilment_dates` CHECK (
    (`fulfilmentDispatchDate` IS NULL AND `fulfilmentDeliveryFrom` IS NULL AND `fulfilmentDeliveryTo` IS NULL)
    OR (`fulfilmentDispatchDate` IS NOT NULL
        AND `fulfilmentDeliveryFrom` IS NOT NULL
        AND `fulfilmentDeliveryTo` IS NOT NULL
        AND `fulfilmentDispatchDate` <= `fulfilmentDeliveryFrom`
        AND `fulfilmentDeliveryFrom` <= `fulfilmentDeliveryTo`)
  );
