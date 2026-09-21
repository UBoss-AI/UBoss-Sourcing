-- An instruction a shopper leaves on a product, without buying it.
--
-- WHAT WAS MISSING
--
-- `cart_items.note`, added in 20260919210000, lets a buyer say what they need
-- done to one product -- "the 316 grade, not 304", "engrave both ends". It is
-- the right column and it arrives too late. It only exists once the product is
-- in a basket, and it only reaches a seller if that basket becomes an order.
--
-- The things a trade buyer most wants to say are said BEFORE either of those.
-- "Do you do this in 8mm?" "Can you supply it with a calibration certificate?"
-- "We need four hundred a month -- would you hold stock?" Every one of those
-- decides whether there is an order at all, and until now there was nowhere on
-- the product to put them. They became an email nobody could tie back to a
-- product, or they became nothing and the sale did not happen.
--
-- WHAT THIS DOES
--
-- One table. The same fact as the basket line's note, standing free of a
-- basket: one shopper, one product, in their own words, read by whoever sells
-- it.
--
-- ONE ROW PER SHOPPER PER PRODUCT
--
-- `uq_product_instruction` is the design, not an optimisation. This is
-- deliberately not a comment thread -- a public thread under a product is a
-- different feature with different problems, and it is not what was asked
-- for. A shopper holds ONE standing instruction about a product and editing it
-- replaces what they said, exactly as the basket note behaves.
--
-- It also answers the abuse question without a moderation queue. A signed-in
-- shopper can hold at most one row per product, so there is no flood to
-- moderate: the worst case is one sentence from one identified account.
--
-- WHY `variantKey` AND NOT A NULLABLE `variantId`
--
-- The reason recorded in the schema header. A MariaDB UNIQUE index treats
-- every NULL as distinct, so a nullable `variantId` inside the composite above
-- would NOT stop one shopper filing two rows against the same version. The key
-- is the variant ULID, or '' for "this product in general", and is never null.
-- There is no foreign key to `product_variants`, for the reason the wishlist
-- states: a variant has to stay deletable.
--
-- WHY VARCHAR(500) AND NOT TEXT
--
-- The same ceiling `cart_items.note` carries, and the same reasoning: a few
-- sentences about one product, read by a seller working down a list of them.
-- The API enforces the same number so going over is a message rather than a
-- silent truncation -- which matters more here than in most places, because
-- MariaDB 10.4 is not strict and WOULD truncate it.
--
-- CASCADE ON BOTH SIDES
--
-- Deleting a customer takes their instructions with them, which is what an
-- Art. 17 erasure has to do. Deleting a product takes them too: a product
-- leaving the catalogue must not be blocked by somebody having asked a
-- question about it, and an instruction pointing at a product that no longer
-- exists is not worth keeping.
--
-- NOTHING EXISTING CHANGES
--
-- A new table and two foreign keys. No column on an existing table is altered,
-- no constraint is added to one, and every query written before today returns
-- exactly what it returned yesterday.
--
-- ROLLING BACK
--
--   DROP TABLE `product_instructions`;
--
-- Instructions already written are lost, which is the honest consequence.

CREATE TABLE `product_instructions` (
    `id`                CHAR(26)     NOT NULL,
    `productId`         CHAR(26)     NOT NULL,
    `customerProfileId` CHAR(26)     NOT NULL,
    `variantKey`        CHAR(26)     NOT NULL DEFAULT '',
    `body`              VARCHAR(500) NOT NULL,
    `createdAt`         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_product_instruction`(`customerProfileId`, `productId`, `variantKey`),
    INDEX `ix_product_instruction_product_time`(`productId`, `createdAt`),
    INDEX `ix_product_instruction_customer_time`(`customerProfileId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `product_instructions`
    ADD CONSTRAINT `fk_product_instruction_customer` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `product_instructions`
    ADD CONSTRAINT `fk_product_instruction_product` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
