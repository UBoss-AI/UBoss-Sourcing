-- Cadences measured in calendar months.
--
-- The storefront now offers a fixed set of repeat intervals - a fortnight, a
-- month, two, three, six months and a year - and four of those cannot be
-- expressed by anything the table already held. EVERY_N_DAYS with 90 is not a
-- quarter: it is five days short of one, so a "quarterly" standing order
-- creeps backwards through the calendar and after four years is billing in a
-- different month than the customer budgeted for. A year is not 365 days for
-- the same reason, only worse, because a leap year moves it too.
--
-- So months get their own frequency and their own interval column, and the
-- day of the month is NOT stored: it comes from `startDate`. "Every three
-- months" is a choice about spacing, and the date was already settled when the
-- customer picked their first delivery. A second column saying the same thing
-- is a second column that can disagree.
--
-- The fortnight and the single month needed nothing new: they are
-- EVERY_N_DAYS with 15 and MONTHLY respectively.

-- --- The frequency ---------------------------------------------------------
--
-- Appended, not reordered. MariaDB stores an ENUM as an ordinal, so moving an
-- existing member relabels every row that holds it.
ALTER TABLE `recurring_schedules`
    MODIFY `frequency` ENUM(
        'EVERY_N_DAYS',
        'WEEKLY',
        'BIWEEKLY',
        'MONTHLY',
        'EVERY_N_MONTHS',
        'ONE_TIME'
    ) NOT NULL;

-- --- The interval ----------------------------------------------------------
--
-- NULL for every other frequency, and 2..24 for this one. The lower bound is 2
-- because 1 would be MONTHLY spelled a second way, and two storable spellings
-- of one cadence is how a screen reading a plan's own settings reports them
-- back wrongly.
ALTER TABLE `recurring_schedules`
    ADD COLUMN `intervalMonths` INTEGER NULL AFTER `monthDay`;

-- --- The frequency/field CHECK --------------------------------------------
--
-- `chk_schedule_frequency_field_present`, added in
-- `20260902143000_add_check_constraints` and restated in
-- `20260908181000_scheduled_orders_check_constraints`, names every frequency
-- and the column it depends on. A CHECK that matches no branch FAILS, so a new
-- frequency absent from it cannot be inserted at all - the constraint has to
-- be restated in full every time the enum grows.
--
-- Dropped and re-added rather than edited in place: MariaDB has no
-- ALTER CONSTRAINT, and the earlier migrations are already applied - Prisma
-- records a checksum per migration file, and rewriting an applied one makes
-- every later `migrate deploy` refuse to run.
ALTER TABLE `recurring_schedules`
    DROP CONSTRAINT `chk_schedule_frequency_field_present`;

ALTER TABLE `recurring_schedules`
    ADD CONSTRAINT `chk_schedule_frequency_field_present` CHECK (
        (`frequency` = 'EVERY_N_DAYS'   AND `intervalDays` IS NOT NULL)
        OR (`frequency` = 'WEEKLY'         AND `weekday` IS NOT NULL)
        OR (`frequency` = 'BIWEEKLY'       AND `weekday` IS NOT NULL)
        OR (`frequency` = 'MONTHLY'        AND `monthDay` IS NOT NULL)
        OR (`frequency` = 'EVERY_N_MONTHS' AND `intervalMonths` IS NOT NULL)
        OR (`frequency` = 'ONE_TIME'       AND `runOnceAt` IS NOT NULL)
    );

-- The range, as its own constraint.
--
-- Separate from the branch above because the two say different things: that
-- one refuses a plan with no interval at all, this one refuses a nonsense
-- interval. Kept out of the frequency CHECK so that a later frequency being
-- added cannot accidentally relax it.
ALTER TABLE `recurring_schedules`
    ADD CONSTRAINT `chk_schedule_interval_months_range` CHECK (
        `intervalMonths` IS NULL OR (`intervalMonths` >= 2 AND `intervalMonths` <= 24)
    );
