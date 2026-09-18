/**
 * The two things about the gooey transition that are not a component.
 *
 * They live apart from `ui/gooey-input.tsx` for the reason `components/toast.tsx`
 * and `components/toast-context.ts` live apart: a module that exports anything
 * other than components loses Vite's fast refresh for every component in it, and
 * the lint rule that says so is an error here, not a suggestion.
 */
import { useId } from 'react';

/**
 * A DOM-safe id, derived from React's.
 *
 * `useId` returns something like `:r7:`, and a colon is not valid in a CSS
 * `url(#…)` reference or in a `querySelector`. Stripping them keeps the
 * per-instance uniqueness, which is the part that matters: two gooey controls
 * on one page sharing a filter id would both resolve to whichever rendered
 * first, so closing one would visibly un-goo the other.
 */
export function useGooeyFilterId(prefix: string): string {
  const reactId = useId();
  return `${prefix}-${reactId.replace(/:/g, '')}`;
}

/** The spring every gooey transition uses, so two of them never disagree. */
export const GOOEY_SPRING = {
  type: 'spring' as const,
  duration: 0.4,
  bounce: 0.25,
};
