/**
 * How soon a standing order may be asked to deliver.
 *
 * One rule, in one place, because three screens and two services ask it: the
 * schedule builder, the schedule workspace, creation from a cart, the plan
 * editor and the preview endpoint. A rule implemented five times is a rule
 * that will eventually be four rules.
 *
 * THE RULE
 *
 *     earliest = max( today + SCHEDULE_MIN_NOTICE_DAYS,
 *                     the chosen warehouse's own soonest delivery )
 *
 * Both halves are real and neither overrides the other. The notice period is
 * what the business promises itself - the basket is repriced and revalidated,
 * stock is reserved, a card charge or a payment link has to clear - and the
 * warehouse figure is what the building and the carrier actually allow. A
 * picker enforcing only the first would let somebody choose a Tuesday the
 * warehouse cannot reach until the Thursday.
 *
 * WHOSE TODAY
 *
 * The customer's, resolved most-specific-first: the delivery address's own
 * IANA zone, then the plan's, then the store's. **Never the server's.** At
 * 03:00 in Asia/Calcutta it is still yesterday in Europe/Brussels, and a rule
 * that says "seven days from today" has to mean the buyer's today or it is
 * quietly a different rule for a third of the world.
 *
 * COUNTED IN CALENDAR DAYS
 *
 * Not `Date.now() + 7 * 86_400_000`. That is 168 hours, and the seventh day
 * forward is 167 or 169 of them across a DST boundary - so twice a year the
 * milliseconds version lands on the wrong date, in the direction nobody
 * tests. See `domain/delivery-dates.ts`.
 *
 * WHAT IT DOES NOT DO
 *
 * It never touches an occurrence that already exists, and it is never applied
 * retroactively to a plan already running. A plan created last year with a
 * start date the rule would refuse today is a plan somebody agreed to; the
 * rule governs what may be *asked for*, at creation and when a first delivery
 * is re-dated. Nothing in this file, and no migration that came with it,
 * cancels or re-dates an existing schedule.
 */
import { env } from '../../config/env.js';
import {
  earliestDeliveryDay,
  effectiveEarliestDelivery,
  resolveTimezone,
  type CalendarDay,
} from '../../domain/delivery-dates.js';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import { earliestDeliveryFromWarehouse } from '../fulfilment/warehouse-options.service.js';

export interface NoticeContext {
  /** The plan's own zone, as stored or as the caller is about to store it. */
  scheduleTimezone: string;
  /** Where it is going. Used for its zone, its country and its postcode. */
  shippingAddressId: string;
  customerProfileId: string;
  /** FIXED_LOCATION plus a warehouse is what brings the second floor in. */
  fulfilmentRule: 'AUTO' | 'FIXED_LOCATION';
  inventoryLocationId: string | null;
  now?: Date;
}

export interface NoticeFloor {
  /** `today + SCHEDULE_MIN_NOTICE_DAYS`, on the customer's clock. */
  noticeFloor: CalendarDay;
  /** The warehouse's own soonest, or null when none was chosen or found. */
  warehouseEarliest: CalendarDay | null;
  /** The later of the two - the date the API will actually enforce. */
  earliest: CalendarDay;
  /** The zone all of the above was counted in, so a message can name it. */
  timezone: string;
  /** The configured notice period, so a message can name that too. */
  noticeDays: number;
}

/**
 * Work out the floor without applying it.
 *
 * Exported separately from the assertion because the storefront asks for the
 * number - the picker greys out everything below it and says the rule in
 * words - and a screen that could only discover the floor by submitting a
 * date and being refused is a screen that refuses rather than helps.
 */
export async function deliveryNoticeFloor(context: NoticeContext): Promise<NoticeFloor> {
  const now = context.now ?? new Date();

  const [address, business] = await Promise.all([
    prisma.address.findFirst({
      // Scoped by the customer, like every other address read on this side of
      // the API: another buyer's address simply does not match.
      where: {
        id: context.shippingAddressId,
        customerProfileId: context.customerProfileId,
        archivedAt: null,
      },
      select: { country: true, postalCode: true, timezone: true },
    }),
    prisma.businessProfile.findFirst({ select: { timezone: true } }),
  ]);

  const timezone = resolveTimezone(
    address?.timezone,
    context.scheduleTimezone,
    business?.timezone,
  );

  const noticeDays = env.SCHEDULE_MIN_NOTICE_DAYS;
  const noticeFloor = earliestDeliveryDay({ timezone, noticeDays, now });

  /*
   * The warehouse's own floor, and only when one was actually chosen.
   *
   * An AUTO plan has no warehouse yet - the engine picks one at run time from
   * whatever holds the stock that week - so there is nothing to measure and
   * the notice period stands alone. Inventing a floor from "the slowest
   * warehouse we have" would hold every AUTO plan to the worst lane in the
   * business for a decision nobody has made.
   */
  const warehouseEarliest =
    context.fulfilmentRule === 'FIXED_LOCATION' &&
    context.inventoryLocationId !== null &&
    address !== null
      ? await earliestDeliveryFromWarehouse({
          locationId: context.inventoryLocationId,
          countryCode: address.country,
          postalCode: address.postalCode.trim().length === 0 ? null : address.postalCode.trim(),
          fallbackTimezone: timezone,
          now,
        })
      : null;

  return {
    noticeFloor,
    warehouseEarliest,
    earliest: effectiveEarliestDelivery(noticeFloor, warehouseEarliest),
    timezone,
    noticeDays,
  };
}

/**
 * Refuse a first delivery inside the notice period.
 *
 * **The date checked is the first DELIVERY, not the plan's start date**, and
 * on a recurring plan those are different things. `startDate` is the anchor
 * a cadence counts from: "monthly, on the 9th" is stored as a start date, and
 * a plan whose anchor is last March is an ordinary plan rather than one
 * eleven months overdue. What a buyer actually chooses - and what this rule
 * governs - is when the first box arrives, which is
 * `nextRunAt(rule, startDate)` resolved into a calendar day on the plan's
 * own clock. For the storefront the two coincide, because the picker sets the
 * anchor to the first delivery; for an API caller anchoring in the past they
 * do not, and checking the anchor would refuse a plan whose first delivery is
 * six weeks away.
 *
 * Its own error code - `SCHEDULE_DATE_TOO_SOON` - rather than reusing
 * `SCHEDULE_DATE_IN_PAST`, because the two need different words in front of a
 * person: "that day has gone" and "we need a week" are different problems
 * with different fixes, and a customer told the wrong one will retry the
 * wrong thing.
 *
 * The detail carries `earliest` as a `YYYY-MM-DD` calendar day so the picker
 * can jump straight to it. A refusal that leaves somebody clicking forward to
 * find the first acceptable date is a refusal that made them do the server's
 * arithmetic.
 *
 * **This is the backstop, not the rule's only home.** The calendar greys the
 * closed days out and says the rule under the grid; this is what answers a
 * payload that never went past a browser. Both are needed: one is a courtesy
 * and the other is the guarantee.
 */
export async function assertDeliveryNotice(
  firstDeliveryDate: CalendarDay,
  context: NoticeContext,
): Promise<NoticeFloor> {
  const floor = await deliveryNoticeFloor(context);

  // `YYYY-MM-DD` compares correctly as a plain string - see the header of
  // `domain/delivery-dates.ts`.
  if (firstDeliveryDate >= floor.earliest) return floor;

  const message =
    floor.warehouseEarliest !== null && floor.warehouseEarliest > floor.noticeFloor
      ? `The warehouse you chose cannot deliver before ${floor.earliest}. Choose that date or a later one.`
      : `The first delivery needs ${String(floor.noticeDays)} days' notice. The earliest we can take is ${floor.earliest}.`;

  throw badRequest(ErrorCode.SCHEDULE_DATE_TOO_SOON, message, [
    {
      field: 'startDate',
      code: 'TOO_SOON',
      meta: {
        earliest: floor.earliest,
        noticeFloor: floor.noticeFloor,
        warehouseEarliest: floor.warehouseEarliest,
        noticeDays: floor.noticeDays,
        timezone: floor.timezone,
      },
    },
  ]);
}
