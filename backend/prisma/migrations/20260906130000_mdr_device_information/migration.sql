-- Medical device information (MDR, Regulation (EU) 2017/745).
--
-- Additive, and mostly a new table: a catalogue that sells no devices gains
-- one nullable column on product_translations and nothing on products. The
-- checks become blocking only once a deployment sets mdrEnforced.

-- AlterTable
ALTER TABLE `business_profile` ADD COLUMN `mdrEnforced` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `economic_operators` ADD COLUMN `eudamedSrn` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `product_translations` ADD COLUMN `intendedPurpose` TEXT NULL;

-- CreateTable
CREATE TABLE `product_device_info` (
    `id` CHAR(26) NOT NULL,
    `productId` CHAR(26) NOT NULL,
    `deviceClass` ENUM('CLASS_I', 'CLASS_I_STERILE', 'CLASS_I_MEASURING', 'CLASS_I_REUSABLE_SURGICAL', 'CLASS_IIA', 'CLASS_IIB', 'CLASS_III') NOT NULL,
    `basicUdiDi` VARCHAR(64) NULL,
    `udiDi` VARCHAR(64) NULL,
    `notifiedBodyNumber` VARCHAR(8) NULL,
    `declarationOfConformityUrl` VARCHAR(1024) NULL,
    `intendedPurpose` TEXT NULL,
    `isSterile` BOOLEAN NOT NULL DEFAULT false,
    `isSingleUse` BOOLEAN NOT NULL DEFAULT false,
    `hasMeasuringFunction` BOOLEAN NOT NULL DEFAULT false,
    `containsBiologicalMaterial` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_device_info_product`(`productId`),
    INDEX `ix_device_info_class`(`deviceClass`),
    INDEX `ix_device_info_basic_udi`(`basicUdiDi`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `product_device_info` ADD CONSTRAINT `product_device_info_productId_fkey` FOREIGN KEY (`productId`) REFERENCES `products`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
