-- Notification resolution: an alert that leaves the bell when the problem is
-- fixed, and stays in the record forever.
--
-- THE PROBLEM THIS SOLVES
--
-- Until now a console row had exactly one piece of state: whether the person
-- looking at it had opened it. That made "I have seen this" and "this has been
-- dealt with" the same fact, which they are not. A temperature excursion that
-- somebody glanced at on Friday cleared the badge on Friday and was still in
-- the feed on Monday with nothing to say it had been closed; an exception that
-- was genuinely resolved at nine o'clock stayed in the bell until the
-- ninety-day prune took it.
--
-- WHAT IS ADDED, AND WHY EACH COLUMN IS SAFE ON A RUNNING DEPLOYMENT
--
-- Every column here is nullable or defaulted, and both defaults are chosen so
-- that a row written before this migration behaves exactly as it did the day
-- before:
--
--   * `class` defaults to INFORMATION. Every existing row - order.placed,
--     admin.signed_in, customer.registered, data_request.raised,
--     logistics.exception.raised, seller.document.uploaded - therefore keeps
--     being cleared by being read, which is what it did yesterday. The
--     services promote the kinds that are genuinely problems to ALERT; nothing
--     is back-filled, because an alert raised months ago whose problem nobody
--     recorded closing would reappear on the badge as new work.
--   * `status` defaults to ACTIVE and is only ever read for an ALERT.
--
-- THE TWO KEYS ARE NOT THE SAME KEY
--
-- `dedupeKey` already existed and is the identity of one OCCURRENCE: it is
-- what stops a retried operation ringing the bell twice. `resolutionKey` is
-- new and is the identity of the PROBLEM: it is what lets one domain event
-- close every occurrence still open about it. They are usually the same
-- string. They are not always: a payment alert is deduped on the transaction
-- that failed and resolved by any success against the ORDER, so one resolution
-- has to reach several rows.
--
-- WHY THERE IS NO `reopenedAt`
--
-- A resolved alert is history and history is not edited. A problem that comes
-- back gets a NEW row with the next `occurrence` and its own dedupe key, so
-- the resolution that was recorded stays recorded and the new occurrence is
-- actionable on its own terms. See `resolveAdminNotifications` and
-- `createAdminNotification` in
-- backend/src/modules/notifications/admin-notification.service.ts.
--
-- MARIADB 10.4 NOTES
--
--   * ENUM columns rather than CHECK constraints, matching the rest of this
--     schema and what Prisma generates for an `enum`.
--   * `resolvedByUserId` is ON DELETE SET NULL, not CASCADE. Deleting a member
--     of staff must not delete the record that an alert was closed - only the
--     name attached to it.

-- ---------------------------------------------------------------------------
-- The operator's console
-- ---------------------------------------------------------------------------

ALTER TABLE `admin_notifications`
    ADD COLUMN `class`            ENUM('INFORMATION', 'ALERT')                                   NOT NULL DEFAULT 'INFORMATION' AFTER `kind`,
    ADD COLUMN `status`           ENUM('ACTIVE', 'RESOLVED', 'ARCHIVED')                         NOT NULL DEFAULT 'ACTIVE'      AFTER `class`,
    ADD COLUMN `resolutionKey`    VARCHAR(191)                                                   NULL                           AFTER `dedupeKey`,
    ADD COLUMN `resolutionPolicy` ENUM('DOMAIN_ONLY', 'MANUAL_ALLOWED')                          NOT NULL DEFAULT 'DOMAIN_ONLY' AFTER `resolutionKey`,
    ADD COLUMN `resolvedAt`       DATETIME(3)                                                    NULL                           AFTER `resolutionPolicy`,
    ADD COLUMN `resolvedByUserId` CHAR(26)                                                       NULL                           AFTER `resolvedAt`,
    ADD COLUMN `resolutionReason` VARCHAR(512)                                                   NULL                           AFTER `resolvedByUserId`,
    ADD COLUMN `resolutionSource` ENUM('DOMAIN_EVENT', 'MANUAL', 'SYSTEM_SWEEP', 'SUPERSEDED')   NULL                           AFTER `resolutionReason`,
    ADD COLUMN `occurrence`       INT                                                            NOT NULL DEFAULT 1             AFTER `resolutionSource`;

-- The badge's own query. Leading on `class` because the two halves of the
-- active-alert rule are counted separately and only one of them looks at
-- `status` at all.
CREATE INDEX `ix_admin_notification_live` ON `admin_notifications` (`class`, `status`, `createdAt`);

-- "What is still open about this problem?" - asked by every resolution, and by
-- the reopen check before a recurrence is written.
CREATE INDEX `ix_admin_notification_resolution` ON `admin_notifications` (`resolutionKey`, `status`);

CREATE INDEX `ix_admin_notification_resolver` ON `admin_notifications` (`resolvedByUserId`);

ALTER TABLE `admin_notifications`
    ADD CONSTRAINT `admin_notifications_resolvedByUserId_fkey`
        FOREIGN KEY (`resolvedByUserId`) REFERENCES `users`(`id`)
        ON DELETE SET NULL ON UPDATE CASCADE;

-- Hiding a row for ONE reader, without claiming the problem is fixed. The
-- private half of the lifecycle: resolution lives on the notification because
-- it is a fact about the world, and this lives here because it is a fact about
-- a person.
ALTER TABLE `admin_notification_reads`
    ADD COLUMN `dismissedAt` DATETIME(3) NULL AFTER `readAt`;

-- ---------------------------------------------------------------------------
-- The carrier's console
--
-- The same lifecycle, because a carrier watching a delivery failure needs it
-- to leave their list when the delivery is re-attempted rather than when
-- somebody scrolled past it. Read state there is already a single nullable
-- column rather than a join table, because a carrier notification is addressed
-- either to one member or to the whole organisation - so there is nothing to
-- split per reader.
-- ---------------------------------------------------------------------------

ALTER TABLE `logistics_notifications`
    ADD COLUMN `class`            ENUM('INFORMATION', 'ALERT')                                 NOT NULL DEFAULT 'INFORMATION' AFTER `dedupeKey`,
    ADD COLUMN `status`           ENUM('ACTIVE', 'RESOLVED', 'ARCHIVED')                       NOT NULL DEFAULT 'ACTIVE'      AFTER `class`,
    ADD COLUMN `resolutionKey`    VARCHAR(120)                                                 NULL                           AFTER `status`,
    ADD COLUMN `resolvedAt`       DATETIME(3)                                                  NULL                           AFTER `resolutionKey`,
    ADD COLUMN `resolvedByUserId` CHAR(26)                                                     NULL                           AFTER `resolvedAt`,
    ADD COLUMN `resolutionReason` VARCHAR(512)                                                 NULL                           AFTER `resolvedByUserId`,
    ADD COLUMN `resolutionSource` ENUM('DOMAIN_EVENT', 'MANUAL', 'SYSTEM_SWEEP', 'SUPERSEDED') NULL                           AFTER `resolutionReason`;

CREATE INDEX `ix_logistics_notification_live`
    ON `logistics_notifications` (`logisticsPartnerId`, `class`, `status`, `createdAt`);

CREATE INDEX `ix_logistics_notification_resolution`
    ON `logistics_notifications` (`resolutionKey`, `status`);
