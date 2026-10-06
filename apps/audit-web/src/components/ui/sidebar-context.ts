/**
 * What the rail knows about itself, and the row type it renders.
 *
 * Its own module rather than the top of `ui/sidebar.tsx` for the reason
 * `components/toast-context.ts` is its own module: `react-refresh` warns on a
 * file that exports anything other than components, lint runs with
 * `--max-warnings=0`, and a hook beside a component is exactly that warning.
 */
import { createContext, useContext } from 'react';
import type { Dispatch, SetStateAction } from 'react';

/** One row in the rail. */
export interface SidebarLinkItem {
  to: string;
  /** The text beside the icon, already translated. */
  label: string;
  /**
   * The row's silhouette. Decoration in the strict sense — every icon here is
   * `aria-hidden` and the label carries the meaning — but at sixty pixels wide
   * it is the only thing on the row, so it is what somebody aims at.
   */
  icon: (props: { className?: string }) => React.JSX.Element;
  /** Keeps the row lit on child routes too, so /orders/abc is still Orders. */
  matchPrefix?: boolean | undefined;
  /** How many things are waiting behind this row. Zero draws nothing. */
  badge?: number | undefined;
  /**
   * What a screen reader hears instead of `label`.
   *
   * Set when the row carries a count: "Exceptions" and "Exceptions, 4 waiting"
   * are different pieces of news, and the pill that says so is `aria-hidden`.
   */
  ariaLabel?: string | undefined;
}

export interface SidebarState {
  /** Wide, with labels. Hover and focus open it; the drawer is always open. */
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
  /** False pins it open — a caller that wants a plain column, not a rail. */
  animate: boolean;
}

export const SidebarContext = createContext<SidebarState | undefined>(undefined);

export function useSidebar(): SidebarState {
  const context = useContext(SidebarContext);

  if (context === undefined) {
    throw new Error('useSidebar must be used inside a <Sidebar>');
  }

  return context;
}
