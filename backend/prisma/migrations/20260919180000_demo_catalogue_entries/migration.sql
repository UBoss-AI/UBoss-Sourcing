-- Which products the demonstration catalogue planted.
--
-- A deployment that has just been installed has an empty shop front, and an
-- empty shop front cannot be reviewed, demonstrated or tested end to end. The
-- demonstration seed plants a broad catalogue - every department, every
-- sub-category - so that somebody evaluating this software sees a marketplace
-- rather than a search box with nothing behind it.
--
-- WHY THIS IS A TABLE AND NOT A COLUMN ON `products`
--
-- The safety of the whole exercise is that the seed can never touch a product
-- a person created. A boolean column on `products` would be set by whatever
-- wrote the row, which means a bug that writes the wrong row still writes the
-- wrong row. A join table inverts that: the seed resolves a blueprint to a
-- product BY READING THIS TABLE, so a product with no row here is one it has
-- no way to name, let alone overwrite.
--
-- It also makes removal exact. Taking the demonstration catalogue out is
-- deleting these rows and the products they name - not "everything with a
-- DEMO- prefix", not "everything created that afternoon".
--
-- `seedKey` is the blueprint's stable identity and is what makes a re-run
-- idempotent: the same blueprint converges on the same product row instead of
-- creating a second one beside it. UNIQUE, so two blueprints cannot claim one
-- product and one blueprint cannot produce two.
--
-- `productId` is UNIQUE as well, and ON DELETE CASCADE, because this row is a
-- fact ABOUT a product and is meaningless once that product is gone.
--
-- NO PERSONAL DATA. Deliberately - it names a product and a photographer's
-- public credit, and nothing about any person who uses this installation. That
-- is why it is out of scope for the Art. 15 export bundle; see
-- `tests/unit/export-bundle-completeness.test.ts`.
--
-- ROLLING BACK
--
--   DELETE p FROM `products` p
--     JOIN `demo_catalog_entries` d ON d.`productId` = p.`id`;
--   DROP TABLE `demo_catalog_entries`;
--
-- Run in that order, and only if nothing has been ordered from a demonstration
-- product - `order_items` is RESTRICT on the product, which is the database
-- refusing to erase evidence of a sale rather than a fault.

CREATE TABLE `demo_catalog_entries` (
    `id`                CHAR(26)     NOT NULL,
    `seedKey`           VARCHAR(128) NOT NULL,
    `productId`         CHAR(26)     NOT NULL,
    `seedSource`        VARCHAR(64)  NOT NULL DEFAULT 'demo-catalog',
    `seedVersion`       INT          NOT NULL DEFAULT 1,
    `subcategorySlug`   VARCHAR(255) NOT NULL,
    `imageSource`       VARCHAR(32)  NOT NULL DEFAULT 'placeholder',
    `imagePhotoId`      VARCHAR(64)  NULL,
    `imagePhotographer` VARCHAR(255) NULL,
    `imageProfileUrl`   VARCHAR(512) NULL,
    `imagePhotoPageUrl` VARCHAR(512) NULL,
    `imageNeedsReview`  TINYINT(1)   NOT NULL DEFAULT 0,
    `generatedAt`       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt`         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    UNIQUE INDEX `uq_demo_catalog_seed_key` (`seedKey`),
    UNIQUE INDEX `uq_demo_catalog_product` (`productId`),
    INDEX `ix_demo_catalog_source` (`seedSource`, `seedVersion`),
    INDEX `ix_demo_catalog_subcategory` (`subcategorySlug`),
    INDEX `ix_demo_catalog_image_review` (`imageNeedsReview`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `demo_catalog_entries`
    ADD CONSTRAINT `fk_demo_catalog_product`
        FOREIGN KEY (`productId`) REFERENCES `products` (`id`)
        ON DELETE CASCADE ON UPDATE CASCADE;
