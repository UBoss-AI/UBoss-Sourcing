/**
 * Loads the public storefront config once and shares it.
 *
 * Rendered around the whole app, above the router, so the header can name the
 * business before any route resolves. It never blocks: children render with
 * the fallback while the request is in flight, because a spinner covering the
 * entire site while a branding call completes is a worse first impression than
 * a neutral name for 200ms.
 *
 * It also hands the marketplace's own name to the translator, which fills
 * `{{marketplace}}` in every catalogue string with it - see
 * `setMarketplaceName`. That is `marketplace.displayName`, not
 * `business.displayName`: on a seller's shop front the second is the seller.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, type ReactNode } from 'react';
import { setChatTeamName, setMarketplaceName } from '@/i18n/config';
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

  const marketplaceName = query.data?.marketplace?.displayName;
  const chatTeamName = query.data?.marketplace?.chatTeamName;
  useEffect(() => {
    // The store's name first: the team's falls back to it.
    setMarketplaceName(marketplaceName);
    setChatTeamName(chatTeamName);
  }, [marketplaceName, chatTeamName]);

  return (
    <StorefrontContext.Provider value={query.data ?? FALLBACK_CONFIG}>
      {children}
    </StorefrontContext.Provider>
  );
}
