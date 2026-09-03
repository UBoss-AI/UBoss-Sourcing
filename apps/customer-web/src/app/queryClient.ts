/**
 * The TanStack Query client.
 *
 * Defaults chosen for a storefront:
 *
 *   - **Never retry a 4xx.** A 403 will be a 403 on the third attempt too.
 *     A 5xx or a transport failure gets two tries, because a storefront is
 *     read mostly over mobile networks where one packet loss is normal.
 *   - **Mutations never retry automatically.** A retried checkout can create a
 *     second order and a retried payment can charge twice. Retrying is the
 *     customer's decision, made once they know what happened — and when they
 *     do retry, the same idempotency key goes with it.
 *   - **Catalogue data is cached for a minute.** Prices and stock change, but
 *     not second to second, and the authoritative check happens server-side at
 *     add-to-cart and again at checkout.
 */
import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status < 500) return false;
        return failureCount < 2;
      },
      // Exponential with a ceiling, so a struggling backend is not hammered.
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
    },
    mutations: {
      retry: false,
    },
  },
});
