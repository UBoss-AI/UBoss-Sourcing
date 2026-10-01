-- Master data (Master row 75): units of measure, Incoterms and inspection
-- defect codes an administrator maintains, beside the categories and
-- currencies that already have their own tables.
CREATE TABLE `master_data_entries` (
    `id` CHAR(26) NOT NULL,
    `kind` ENUM('UOM', 'INCOTERM', 'DEFECT_CODE') NOT NULL,
    `code` VARCHAR(16) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `description` VARCHAR(500) NULL,
    `defaultSeverity` ENUM('CRITICAL', 'MAJOR', 'MINOR') NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_master_data_kind_code`(`kind`, `code`),
    INDEX `ix_master_data_kind_order`(`kind`, `isActive`, `sortOrder`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `master_data_entries` (`id`, `kind`, `code`, `name`, `defaultSeverity`, `sortOrder`) VALUES
    ('01KMDINC000000000000000EXW', 'INCOTERM', 'EXW', 'Ex Works', NULL, 0),
    ('01KMDINC000000000000000FCA', 'INCOTERM', 'FCA', 'Free Carrier', NULL, 10),
    ('01KMDINC000000000000000FAS', 'INCOTERM', 'FAS', 'Free Alongside Ship', NULL, 20),
    ('01KMDINC000000000000000FOB', 'INCOTERM', 'FOB', 'Free On Board', NULL, 30),
    ('01KMDINC000000000000000CFR', 'INCOTERM', 'CFR', 'Cost and Freight', NULL, 40),
    ('01KMDINC000000000000000CIF', 'INCOTERM', 'CIF', 'Cost, Insurance and Freight', NULL, 50),
    ('01KMDINC000000000000000CPT', 'INCOTERM', 'CPT', 'Carriage Paid To', NULL, 60),
    ('01KMDINC000000000000000CIP', 'INCOTERM', 'CIP', 'Carriage and Insurance Paid To', NULL, 70),
    ('01KMDINC000000000000000DAP', 'INCOTERM', 'DAP', 'Delivered At Place', NULL, 80),
    ('01KMDINC000000000000000DPU', 'INCOTERM', 'DPU', 'Delivered at Place Unloaded', NULL, 90),
    ('01KMDINC000000000000000DDP', 'INCOTERM', 'DDP', 'Delivered Duty Paid', NULL, 100),
    ('01KMDUOM0000000000000000EA', 'UOM', 'EA', 'Each', NULL, 0),
    ('01KMDUOM000000000000000PCS', 'UOM', 'PCS', 'Pieces', NULL, 10),
    ('01KMDUOM0000000000000000PR', 'UOM', 'PR', 'Pair', NULL, 20),
    ('01KMDUOM0000000000000000DZ', 'UOM', 'DZ', 'Dozen', NULL, 30),
    ('01KMDUOM000000000000000SET', 'UOM', 'SET', 'Set', NULL, 40),
    ('01KMDUOM000000000000000BOX', 'UOM', 'BOX', 'Box', NULL, 50),
    ('01KMDUOM0000000000000000PK', 'UOM', 'PK', 'Pack', NULL, 60),
    ('01KMDUOM000000000000000CTN', 'UOM', 'CTN', 'Carton', NULL, 70),
    ('01KMDUOM000000000000000PAL', 'UOM', 'PAL', 'Pallet', NULL, 80),
    ('01KMDUOM000000000000000ROL', 'UOM', 'ROL', 'Roll', NULL, 90),
    ('01KMDUOM0000000000000000KG', 'UOM', 'KG', 'Kilogram', NULL, 100),
    ('01KMDUOM00000000000000000G', 'UOM', 'G', 'Gram', NULL, 110),
    ('01KMDUOM00000000000000000L', 'UOM', 'L', 'Litre', NULL, 120),
    ('01KMDUOM0000000000000000ML', 'UOM', 'ML', 'Millilitre', NULL, 130),
    ('01KMDUOM00000000000000000M', 'UOM', 'M', 'Metre', NULL, 140),
    ('01KMDUOM0000000000000000M2', 'UOM', 'M2', 'Square metre', NULL, 150),
    ('01KMDUOM0000000000000000M3', 'UOM', 'M3', 'Cubic metre', NULL, 160),
    ('01KMDDEF000000000000000FUN', 'DEFECT_CODE', 'FUN', 'Functional failure', 'CRITICAL', 0),
    ('01KMDDEF000000000000000SAF', 'DEFECT_CODE', 'SAF', 'Safety hazard', 'CRITICAL', 10),
    ('01KMDDEF000000000000000CON', 'DEFECT_CODE', 'CON', 'Contamination', 'CRITICAL', 20),
    ('01KMDDEF000000000000000DIM', 'DEFECT_CODE', 'DIM', 'Dimension out of tolerance', 'MAJOR', 30),
    ('01KMDDEF000000000000000MIS', 'DEFECT_CODE', 'MIS', 'Missing component', 'MAJOR', 40),
    ('01KMDDEF000000000000000LBL', 'DEFECT_CODE', 'LBL', 'Labelling error', 'MAJOR', 50),
    ('01KMDDEF000000000000000PKG', 'DEFECT_CODE', 'PKG', 'Packaging damage', 'MINOR', 60),
    ('01KMDDEF000000000000000COS', 'DEFECT_CODE', 'COS', 'Cosmetic blemish', 'MINOR', 70);

-- Notification templates (Master row 76): WhatsApp and in-app become
-- configurable channels beside email and SMS.
ALTER TABLE `notification_settings`
    ADD COLUMN `whatsappEnabled` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `inAppEnabled` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `whatsappTemplate` TEXT NULL;

ALTER TABLE `notification_outbox`
    MODIFY `channel` ENUM('EMAIL', 'SMS', 'WHATSAPP', 'IN_APP') NOT NULL DEFAULT 'EMAIL';
