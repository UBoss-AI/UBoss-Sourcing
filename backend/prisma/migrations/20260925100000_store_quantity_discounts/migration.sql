-- Store-wide quantity discounts on the operator's own products.
--
-- "From 50 pieces, 5% off", set once by the operator. Applied by
-- domain/quantity-tier.ts as an ordinary band, so the storefront's offer and
-- the checkout's price are one function. Never applied to a seller's offer.
--
-- Additive only, and empty: a new or upgraded installation runs no store-wide
-- discount until somebody sets one.

-- CreateTable
CREATE TABLE `store_quantity_discounts` (
    `id` CHAR(26) NOT NULL,
    `minQuantity` INTEGER NOT NULL,
    `discountBasisPoints` INTEGER NOT NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_store_quantity_discount_min`(`minQuantity`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- From two pieces (one piece is a price cut, not a quantity discount), and
-- between 0.01% and 90% off.
ALTER TABLE `store_quantity_discounts`
    ADD CONSTRAINT `chk_store_quantity_discount_min` CHECK (`minQuantity` >= 2),
    ADD CONSTRAINT `chk_store_quantity_discount_bp` CHECK (`discountBasisPoints` BETWEEN 1 AND 9000);
