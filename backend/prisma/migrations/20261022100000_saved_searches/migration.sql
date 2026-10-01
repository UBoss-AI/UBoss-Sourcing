-- Saved searches: a buyer's stored sourcing criteria, with optional e-mail
-- alerts for new or repriced matching products.
CREATE TABLE `saved_searches` (
    `id` CHAR(26) NOT NULL,
    `customerProfileId` CHAR(26) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `query` VARCHAR(200) NOT NULL,
    `filters` JSON NULL,
    `alertsEnabled` BOOLEAN NOT NULL DEFAULT true,
    `lastNotifiedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ix_saved_search_customer_time`(`customerProfileId`, `createdAt`),
    INDEX `ix_saved_search_alert_due`(`alertsEnabled`, `lastNotifiedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `saved_searches`
    ADD CONSTRAINT `fk_saved_search_customer` FOREIGN KEY (`customerProfileId`) REFERENCES `customer_profiles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
