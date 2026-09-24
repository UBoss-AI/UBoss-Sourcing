/**
 * The bulk-pricing figures for what the buyer has chosen, shared.
 *
 * The product page's price summary and the bulk-savings popover both read
 * this, under one query key, so they are fetched once and can never show two
 * different prices for the same quantity - and both come from the function
 * the basket charges with.
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { fetchBulkPricing } from './bulk-pricing';

/** Wait for typing to settle before asking: one request, one announcement. */
export function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSettled(value);
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [value, delayMs]);
  return settled;
}

export function useBulkPricing(input: {
  productId: string;
  variantId: string | null;
  pieces: number;
  displayCurrency: string | null;
  enabled?: boolean;
}) {
  const quantity = useSettled(Math.max(1, input.pieces), 350);
  const query = useQuery({
    queryKey: ['bulk-pricing', input.productId, input.variantId, quantity, input.displayCurrency],
    queryFn: () =>
      fetchBulkPricing({
        productId: input.productId,
        variantId: input.variantId,
        quantity,
        displayCurrency: input.displayCurrency,
      }),
    enabled: (input.enabled ?? true) && input.pieces > 0,
    staleTime: 30_000,
    // Missing figures are not an error the buyer needs to hear about.
    retry: false,
    placeholderData: (previous) => previous,
  });
  return { query, quantity };
}
