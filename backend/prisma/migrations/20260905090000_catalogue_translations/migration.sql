-- Per-language product and category copy.
--
-- Side tables rather than `name_pl`, `name_el` … columns on `products`:
-- adding a language becomes a row, not a migration, and "not translated yet"
-- is the absence of a row rather than a column full of NULLs. The catalogue
-- falls back to the base row for anything missing, which is the same rule the
-- interface already uses for a missing translation key.
--
-- Deliberately not translated:
--
--   * `slug` - one URL serves every language. This is an ordering system
--     reached by link, not a public SEO site, and per-language slugs drag in
--     routing, redirects and canonical tags for no buyer-facing gain.
--   * `sku` - an identifier, not prose.
--   * `product_variants.name` - those read "14G x FEP": gauge and material,
--     which are the same words in every language and wrong to translate.
--
-- `isReviewed` exists because these rows will be machine-translated first. The
-- admin panel needs to distinguish "nobody has read this" from "checked", or
-- the review never happens.

CREATE TABLE `product_translations` (
    `id`               CHAR(26)      NOT NULL,
    `productId`        CHAR(26)      NOT NULL,
    `language`         VARCHAR(10)   NOT NULL,

    `name`             VARCHAR(255)  NOT NULL,
    `shortDescription` VARCHAR(1024) NULL,
    `description`      TEXT          NULL,

    `metaTitle`        VARCHAR(255)  NULL,
    `metaDescription`  VARCHAR(512)  NULL,

    `isReviewed`       BOOLEAN       NOT NULL DEFAULT false,

    `createdAt`        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`        DATETIME(3)   NOT NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `uq_product_translation` (`productId`, `language`),
    INDEX `ix_product_translation_language` (`language`),
    -- Catalogue search filters on the translated name, so it is indexed the
    -- same way `products.name` is.
    INDEX `ix_product_translation_name` (`name`),

    CONSTRAINT `fk_product_translation_product`
        FOREIGN KEY (`productId`) REFERENCES `products`(`id`)
        ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `category_translations` (
    `id`              CHAR(26)     NOT NULL,
    `categoryId`      CHAR(26)     NOT NULL,
    `language`        VARCHAR(10)  NOT NULL,

    `name`            VARCHAR(255) NOT NULL,
    `description`     TEXT         NULL,

    `metaTitle`       VARCHAR(255) NULL,
    `metaDescription` VARCHAR(512) NULL,

    `isReviewed`      BOOLEAN      NOT NULL DEFAULT false,

    `createdAt`       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`       DATETIME(3)  NOT NULL,

    PRIMARY KEY (`id`),
    UNIQUE INDEX `uq_category_translation` (`categoryId`, `language`),
    INDEX `ix_category_translation_language` (`language`),

    CONSTRAINT `fk_category_translation_category`
        FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`)
        ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
