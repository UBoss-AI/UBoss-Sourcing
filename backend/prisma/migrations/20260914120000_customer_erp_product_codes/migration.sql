-- "Their code X is our product Y."
--
-- The gap this closes was measured on a live connection rather than imagined.
-- A buyer's monday.com board held 708 finished-goods codes (`FG/1BZ1B1-G`);
-- the store's catalogue held 247 products (`EV-CANNULA-WP`). Both sides carry
-- a barcode column, which would have been the obvious join, and the
-- catalogue's was empty on all 247 rows. There was no identifier in common at
-- all - so a sync read 708 records, recorded 1, and that 1 was a coincidence.
--
-- No amount of mapping configuration fixes that, because the information
-- needed to join the two catalogues did not exist anywhere yet. Somebody has
-- to supply it. This is where it goes.
--
-- `reconcile.service.ts` has said from the start that matching is on SKU
-- "exactly... until somebody says otherwise". This table is somebody saying
-- otherwise, and the reconciliation screen is where they say it: it already
-- produces the two lists - codes only in their system, products only in ours -
-- that a person needs in order to pair them.
--
-- WHY THIS IS NOT A COLUMN ON `products`
--
-- The shortcut would be `products.supplierCode`. It is wrong here for a
-- structural reason: this software is sold to companies who run it
-- themselves, and one product is bought by many organisations who each call it
-- something different in their own ERP. A column on the product row holds
-- exactly one of those answers, and the second buyer to connect overwrites the
-- first. The mapping belongs to the CONNECTION.
--
-- WHY THERE IS NO `createdByProfileId`
--
-- Who created a mapping is already recorded, properly, in
-- `customer_erp_audit_logs` by `recordOrgAudit`. Copying a person's id in here
-- would put personal data in a table of catalogue mappings, which the Art. 15
-- export would then have to account for - see
-- `tests/unit/export-bundle-completeness.test.ts`, which exists to catch
-- exactly that - in order to record something already recorded elsewhere.
--
-- NULLABILITY, AND THE MARIADB RULE
--
-- `variantKey` is NOT NULL with a '' default rather than a nullable column.
-- MariaDB's UNIQUE treats every NULL as distinct, so a nullable variant inside
-- the unique index below would let the same code be mapped twice without the
-- index noticing. Same convention as `customer_erp_inventory_links`.

CREATE TABLE `customer_erp_product_codes` (
    `id`             CHAR(26)     NOT NULL,
    `connectionId`   CHAR(26)     NOT NULL,
    `organizationId` CHAR(26)     NOT NULL,

    -- Byte for byte as their system sends it. Never trimmed of punctuation,
    -- never case-folded. The value of this table is that it is an exact
    -- statement somebody made; a lookup that guessed would attach a stock
    -- figure to the wrong item and be believed.
    --
    -- The collation is deliberately the schema's own utf8mb4_unicode_ci, which
    -- is case-INSENSITIVE, so `FG/1BZ1B1-G` and `fg/1bz1b1-g` collide in the
    -- unique index below. That is the intended behaviour: an ERP that varies
    -- the case of its own codes between exports is not describing two products,
    -- and letting both rows exist would make which one wins depend on
    -- insertion order.
    `erpCode`        VARCHAR(191) NOT NULL,

    `productId`      CHAR(26)     NOT NULL,
    `variantKey`     CHAR(26)     NOT NULL DEFAULT '',

    `note`           VARCHAR(512) NULL,

    `createdAt`      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`      DATETIME(3)  NOT NULL,

    -- One product per code, per connection. Their system cannot mean two of our
    -- products by one code; if it does, that is two codes.
    --
    -- The reverse is deliberately NOT unique: a buyer whose ERP holds the same
    -- item under an old code and a new one maps both to the one product here,
    -- and both must resolve.
    UNIQUE INDEX `uq_customer_erp_product_code`(`connectionId`, `erpCode`),

    -- "What is this product mapped to?", for the reconciliation screen.
    INDEX `ix_customer_erp_product_code_product`(`connectionId`, `productId`),

    -- Tenant scoping, for the admin support view.
    INDEX `ix_customer_erp_product_code_org`(`organizationId`),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ON DELETE CASCADE, matching every other child of a connection.
--
-- A disconnected connection destroys its credentials and keeps its history;
-- a DELETED one takes its mappings with it, because a mapping names a
-- connection that no longer exists and means nothing on its own.
ALTER TABLE `customer_erp_product_codes`
  ADD CONSTRAINT `fk_customer_erp_product_code_connection`
  FOREIGN KEY (`connectionId`) REFERENCES `customer_erp_connections`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;

-- NO foreign key to `products`, and this is the same choice
-- `customer_erp_inventory_links` made.
--
-- A restrictive FK would make deleting a product fail while any buyer anywhere
-- had it mapped, which turns one organisation's private mapping into a veto
-- over the operator's own catalogue. A cascading one would silently delete
-- mappings a buyer spent an afternoon making, on a product that was merely
-- renamed and re-added. Resolution therefore joins and tolerates a miss - a
-- mapping whose product has gone simply stops matching, which is the honest
-- outcome and is visible on the reconciliation screen.
