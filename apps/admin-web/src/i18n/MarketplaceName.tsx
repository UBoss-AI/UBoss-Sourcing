/**
 * Hands the marketplace's own name to the translator.
 *
 * Every buyer of this software runs their own marketplace under their own
 * name, so a sentence such as "Northwind manages L2" carries
 * `{{marketplace}}` in the catalogue instead of a name, and this fills it from
 * `GET /config` - `marketplace.displayName`, from Settings -> Business profile.
 * See `setMarketplaceName` for why it is a default variable rather than an
 * option at each call site.
 *
 * `/config` is public, so this runs on the sign-in screens too, and it shares
 * the query key the rest of the console reads the document under, so it costs
 * no second request.
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
