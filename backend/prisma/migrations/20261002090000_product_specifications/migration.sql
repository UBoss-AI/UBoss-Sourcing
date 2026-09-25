-- Grouped product specifications, per-variant overrides, description sections,
-- and the seller's own content on a listing draft.
-- See `domain/product-specifications.ts`.

-- Existing rows keep NULL groupKey and read as GENERAL.
ALTER TABLE `product_attributes`
    ADD COLUMN `groupKey` VARCHAR(32) NULL,
    ADD COLUMN `unit` VARCHAR(24) NULL,
    ADD COLUMN `isHighlight` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `product_variant_attributes` (
    `id` CHAR(26) NOT NULL,
    `variantId` CHAR(26) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `value` VARCHAR(512) NOT NULL,
    `unit` VARCHAR(24) NULL,
    `groupKey` VARCHAR(32) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `uq_product_variant_attribute_name`(`variantId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_description_sections` (
    `id` CHAR(26) NOT NULL,
    `productId` CHAR(26) NOT NULL,
    `language` VARCHAR(10) NULL,
    `heading` VARCHAR(120) NOT NULL,
    `body` TEXT NOT NULL,
    `imageMediaId` CHAR(26) NULL,
    `altText` VARCHAR(255) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_product_description_section_order`(`productId`, `language`, `sortOrder`),
    INDEX `fk_product_description_section_image`(`imageMediaId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- The seller's specifications and description, before approval.
ALTER TABLE `seller_listing_drafts`
    ADD COLUMN `listingContentJson` JSON NULL;

-- AddForeignKey
ALTER TABLE `product_variant_attributes` ADD CONSTRAINT `fk_product_variant_attribute_variant` FOREIGN KEY (`variantId`) REFERENCES `product_variants`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `product_description_sections` ADD CONSTRAINT `fk_product_description_section_product` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `product_description_sections` ADD CONSTRAINT `fk_product_description_section_image` FOREIGN KEY (`imageMediaId`) REFERENCES `media_assets`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;
