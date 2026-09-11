/**
 * The earliest day a schedule's first delivery may be, asked of the server.
 *
 * `schedule-cadence.ts` can already work out `today + noticeDays`, and for a
 * long time that was the whole rule. It is not, and the two places it falls
 * short are both places a buyer would be shown a date the API then refuses:
 *
 *   - **Whose today?** The floor is counted on the delivery address's own
 *     IANA zone where it has one, and only then on the schedule's or the
 *     store's. A buyer in Kolkata sending to a site in Rotterdam is on two
 *     different days at once for four and a half hours out of every
 *     twenty-four, and the browser knows only one of them.
 *   - **The warehouse has a floor too.** A plan pinned to one warehouse
 *     cannot arrive sooner than that warehouse's own lane allows, and the
 *     enforced date is `max(today + noticeDays, warehouse earliest)`. Nothing
 *     in the browser knows the lanes.
 *
 * So the screen asks. The local calculation stays as the value the picker
 * opens with and falls back to — an unreachable endpoint must not leave a
 * calendar with no floor at all, and the notice period is the larger part of
 * the answer in every ordinary case.
 *
 * **This draws the rule; it does not enforce it.** `createSchedule` and
 * `updateSchedule` refuse a date inside the window whatever the browser did
 * with this, which is what makes bypassing the picker pointless rather than
 * profitable.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface DeliveryWindow {
  /** `today + the deployment's notice period`, on the customer's clock. */
  noticeFloor: string;
  /** The pinned warehouse's own soonest, or null when the plan is AUTO. */
  warehouseEarliest: string | null;
  /** The later of the two — the date the API will actually enforce. */
  earliest: string;
  /** The zone all of the above was counted in, so a message can name it. */
  timezone: string;
  /** The configured notice period, so a message can name that too. */
  noticeDays: number;
}

export interface DeliveryWindowRequest {
  shippingAddressId: string | null;
  /** The plan's own zone, when the screen lets the buyer set one. */
  timezone?: string;
  fulfilmentRule?: 'AUTO' | 'FIXED_LOCATION';
  inventoryLocationId?: string | null;
}

function pathFor(request: DeliveryWindowRequest): string {
  const params = new URLSearchParams({ shippingAddressId: request.shippingAddressId ?? '' });

  if (request.timezone !== undefined) params.set('timezone', request.timezone);
  if (request.fulfilmentRule !== undefined) params.set('fulfilmentRule', request.fulfilmentRule);
  if (request.inventoryLocationId !== undefined && request.inventoryLocationId !== null) {
    params.set('inventoryLocationId', request.inventoryLocationId);
  }

  return `/recurring-schedules/delivery-window?${params.toString()}`;
}

/**
 * The server's floor for one address, or null while there is none to have.
 *
 * Null covers both "no address chosen yet" and "the ask failed", and the
 * caller treats them the same way: fall back to the local notice period. A
 * calendar that greys out nothing because a request failed would be worse
 * than one greying out slightly the wrong fortnight.
 *
 * Not cached for long. The floor moves at midnight in the customer's own
 * zone, and a held answer is a calendar offering a day that has just closed.
 */
export function useDeliveryWindow(request: DeliveryWindowRequest): DeliveryWindow | null {
  const query = useQuery({
    queryKey: [
      'delivery-window',
      request.shippingAddressId,
      request.timezone ?? null,
      request.fulfilmentRule ?? null,
      request.inventoryLocationId ?? null,
    ],
    queryFn: () => api.get<DeliveryWindow>(pathFor(request)),
    enabled: request.shippingAddressId !== null,
    staleTime: 60 * 1000,
    retry: false,
  });

  return query.data ?? null;
}
