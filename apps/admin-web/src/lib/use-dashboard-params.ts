/**
 * The dashboard's state, read from and written to the URL.
 *
 * Four things live here — the reporting window, the two ends of a custom
 * range, and the selected chart segment — and all four are search parameters
 * rather than component state, so:
 *
 *   - the address bar is a shareable view of the dashboard;
 *   - Back after drilling into a segment returns to the window it was chosen
 *     from rather than to the default;
 *   - a reload lands on the same screen, which matters most on the one screen
 *     people leave open and come back to.
 *
 * `replace` on every write, deliberately. Clicking through six segments of a
 * ring should not put six entries in the history — Back from a dashboard means
 * "the page before the dashboard", and a reader who has to press it seven
 * times has been given a worse browser rather than a better chart.
 *
 * KEPT BYTE-IDENTICAL across apps/customer-web, apps/admin-web and
 * apps/logistics-web — see the note at the top of
 * components/dashboard/console.tsx.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  DEFAULT_RANGE,
  isRangeKey,
  resolveRange,
  toDateInputValue,
  type RangeKey,
  type ReportingWindow,
} from './dashboard-range';

export interface DashboardParams {
  range: RangeKey;
  /** `yyyy-mm-dd`, only meaningful while `range` is `custom`. */
  customFrom: string;
  customTo: string;
  /** The instants the API is asked for. */
  window: ReportingWindow;
  /** The selected segment's status key, or null. */
  segment: string | null;
  /**
   * One person's work, where the dashboard offers that.
   *
   * Only the carrier portal uses it today - a dispatcher narrowing every
   * figure to one driver - and it lives here rather than in that page so the
   * three copies of this hook stay identical. An app that never calls
   * `setDriver` simply never has the parameter.
   */
  driverId: string | null;
  setRange: (key: RangeKey) => void;
  setCustomRange: (from: string, to: string) => void;
  setSegment: (id: string | null) => void;
  setDriver: (id: string | null) => void;
}

const RANGE_PARAM = 'range';
const FROM_PARAM = 'from';
const TO_PARAM = 'to';
const SEGMENT_PARAM = 'segment';
const DRIVER_PARAM = 'driver';

export function useDashboardParams(): DashboardParams {
  const [params, setParams] = useSearchParams();

  const rangeParam = params.get(RANGE_PARAM);
  const range: RangeKey = isRangeKey(rangeParam) ? rangeParam : DEFAULT_RANGE;

  const customFrom = params.get(FROM_PARAM) ?? '';
  const customTo = params.get(TO_PARAM) ?? '';
  const segment = params.get(SEGMENT_PARAM);
  const driverId = params.get(DRIVER_PARAM);

  /*
   * The window is resolved once per render against `new Date()`.
   *
   * That makes it a new pair of instants on every render, and a React Query
   * key built from it would therefore change on every render and refetch for
   * ever. So the memo is keyed on the PARAMETERS rather than on the resolved
   * window: same range and same custom dates, same window object, stable key.
   *
   * The consequence is that a dashboard left open overnight keeps yesterday's
   * "now" as the end of its window until something re-renders it. That is the
   * right trade — the alternative is a page that silently refetches itself for
   * ever — and the refresh button, the poll and any filter change all move it
   * forward.
   */
  const window = useMemo(
    () => resolveRange(range, new Date(), { from: customFrom, to: customTo }),
    [range, customFrom, customTo],
  );

  const setRange = useCallback(
    (key: RangeKey) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set(RANGE_PARAM, key);

          if (key === 'custom') {
            // Seed the fields with the last 30 days, so the panel opens on a
            // usable pair rather than two empty inputs and no chart.
            if (next.get(FROM_PARAM) === null) {
              next.set(FROM_PARAM, toDateInputValue(new Date(Date.now() - 30 * 86_400_000)));
            }
            if (next.get(TO_PARAM) === null) next.set(TO_PARAM, toDateInputValue(new Date()));
          } else {
            // A named window has no custom dates. Leaving them in the URL
            // would mean a link shared from "Last 7 days" carried a stale pair
            // that reappeared the moment the recipient clicked Custom.
            next.delete(FROM_PARAM);
            next.delete(TO_PARAM);
          }

          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const setCustomRange = useCallback(
    (from: string, to: string) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set(RANGE_PARAM, 'custom');
          next.set(FROM_PARAM, from);
          next.set(TO_PARAM, to);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const setSegment = useCallback(
    (id: string | null) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (id === null) next.delete(SEGMENT_PARAM);
          else next.set(SEGMENT_PARAM, id);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const setDriver = useCallback(
    (id: string | null) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (id === null) next.delete(DRIVER_PARAM);
          else next.set(DRIVER_PARAM, id);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  return {
    range,
    customFrom,
    customTo,
    window,
    segment,
    driverId,
    setRange,
    setCustomRange,
    setSegment,
    setDriver,
  };
}
