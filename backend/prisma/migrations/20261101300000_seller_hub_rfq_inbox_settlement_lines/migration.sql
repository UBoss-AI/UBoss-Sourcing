-- JOURNEY-030 and JOURNEY-034: the seller's RFQ inbox and the settlement
-- statement's own deduction kinds.
--
-- rfq_invitations: a seller may hide an invitation that is not for them
--   (hiddenAt, hiddenByMemberId) and give it to one member of their team
--   (assignedMemberId, assignedAt). The member is validated against the
--   seller's own team by the service; no foreign key, so removing a member
--   leaves the history readable.
-- seller_settlement_lines.kind: gains INSPECTION_FEE, LOGISTICS_CHARGE and
--   COMMISSION_TAX (listed with every value, in order, as MariaDB's MODIFY
--   requires).
-- seller_settlement_lines.sourceRef: the record a deduction came from (an
--   inspection invoice id), unique per kind, so the same invoice is never
--   deducted twice across statements. NULL for every other line; a UNIQUE
--   index treats each NULL as distinct.
--
-- Rollback: drop uq_seller_settlement_line_source and sourceRef, MODIFY
-- seller_settlement_lines.kind back without the three new values (after
-- deleting or re-labelling any rows of those kinds), and drop the four
-- rfq_invitations columns and ix_rfq_invitation_assignee.

-- AlterTable
ALTER TABLE `rfq_invitations`
    ADD COLUMN `hiddenAt` DATETIME(3) NULL,
    ADD COLUMN `hiddenByMemberId` CHAR(26) NULL,
    ADD COLUMN `assignedMemberId` CHAR(26) NULL,
    ADD COLUMN `assignedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `ix_rfq_invitation_assignee` ON `rfq_invitations`(`sellerAccountId`, `assignedMemberId`);

-- AlterTable
ALTER TABLE `seller_settlement_lines` MODIFY `kind` ENUM('SALE', 'COMMISSION', 'PROCESSING_FEE', 'REFUND', 'RETURN_DEDUCTION', 'SHIPPING_CHARGE', 'MANUAL_ADJUSTMENT', 'INSPECTION_FEE', 'LOGISTICS_CHARGE', 'COMMISSION_TAX') NOT NULL;

-- AlterTable
ALTER TABLE `seller_settlement_lines` ADD COLUMN `sourceRef` VARCHAR(64) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `uq_seller_settlement_line_source` ON `seller_settlement_lines`(`kind`, `sourceRef`);
