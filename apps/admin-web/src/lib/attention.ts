/**
 * What is still waiting, for the badges on the navigation rail.
 *
 * One query for the whole panel. Every screen in the console renders the
 * sidebar, so a per-row fetch would be eight requests on every page load for
 * eight numbers that come out of one endpoint - and React Query de-duplicates
 * this one across every component that asks for it.
 *
 * Deliberately NOT the notification bell. The bell says what happened and is
 * cleared by reading it; these are things that are still sitting in a queue and
 * are cleared only by somebody deciding them. A count here that went down
 * because a colleague glanced at the panel would be a lie.
 */
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { api } from './api';

/**
 * The queues a badge can be drawn for.
 *
 * Mirrors `AttentionKey` in
 * backend/src/modules/notifications/attention.service.ts. A key the signed-in
 * user lacks the grant for is ABSENT from the response rather than zero, so
 * every read here has to cope with `undefined`.
 */
export type AttentionKey =
  | 'sellerApplications'
  | 'sellerDocuments'
  | 'listingReview'
  | 'brandRequests'
  | 'orderApprovals'
  | 'customerApprovals'
  | 'dataRequests'
  | 'logisticsExceptions';

export interface AttentionView {
  counts: Partial<Record<AttentionKey, number>>;
  /** Every count the caller can see, added up. */
  total: number;
}

export const ATTENTION_QUERY_KEY = ['console-attention'] as const;

/**
 * How often the badges refresh themselves.
 *
 * A minute, and only while the tab is in front - the same cadence and the same
 * reasoning as the bell. A queue that grew ten seconds ago is worth knowing
 * about within the minute, and this poll runs on every screen in the panel, so
 * anything tighter multiplies into real load on a self-hosted box for no
 * operational gain.
 */
const POLL_INTERVAL_MS = 60_000;

export function useAttention(): UseQueryResult<AttentionView> {
  return useQuery({
    queryKey: ATTENTION_QUERY_KEY,
    queryFn: () => api.get<AttentionView>('/admin/attention'),
    refetchInterval: POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
    // The rail is chrome. A failed count must leave the navigation working
    // with no badges rather than throwing into whatever page is rendering it.
    retry: 1,
  });
}
