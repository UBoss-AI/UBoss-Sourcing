-- A buyer company's own requestor -> approver -> finance sign-off before an
-- order can be paid.
--
-- Two new tables. Off for every company until its owner or administrator
-- switches the policy on, so nothing changes for anybody until then.

CREATE TABLE `buyer_company_approval_policies` (
    `id` CHAR(26) NOT NULL,
    `companyId` CHAR(26) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `currency` CHAR(3) NOT NULL,
    `approverThresholdMinor` BIGINT NOT NULL DEFAULT 0,
    `financeThresholdMinor` BIGINT NULL,
    `updatedByUserId` CHAR(26) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `uq_buyer_company_approval_policy`(`companyId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `chk_buyer_company_approval_thresholds` CHECK (
        `approverThresholdMinor` >= 0
        AND (`financeThresholdMinor` IS NULL OR `financeThresholdMinor` >= `approverThresholdMinor`)
    )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `buyer_company_order_approvals` (
    `id` CHAR(26) NOT NULL,
    `orderId` CHAR(26) NOT NULL,
    `companyId` CHAR(26) NOT NULL,
    `stage` ENUM('APPROVER', 'FINANCE') NOT NULL,
    `decision` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `amountMinor` BIGINT NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `requestedByUserId` CHAR(26) NOT NULL,
    `decidedByUserId` CHAR(26) NULL,
    `decidedAt` DATETIME(3) NULL,
    `reason` VARCHAR(1000) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `uq_buyer_company_order_approval_stage`(`orderId`, `stage`),
    INDEX `ix_buyer_company_order_approval_queue`(`companyId`, `decision`, `createdAt`),
    PRIMARY KEY (`id`),
    -- Nobody signs off an order they placed. The service refuses it first;
    -- this is the backstop.
    CONSTRAINT `chk_buyer_company_approval_not_self` CHECK (
        `decidedByUserId` IS NULL OR `decidedByUserId` <> `requestedByUserId`
    )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `buyer_company_approval_policies`
    ADD CONSTRAINT `fk_buyer_company_approval_policy_company` FOREIGN KEY (`companyId`)
        REFERENCES `buyer_companies`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE `buyer_company_order_approvals`
    ADD CONSTRAINT `fk_buyer_company_order_approval_order` FOREIGN KEY (`orderId`)
        REFERENCES `orders`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT,
    ADD CONSTRAINT `fk_buyer_company_order_approval_company` FOREIGN KEY (`companyId`)
        REFERENCES `buyer_companies`(`id`) ON DELETE CASCADE ON UPDATE RESTRICT;
