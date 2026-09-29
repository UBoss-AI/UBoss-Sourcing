/**
 * The verified-supplier read the home page makes, shared by the section that
 * lists them and the sentence under the headline, so the page asks once.
 * See components/home/VerifiedSuppliers.tsx.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { SupplierListResponse } from '@/lib/types';

/** How many cards the home page shows. */
export const HOME_SUPPLIER_COUNT = 8;

/** The one query both halves of this file share, so the page asks once. */
export function useVerifiedSuppliers(): ReturnType<typeof useQuery<SupplierListResponse>> {
  return useQuery({
    queryKey: ['verified-suppliers', HOME_SUPPLIER_COUNT],
    queryFn: () =>
      api.get<SupplierListResponse>('/catalog/suppliers', {
        query: { limit: HOME_SUPPLIER_COUNT },
      }),
    staleTime: 5 * 60_000,
    // A failed read hides the section; retrying it three times first would
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
