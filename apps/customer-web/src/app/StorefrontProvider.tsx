/**
 * Loads the public storefront config once and shares it.
 *
 * Rendered around the whole app, above the router, so the header can name the
 * business before any route resolves. It never blocks: children render with
 * the fallback while the request is in flight, because a spinner covering the
 * entire site while a branding call completes is a worse first impression than
 * a neutral name for 200ms.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import type { StorefrontConfig } from '@/lib/types';
import { FALLBACK_CONFIG, StorefrontContext } from './storefront-context';

export function StorefrontProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const query = useQuery({
    queryKey: ['storefront-config'],
    queryFn: () => api.get<StorefrontConfig>('/config'),
    // The server already sets a cache header; this keeps a tab from re-asking
    // on every focus for something that changes about once a year.
    staleTime: 5 * 60_000,
    retry: 1,
  });

  return (
    <StorefrontContext.Provider value={query.data ?? FALLBACK_CONFIG}>
      {children}
    </StorefrontContext.Provider>
  );
}
