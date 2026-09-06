-- The bell in the Admin Panel's top bar.
--
-- Separate from `notification_outbox`, which is mail leaving the building.
-- This is the in-console feed: one row per thing that happened that a member
-- of staff would want to know about without going looking for it. The first
-- and only kind at the time of writing is `order.placed`.
--
-- Why the text is not a column: the console is read in eight languages, and a
-- sentence rendered into English at write time can never be shown in any of
-- the other seven. The row stores its kind and the values that fill it
-- (`variablesJson`), and the panel renders the phrase in the reader's own
-- language from the same catalogue as the rest of the interface.
--
-- Why `requiredPermission` sits on the row rather than on the endpoint: an
-- order notification names a customer and a total, which is order.read
-- material. Carrying the grant per row keeps the bell inside the permission
-- model as new kinds are added, instead of pinning the whole feed to whatever
-- permission the first kind happened to need.

CREATE TABLE `admin_notifications` (
    `id`                 CHAR(26)     NOT NULL,

    `kind`               VARCHAR(48)  NOT NULL,
    `variablesJson`      JSON         NULL,

    `linkPath`           VARCHAR(255) NULL,
    `requiredPermission` VARCHAR(64)  NULL,

    `relatedType`        VARCHAR(48)  NULL,
    `relatedId`          CHAR(26)     NULL,

    `dedupeKey`          VARCHAR(191) NULL,

    `createdAt`          DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`),
    -- A retried checkout must not ring the bell twice.
    UNIQUE INDEX `uq_admin_notification_dedupe` (`dedupeKey`),
    -- The feed is always read newest-first, and the unread count is a filter
    -- over the same order.
    INDEX `ix_admin_notification_time` (`createdAt`),
    INDEX `ix_admin_notification_kind_time` (`kind`, `createdAt`),
    INDEX `ix_admin_notification_related` (`relatedType`, `relatedId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Read state, per person. Several members of staff share one console; one of
-- them opening the bell must not clear the badge for the others. The absence
-- of a row is "unread", so a notification created after somebody last looked
-- needs no back-fill to show up as new.
CREATE TABLE `admin_notification_reads` (
    `notificationId` CHAR(26)    NOT NULL,
    `userId`         CHAR(26)    NOT NULL,
    `readAt`         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`notificationId`, `userId`),
    INDEX `ix_admin_notification_read_user` (`userId`),

    -- Prisma's own naming convention. Written here rather than renamed by a
    -- later migration, because the migration that used to rename them runs
    -- BEFORE this one and cannot touch a table that does not exist yet.
    CONSTRAINT `admin_notification_reads_notificationId_fkey`
        FOREIGN KEY (`notificationId`) REFERENCES `admin_notifications`(`id`)
        ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT `admin_notification_reads_userId_fkey`
        FOREIGN KEY (`userId`) REFERENCES `users`(`id`)
        ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
