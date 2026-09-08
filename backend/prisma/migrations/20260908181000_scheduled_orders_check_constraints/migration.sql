-- Teach the frequency invariant about BIWEEKLY and ONE_TIME.
--
-- `chk_schedule_frequency_field_present`, added in
-- `20260902143000_add_check_constraints`, requires that the column a frequency
-- depends on is actually populated - a WEEKLY plan with no weekday would
-- otherwise be storable and then fail every time the engine tried to compute
-- its next run.
--
-- The constraint predates the two frequencies added by
-- `20260908180000_scheduled_orders_and_subscriptions`, so it rejected both:
-- neither BIWEEKLY nor ONE_TIME appeared in any of its three branches, and a
-- CHECK that matches no branch fails. This restates it with all five.
--
-- A separate migration rather than an edit to that one, because it has already
-- been applied - Prisma records a checksum per migration, and rewriting an
-- applied file makes every later `migrate deploy` refuse to run.
--
-- The two new branches:
--
--   BIWEEKLY needs `weekday`, exactly as WEEKLY does. It is anchored to the
--   start date's week parity, but the weekday itself is still what it fires on.
--
--   ONE_TIME needs `runOnceAt` rather than any of the recurrence columns. It
--   has no pattern - it has a date - and requiring the instant is what stops a
--   Buy Later being stored with nothing to fire on. The three recurrence
--   columns are all NULL for one, which is why it cannot simply be added to an
--   existing branch.

ALTER TABLE `recurring_schedules`
    DROP CONSTRAINT `chk_schedule_frequency_field_present`;

ALTER TABLE `recurring_schedules`
    ADD CONSTRAINT `chk_schedule_frequency_field_present` CHECK (
        (`frequency` = 'EVERY_N_DAYS' AND `intervalDays` IS NOT NULL)
        OR (`frequency` = 'WEEKLY'   AND `weekday` IS NOT NULL)
        OR (`frequency` = 'BIWEEKLY' AND `weekday` IS NOT NULL)
        OR (`frequency` = 'MONTHLY'  AND `monthDay` IS NOT NULL)
        OR (`frequency` = 'ONE_TIME' AND `runOnceAt` IS NOT NULL)
    );

-- A one-shot plan is capped at a single delivery.
--
-- `createSchedule` sets `maxOccurrences` to 1 for ONE_TIME and the engine
-- completes the plan the moment its occurrence finishes, so this records an
-- invariant the application already keeps rather than imposing a new one. It is
-- here because "Buy Later delivered eleven times" is the kind of bug that is
-- only funny until it happens.
ALTER TABLE `recurring_schedules`
    ADD CONSTRAINT `chk_schedule_one_time_single_occurrence` CHECK (
        `frequency` <> 'ONE_TIME' OR `maxOccurrences` = 1
    );
