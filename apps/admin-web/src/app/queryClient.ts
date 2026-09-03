/**
 * The TanStack Query client.
 *
 * Two defaults are deliberate:
 *
 *   - **Never retry a 4xx.** A 403 will be a 403 on the third attempt too;
 *     retrying only delays the message and triples the audit noise. A 5xx or a
 *     transport failure is worth one retry.
 *   - **Nothing is stale-while-you-look-away for long.** An admin panel shows
 *     stock levels and order statuses that other people are changing. Thirty
 *     seconds is short enough that a refocus catches up, long enough that
 *     tabbing between windows does not hammer the API.
 */
import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 1;
      },
    },
    mutations: {
      // A mutation retried automatically can double-charge, double-ship or
      // double-import. Retrying is the user's decision, made once they know
      // what happened.
      retry: false,
    },
  },
});
