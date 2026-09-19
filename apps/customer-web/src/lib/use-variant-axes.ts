/**
 * The catalogue's variant axis definitions.
 *
 * One request per session for the whole shop, rather than a copy of the list
 * compiled into this bundle. The definitions live in exactly one place — the
 * 112 subcategory templates in `backend/src/domain/variants/` — and are read
 * from there by the seller's matrix builder, the buyer's selector and the
 * catalogue's facets alike. A second copy here is a second copy that
 * eventually disagrees, and the way that shows up is a filter that promises
 * one thing and a selector that offers another.
 *
 * A few kilobytes, identical for every shopper and every page, so it is cached
 * for the session. A failure is not an error state: the product page falls
 * back to the axis keys themselves as labels, which is ugly and still lets
 * somebody buy a shoe.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { VariantAxisDefinition } from './types';

interface VariantAxesResponse {
  /**
   * Keyed by subcategory slug, not flattened into one map of axis key to
   * definition.
   *
   * The flat version is smaller and it is wrong: `size` is a numeric run on a
   * shoe and a semantic one on a shirt, and one definition for both hangs a
   * shirt rail in the order L, M, S, XL.
   */
  templates: Record<string, { label: string; axes: VariantAxisDefinition[] }>;
}

const EMPTY: Readonly<Record<string, VariantAxisDefinition>> = Object.freeze({});

/**
 * The axis definitions for one product's shelf.
 *
 * `templateSlug` comes from the product itself. Null — a category with no
 * template, which is Medical Devices and any shelf an operator invented —
 * returns nothing, and the page falls back to the option list it has always
 * shown.
 */
export function useVariantAxes(templateSlug: string | null | undefined): {
  axes: Readonly<Record<string, VariantAxisDefinition>>;
  /**
   * True while the definitions are still on their way.
   *
   * The page needs this because an axis with no definition falls back to
   * showing its own key — `size_system` — as the label. That is a reasonable
   * last resort for a template that has genuinely lost an axis, and it is a
   * terrible half-second flash while a request is in flight. The selector
   * draws a skeleton instead.
   */
  isLoading: boolean;
} {
  const enabled = typeof templateSlug === 'string' && templateSlug !== '';

  const query = useQuery({
    queryKey: ['variant-axes'],
    queryFn: () => api.get<VariantAxesResponse>('/catalog/variant-axes'),
    // The shelves of a shop do not change while somebody is browsing it.
    staleTime: Infinity,
    gcTime: Infinity,
    // Only asked for by a page that has a product with declared axes. A
    // catalogue that uses none never makes the request at all.
    enabled,
  });

  const axes = useMemo(() => {
    if (!enabled) return EMPTY;

    const found = query.data?.templates[templateSlug]?.axes;
    if (found === undefined) return EMPTY;

    return Object.fromEntries(found.map((axis) => [axis.key, axis]));
  }, [enabled, query.data, templateSlug]);

  // A failure is not a loading state. If the request comes back broken the
  // page renders with key labels rather than a skeleton that never resolves —
  // ugly, and somebody can still buy a shoe.
  return { axes, isLoading: enabled && query.isPending };
}
