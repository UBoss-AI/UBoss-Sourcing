/**
 * The first delivery date a fixture may ask for.
 *
 * A schedule's first delivery needs notice - `SCHEDULE_MIN_NOTICE_DAYS`, seven
 * by default - so a fixture that asks for tomorrow is now refused, and
 * rightly. What is less obvious is that **no anchor in the past can satisfy
 * the rule either**: a weekly plan's next slot is never more than seven days
 * away, so "start it yesterday and let the cadence roll forward" lands inside
 * the window however far back the anchor is put. Every schedule fixture
 * therefore starts on the first date the rule allows, and the ones that
 * exercise the worker force the row due afterwards, exactly as they did
 * before.
 *
 * The floor is computed here the same way the server computes it rather than
 * hard-coded as "today plus seven". Two reasons, and both have bitten this
 * suite's neighbours before:
 *
 *   - **The zone matters.** `new Date().toISOString().slice(0, 10)` is the UTC
 *     day, and the rule is counted on the customer's. For a store in
 *     Asia/Calcutta those are different days for five and a half hours out of
 *     every twenty-four, which is a test that fails overnight and passes by
 *     the time anybody looks at it.
 *   - **The notice period is a setting.** A deployment that sets it to three
 *     should not have to edit three test files, and one that sets it to zero
 *     should not find the suite asserting a week's notice that no longer
 *     exists.
 */
import { env } from '../../src/config/env.js';
import { addCalendarDays, earliestDeliveryDay } from '../../src/domain/delivery-dates.js';
import { prisma } from '../../src/infra/prisma.js';

/**
 * The earliest first-delivery date a plan may be created with, as YYYY-MM-DD.
 *
 * Pass the plan's own timezone where the fixture sets one - the server
 * resolves the floor against the delivery address's zone first, the plan's
 * second and the store's third, and a fixture whose address carries no zone
 * (which is all of them) falls through to the plan's.
 */
export async function earliestFirstDelivery(timezone?: string): Promise<string> {
  const business =
    timezone === undefined
      ? await prisma.businessProfile.findFirst({ select: { timezone: true } })
      : null;

  return earliestDeliveryDay({
    timezone: timezone ?? business?.timezone ?? env.DEFAULT_TIMEZONE,
    noticeDays: env.SCHEDULE_MIN_NOTICE_DAYS,
  });
}

/** A date safely inside the allowed window - the floor plus a few days. */
export async function afterEarliestFirstDelivery(
  extraDays: number,
  timezone?: string,
): Promise<string> {
  return addCalendarDays(await earliestFirstDelivery(timezone), extraDays);
}

/** The day before the floor: the latest date the rule refuses. */
export async function justTooSoon(timezone?: string): Promise<string> {
  return addCalendarDays(await earliestFirstDelivery(timezone), -1);
}
