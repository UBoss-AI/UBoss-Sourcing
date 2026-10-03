/**
 * The verified-supplier read behind the sentence under the home page's
 * headline. See components/home/ValueProposition.tsx.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { SupplierListResponse } from '@/lib/types';

/**
 * One. The sentence only needs to know whether any supplier is verified, and
 * `countries` covers every verified supplier whatever the limit. The home page
 * used to ask for eight, for the cards it no longer shows.
 */
export const HOME_SUPPLIER_COUNT = 1;

export function useVerifiedSuppliers(): ReturnType<typeof useQuery<SupplierListResponse>> {
  return useQuery({
    queryKey: ['verified-suppliers', HOME_SUPPLIER_COUNT],
    queryFn: () =>
      api.get<SupplierListResponse>('/catalog/suppliers', {
        query: { limit: HOME_SUPPLIER_COUNT },
      }),
    staleTime: 5 * 60_000,
    // A failed read leaves the neutral sentence; retrying it three times first would
    // only delay the moment the rest of the page settles.
    retry: false,
  });
}

/** The single country every verified supplier is registered in, if there is one. */
export function soleSupplierCountry(data: SupplierListResponse | undefined): string | null {
  // Read defensively: a proxy or an older API answering `{}` must leave the
  // page with no claim, not with a crash.
  const countries = Array.isArray(data?.countries) ? data.countries : [];
  if (countries.length !== 1) return null;
  return countries[0]?.country ?? null;
}
