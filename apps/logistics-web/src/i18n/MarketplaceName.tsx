/**
 * Hands the marketplace's own name to the translator.
 *
 * Every buyer of this software runs their own marketplace under their own
 * name, so a sentence such as "Contact Northwind operations" carries
 * `{{marketplace}}` in the catalogue instead of a name, and this fills it from
 * `GET /config` - `marketplace.displayName`, from the operator's business
 * profile. See `setMarketplaceName` for why it is a default variable rather
 * than an option at each call site.
 *
 * `/config` is public, so this runs on the sign-in screen too, before a
 * carrier has a session.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { setMarketplaceName } from './config';

interface MarketplaceConfig {
  marketplace?: { displayName?: string };
}

export function MarketplaceName(): null {
  const config = useQuery({
    queryKey: ['storefront-config'],
    queryFn: () => api.get<MarketplaceConfig>('/config'),
    staleTime: 5 * 60_000,
    // Never worth an error: without it the product's own name stands in.
    retry: false,
  });

  const name = config.data?.marketplace?.displayName;
  useEffect(() => {
    setMarketplaceName(name);
  }, [name]);

  return null;
}
