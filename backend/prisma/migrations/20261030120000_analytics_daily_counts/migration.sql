-- Privacy-first product analytics: per-day aggregate counters, no identifiers.
CREATE TABLE `analytics_daily_counts` (
    `day` DATE NOT NULL,
    `event` VARCHAR(48) NOT NULL,
    `screen` VARCHAR(96) NOT NULL,
    `surface` VARCHAR(16) NOT NULL,
    `count` INTEGER NOT NULL DEFAULT 0,

    INDEX `ix_analytics_day_surface`(`day`, `surface`),
    PRIMARY KEY (`day`, `event`, `screen`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
