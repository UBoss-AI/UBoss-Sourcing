-- AlterTable
ALTER TABLE `carts` ADD COLUMN `appliedCouponId` CHAR(26) NULL;

-- AlterTable
ALTER TABLE `customer_profiles` ADD COLUMN `detectedAt` DATETIME(3) NULL,
    ADD COLUMN `detectedCountry` CHAR(2) NULL,
    ADD COLUMN `localeChosenAt` DATETIME(3) NULL,
    ADD COLUMN `preferredCountry` CHAR(2) NULL,
    ADD COLUMN `preferredCurrency` CHAR(3) NULL;

-- CreateTable
CREATE TABLE `currencies` (
    `code` CHAR(3) NOT NULL,
    `name` VARCHAR(64) NOT NULL,
    `symbol` VARCHAR(8) NOT NULL,
    `exponent` INTEGER NOT NULL DEFAULT 2,
    `isBase` BOOLEAN NOT NULL DEFAULT false,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_currency_active_sort`(`isActive`, `sortOrder`),
    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `countries` (
    `code` CHAR(2) NOT NULL,
    `name` VARCHAR(96) NOT NULL,
    `currencyCode` CHAR(3) NOT NULL,
    `phonePrefix` VARCHAR(8) NULL,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_country_active_sort`(`isActive`, `sortOrder`),
    INDEX `ix_country_currency`(`currencyCode`),
    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_prices` (
    `id` CHAR(26) NOT NULL,
    `productId` CHAR(26) NOT NULL,
    `variantId` CHAR(26) NULL,
    `variantKey` VARCHAR(26) NOT NULL DEFAULT '',
    `currencyCode` CHAR(3) NOT NULL,
    `basePriceMinor` BIGINT NOT NULL,
    `compareAtPriceMinor` BIGINT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `updatedById` CHAR(26) NULL,

    INDEX `ix_product_price_currency_amount`(`currencyCode`, `basePriceMinor`),
    INDEX `ix_product_price_variant`(`variantId`),
    UNIQUE INDEX `uq_product_price_sku_currency`(`productId`, `variantKey`, `currencyCode`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `coupons` (
    `id` CHAR(26) NOT NULL,
    `code` VARCHAR(32) NOT NULL,
    `name` VARCHAR(128) NOT NULL,
    `description` VARCHAR(255) NULL,
    `discountPercent` DECIMAL(5, 2) NOT NULL,
    `scope` ENUM('ALL_PRODUCTS', 'CATEGORIES') NOT NULL DEFAULT 'ALL_PRODUCTS',
    `status` ENUM('DRAFT', 'ACTIVE', 'DISABLED') NOT NULL DEFAULT 'DRAFT',
    `isPubliclyListed` BOOLEAN NOT NULL DEFAULT true,
    `validFrom` DATETIME(3) NULL,
    `validUntil` DATETIME(3) NULL,
    `usageLimit` INTEGER NULL,
    `perCustomerLimit` INTEGER NULL,
    `usageCount` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdById` CHAR(26) NULL,
    `updatedById` CHAR(26) NULL,

    UNIQUE INDEX `uq_coupon_code`(`code`),
    INDEX `ix_coupon_live`(`status`, `validFrom`, `validUntil`),
    INDEX `ix_coupon_listed`(`status`, `isPubliclyListed`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `coupon_categories` (
    `couponId` CHAR(26) NOT NULL,
    `categoryId` CHAR(26) NOT NULL,
    `includeDescendants` BOOLEAN NOT NULL DEFAULT true,

    INDEX `ix_coupon_category_category`(`categoryId`),
    PRIMARY KEY (`couponId`, `categoryId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `coupon_minimums` (
    `couponId` CHAR(26) NOT NULL,
    `currencyCode` CHAR(3) NOT NULL,
    `minOrderMinor` BIGINT NOT NULL DEFAULT 0,

    PRIMARY KEY (`couponId`, `currencyCode`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `coupon_redemptions` (
    `id` CHAR(26) NOT NULL,
    `couponId` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `customerProfileId` CHAR(26) NULL,
    `codeSnapshot` VARCHAR(32) NOT NULL,
    `discountPercentSnapshot` DECIMAL(5, 2) NOT NULL,
    `currencyCode` CHAR(3) NOT NULL,
    `discountMinor` BIGINT NOT NULL,
    `redeemedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_coupon_redemption_coupon`(`couponId`, `redeemedAt`),
    INDEX `ix_coupon_redemption_customer`(`customerProfileId`, `couponId`),
    UNIQUE INDEX `uq_coupon_redemption_order`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `carts` ADD CONSTRAINT `carts_appliedCouponId_fkey` FOREIGN KEY (`appliedCouponId`) REFERENCES `coupons`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `countries` ADD CONSTRAINT `countries_currencyCode_fkey` FOREIGN KEY (`currencyCode`) REFERENCES `currencies`(`code`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_prices` ADD CONSTRAINT `product_prices_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_prices` ADD CONSTRAINT `product_prices_variantId_fkey` FOREIGN KEY (`variantId`) REFERENCES `product_variants`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_prices` ADD CONSTRAINT `product_prices_currencyCode_fkey` FOREIGN KEY (`currencyCode`) REFERENCES `currencies`(`code`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `coupon_categories` ADD CONSTRAINT `coupon_categories_couponId_fkey` FOREIGN KEY (`couponId`) REFERENCES `coupons`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `coupon_categories` ADD CONSTRAINT `coupon_categories_categoryId_fkey` FOREIGN KEY (`categoryId`) REFERENCES `categories`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `coupon_minimums` ADD CONSTRAINT `coupon_minimums_couponId_fkey` FOREIGN KEY (`couponId`) REFERENCES `coupons`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `coupon_minimums` ADD CONSTRAINT `coupon_minimums_currencyCode_fkey` FOREIGN KEY (`currencyCode`) REFERENCES `currencies`(`code`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `coupon_redemptions` ADD CONSTRAINT `coupon_redemptions_couponId_fkey` FOREIGN KEY (`couponId`) REFERENCES `coupons`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `coupon_redemptions` ADD CONSTRAINT `coupon_redemptions_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `coupon_redemptions` ADD CONSTRAINT `coupon_redemptions_customerProfileId_fkey` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

