-- Container preorders and availability proposals.
--
-- Two connected pieces:
--
--   1. A buyer may preorder in 20-ft or 40-ft containers. The piece capacity of
--      each is the SELLER'S, per offer (and so per variant), in
--      `seller_container_loading`, and the request keeps a snapshot of it.
--
--   2. When a request is for more than the seller has available to promise,
--      the seller answers with the whole quantity on a revised date or a split
--      delivery. The schedule is `preorder_fulfilment_installments`; stock on
--      hand is held for the buyer in `preorder_stock_holds` when they accept.
--
-- Backward compatible: every new column is nullable or defaulted, every enum
-- only gains members, and no existing row changes meaning. A piece preorder
-- made before this migration reads exactly as it did.
--
-- Every foreign key is ON UPDATE RESTRICT: MariaDB 11.4 refuses a CHECK on a
-- column a cascading key could rewrite (error 1901).

-- AlterTable
ALTER TABLE `preorder_offers` ADD COLUMN `availableNowBaseUnits` INTEGER NULL,
    ADD COLUMN `stockAllocationBaseUnits` INTEGER NOT NULL DEFAULT 0,
    MODIFY `kind` ENUM('ACCEPT_AS_REQUESTED', 'COUNTER', 'FULL_ON_REVISED_DATE', 'SPLIT_DELIVERY') NOT NULL,
    MODIFY `state` ENUM('PROPOSED', 'ACCEPTED', 'DECLINED', 'SUPERSEDED', 'EXPIRED', 'WITHDRAWN', 'INVALIDATED') NOT NULL DEFAULT 'PROPOSED';

-- AlterTable
ALTER TABLE `preorder_policies` ADD COLUMN `safetyStockBaseUnits` INTEGER NOT NULL DEFAULT 0,
    MODIFY `moqUnit` ENUM('PIECE', 'CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER', 'CONTAINER_20_FT', 'CONTAINER_40_FT') NOT NULL DEFAULT 'PIECE';

-- AlterTable
ALTER TABLE `preorder_requests` ADD COLUMN `availableToPromiseAtSubmission` INTEGER NULL,
    ADD COLUMN `containerLoadingSnapshotJson` JSON NULL,
    ADD COLUMN `containerLoadingVersion` INTEGER NULL,
    ADD COLUMN `shortfallAtSubmission` INTEGER NOT NULL DEFAULT 0,
    MODIFY `orderingUnit` ENUM('PIECE', 'CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER', 'CONTAINER_20_FT', 'CONTAINER_40_FT') NOT NULL,
    MODIFY `packagingPreference` ENUM('PIECE', 'CARTON', 'UK_PALLET', 'US_PALLET', 'CONTAINER', 'CONTAINER_20_FT', 'CONTAINER_40_FT') NULL;

-- CreateTable
CREATE TABLE `seller_container_loading` (
    `id` CHAR(26) NOT NULL,
    `offerId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `piecesPerCarton` INTEGER NOT NULL,
    `cartonLengthMm` INTEGER NOT NULL,
    `cartonWidthMm` INTEGER NOT NULL,
    `cartonHeightMm` INTEGER NOT NULL,
    `grossWeightPerCartonGrams` BIGINT NOT NULL,
    `maxStackLayers` INTEGER NULL,
    `loadingMethod` ENUM('PALLET_LOADED', 'CARTON_LOADED', 'CUSTOM') NOT NULL DEFAULT 'CARTON_LOADED',
    `cartonsPerPallet` INTEGER NULL,
    `palletsPer20FtContainer` INTEGER NULL,
    `cartonsPer20FtContainer` INTEGER NULL,
    `piecesPer20FtContainer` INTEGER NULL,
    `source20Ft` ENUM('SELLER_VERIFIED', 'CALCULATED_ESTIMATE') NULL,
    `verified20FtAt` DATETIME(3) NULL,
    `palletsPer40FtContainer` INTEGER NULL,
    `cartonsPer40FtContainer` INTEGER NULL,
    `piecesPer40FtContainer` INTEGER NULL,
    `source40Ft` ENUM('SELLER_VERIFIED', 'CALCULATED_ESTIMATE') NULL,
    `verified40FtAt` DATETIME(3) NULL,
    `notes` VARCHAR(1000) NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `updatedByLabel` VARCHAR(160) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_container_loading_offer`(`offerId`),
    INDEX `ix_container_loading_seller`(`sellerAccountId`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `preorder_fulfilment_installments` (
    `id` CHAR(26) NOT NULL,
    `requestId` CHAR(26) NOT NULL,
    `offerId` CHAR(26) NOT NULL,
    `sequence` INTEGER NOT NULL,
    `quantityBaseUnits` INTEGER NOT NULL,
    `committedDeliveryDate` DATE NOT NULL,
    `source` ENUM('AVAILABLE_STOCK', 'FUTURE_SUPPLY') NOT NULL,
    `status` ENUM('PROPOSED', 'PLANNED', 'STOCK_RESERVED', 'CANCELLED') NOT NULL DEFAULT 'PROPOSED',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ix_preorder_installment_request`(`requestId`, `status`),
    UNIQUE INDEX `uq_preorder_installment_sequence`(`offerId`, `sequence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `preorder_stock_holds` (
    `id` CHAR(26) NOT NULL,
    `requestId` CHAR(26) NOT NULL,
    `sellerAccountId` CHAR(26) NOT NULL,
    `offerId` CHAR(26) NOT NULL,
    `locationId` CHAR(26) NOT NULL,
    `quantityBaseUnits` INTEGER NOT NULL,
    `status` ENUM('HELD', 'RELEASED', 'TRANSFERRED') NOT NULL DEFAULT 'HELD',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `releasedAt` DATETIME(3) NULL,

    INDEX `ix_preorder_stock_hold_offer`(`offerId`, `status`),
    UNIQUE INDEX `uq_preorder_stock_hold_location`(`requestId`, `locationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `seller_container_loading` ADD CONSTRAINT `fk_container_loading_offer` FOREIGN KEY (`offerId`) REFERENCES `seller_offers`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_fulfilment_installments` ADD CONSTRAINT `fk_preorder_installment_request` FOREIGN KEY (`requestId`) REFERENCES `preorder_requests`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_fulfilment_installments` ADD CONSTRAINT `fk_preorder_installment_offer` FOREIGN KEY (`offerId`) REFERENCES `preorder_offers`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `preorder_stock_holds` ADD CONSTRAINT `fk_preorder_stock_hold_request` FOREIGN KEY (`requestId`) REFERENCES `preorder_requests`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;


-- CHECK constraints. The services validate each of these first and say why in
-- the buyer's or seller's language; these are the backstop.

ALTER TABLE `seller_container_loading`
  ADD CONSTRAINT `chk_container_loading_carton` CHECK (
    `piecesPerCarton` > 0 AND `cartonLengthMm` > 0 AND `cartonWidthMm` > 0
    AND `cartonHeightMm` > 0 AND `grossWeightPerCartonGrams` > 0),
  ADD CONSTRAINT `chk_container_loading_stack` CHECK (`maxStackLayers` IS NULL OR `maxStackLayers` > 0),
  ADD CONSTRAINT `chk_container_loading_pallets` CHECK (
    (`cartonsPerPallet` IS NULL OR `cartonsPerPallet` > 0)
    AND (`palletsPer20FtContainer` IS NULL OR `palletsPer20FtContainer` > 0)
    AND (`palletsPer40FtContainer` IS NULL OR `palletsPer40FtContainer` > 0)),
  ADD CONSTRAINT `chk_container_loading_20ft_pieces` CHECK (
    (`cartonsPer20FtContainer` IS NULL AND `piecesPer20FtContainer` IS NULL AND `source20Ft` IS NULL)
    OR (`cartonsPer20FtContainer` > 0 AND `source20Ft` IS NOT NULL
        AND `piecesPer20FtContainer` = `piecesPerCarton` * `cartonsPer20FtContainer`)),
  ADD CONSTRAINT `chk_container_loading_40ft_pieces` CHECK (
    (`cartonsPer40FtContainer` IS NULL AND `piecesPer40FtContainer` IS NULL AND `source40Ft` IS NULL)
    OR (`cartonsPer40FtContainer` > 0 AND `source40Ft` IS NOT NULL
        AND `piecesPer40FtContainer` = `piecesPerCarton` * `cartonsPer40FtContainer`)),
  ADD CONSTRAINT `chk_container_loading_20ft_verified` CHECK (
    `source20Ft` IS NULL OR `source20Ft` <> 'SELLER_VERIFIED' OR `verified20FtAt` IS NOT NULL),
  ADD CONSTRAINT `chk_container_loading_40ft_verified` CHECK (
    `source40Ft` IS NULL OR `source40Ft` <> 'SELLER_VERIFIED' OR `verified40FtAt` IS NOT NULL);

ALTER TABLE `preorder_policies`
  ADD CONSTRAINT `chk_preorder_policy_safety_stock` CHECK (`safetyStockBaseUnits` >= 0);

ALTER TABLE `preorder_requests`
  ADD CONSTRAINT `chk_preorder_request_base_units` CHECK (`requestedBaseUnits` = `unitQuantity` * `unitsPerPackage`),
  ADD CONSTRAINT `chk_preorder_request_container_snapshot` CHECK (
    `orderingUnit` NOT IN ('CONTAINER_20_FT', 'CONTAINER_40_FT')
    OR (`containerLoadingSnapshotJson` IS NOT NULL AND `containerLoadingVersion` IS NOT NULL)),
  ADD CONSTRAINT `chk_preorder_request_availability` CHECK (
    `shortfallAtSubmission` >= 0
    AND (`availableToPromiseAtSubmission` IS NULL OR `availableToPromiseAtSubmission` >= 0));

ALTER TABLE `preorder_offers`
  ADD CONSTRAINT `chk_preorder_offer_stock_allocation` CHECK (
    `stockAllocationBaseUnits` >= 0 AND `stockAllocationBaseUnits` <= `quantityBaseUnits`
    AND (`availableNowBaseUnits` IS NULL OR `availableNowBaseUnits` >= 0));

ALTER TABLE `preorder_fulfilment_installments`
  ADD CONSTRAINT `chk_preorder_installment_quantity` CHECK (`quantityBaseUnits` > 0 AND `sequence` >= 1);

ALTER TABLE `preorder_stock_holds`
  ADD CONSTRAINT `chk_preorder_stock_hold_quantity` CHECK (`quantityBaseUnits` > 0);
