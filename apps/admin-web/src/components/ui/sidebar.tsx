/**
 * The navigation rail that widens when you point at it.
 *
 * Sixty pixels of icons while nobody is using it, three hundred while a
 * pointer — or the keyboard — is inside it. It keeps the space it is given
 * rather than floating over the page, so the labels arriving push the content
 * across instead of printing themselves over it.
 *
 * Below `md` the same rows are a drawer, because a column of unlabelled icons
 * is not navigation anybody uses on a phone.
 *
 * All three surfaces render this file — the admin console, the storefront's
 * account area and the logistics portal — and it is the same file in each, so
 * a fix to one is a fix to all three. What differs between them is only the
 * rows they hand it.
 *
 * ---
 *
 * WHERE THIS CAME FROM, AND WHAT HAD TO CHANGE
 *
 * The shape of this is the Aceternity `sidebar` component. Seven things about
 * it could not survive contact with this repository — the same kind of list
 * `ui/flip-words.tsx` and `ui/apple-cards-carousel.tsx` keep, for the same
 * reason.
 *
 *   - **`cn` is `cx`.** This project's class joiner is `lib/cx.ts`. There is
 *     no `clsx`/`tailwind-merge` pair here, and adding one to satisfy an
 *     import would be two dependencies for one function.
 *   - **The rows are `NavLink`s, not `<a href>`s.** These are three
 *     single-page applications; a bare anchor reloads the whole bundle on
 *     every click and throws away the query cache with it. `NavLink` also sets
 *     `aria-current="page"`, which is how the current row says so to a screen
 *     reader rather than only in the fill.
 *   - **The icons are this repository's.** `@tabler/icons-react` is a
 *     dependency none of the three apps have, and every glyph the navigation
 *     needs already exists in `components/icons.tsx` — drawn to one stroke
 *     weight, inheriting `currentColor`, already `aria-hidden`.
 *   - **The colours are tokens.** `bg-neutral-100 dark:bg-neutral-800` is two
 *     hard-coded greys; `bg-surface` is the one the rest of the panel uses and
 *     the one the dark theme already answers for. The same goes for every
 *     `text-neutral-700` in the original.
 *   - **The drawer is a real modal.** The original slides a panel in and
 *     leaves the page behind it focusable, so Tab walks out of the drawer onto
 *     controls nobody can see. Here focus moves in on open, cycles inside,
 *     comes back to whatever opened it, Escape closes it, and the page
 *     underneath does not scroll.
 *   - **A collapsed row still has a name.** The label is animated to
 *     `display: none`, which removes it from the accessibility tree as well as
 *     from the screen — so every row carries an `aria-label`, and the rail
 *     opens on focus as well as on hover so a sighted keyboard user sees what
 *     a mouse user sees.
 *   - **The rail and the drawer keep separate state.** The original has one
 *     `open` for both, which holds until the thing being navigated is a
 *     router: closing the drawer after a route change then also collapses the
 *     desktop rail, under a cursor that is still inside it and will not send
 *     another `mouseenter`. Here `open` means the drawer, the rail keeps its
 *     own hover state, and a row reads whichever presentation it is in.
 *   - **`prefers-reduced-motion` gets no animation.** The width still changes
 *     and the drawer still opens; neither travels. A rail that widens under
 *     the cursor is the exact class of movement that preference asks to be
 *     spared.
 *
 * **The rail is the only thing in here that scrolls, and its bar is hidden.**
 * Nothing a caller puts inside it may set an overflow on one axis only: CSS
 * computes the other axis from `visible` to `auto` when it does, which turns
 * that child into a second scroll container — one with a drawn bar, inside the
 * one whose bar was just hidden. `overflow-x-hidden` on a wrapper is the
 * innocent spelling of that mistake, and it is how a grey bar appeared down
 * the middle of the console's chrome after the rail's own had been taken away.
 *
 * There is also no `"use client"`: these are Vite applications, and the
 * directive is a Next.js instruction that means nothing here.
 */
import { useEffect, useRef, useState } from 'react';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { NavLink } from 'react-router-dom';
import { CloseIcon } from '@/components/icons';
import { cx } from '@/lib/cx';
import { usePrefersReducedMotion } from '@/lib/reduced-motion';
import { SidebarContext, useSidebar } from './sidebar-context';
import type { SidebarLinkItem } from './sidebar-context';

/** Wide enough for the longest translated label across the eight languages. */
const OPEN_WIDTH = '300px';
/** Narrow enough to read as a rail, wide enough to aim an icon at. */
const RAIL_WIDTH = '60px';

export function SidebarProvider({
  children,
  open: openProp,
  setOpen: setOpenProp,
  animate = true,
}: {
  children: ReactNode;
  open?: boolean | undefined;
  setOpen?: Dispatch<SetStateAction<boolean>> | undefined;
  animate?: boolean | undefined;
}): React.JSX.Element {
  // Only used when the caller does not own the state. All three shells do own
  // it, because the header's menu button and the route change both have to be
  // able to close the drawer.
  const [openState, setOpenState] = useState(false);

  const open = openProp ?? openState;
  const setOpen = setOpenProp ?? setOpenState;

  return (
    <SidebarContext.Provider value={{ open, setOpen, animate }}>{children}</SidebarContext.Provider>
  );
}

/**
 * The whole thing.
 *
 * `open` is the **drawer**, not the rail: it is what the header's menu button
 * toggles and what a route change closes. The rail, from `md` up, widens on
 * its own and tells nobody.
 */
export function Sidebar({
  children,
  open,
  setOpen,
  animate,
}: {
  children: ReactNode;
  open?: boolean | undefined;
  setOpen?: Dispatch<SetStateAction<boolean>> | undefined;
  animate?: boolean | undefined;
}): React.JSX.Element {
  return (
    <SidebarProvider open={open} setOpen={setOpen} animate={animate}>
      {children}
    </SidebarProvider>
  );
}

/**
 * The rows, in both presentations.
 *
 * The children are rendered twice — once into the rail, once into the drawer —
 * and only one of the two is ever in the document's accessibility tree: the
 * rail is `display: none` below `md`, and the drawer does not exist until it
 * is opened.
 */
export function SidebarBody({
  label,
  closeLabel,
  className,
  children,
}: {
  /** The `<nav>`'s accessible name. Translated by the caller. */
  label: string;
  /** What the drawer's close button and its scrim are called. */
  closeLabel: string;
  className?: string | undefined;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <>
      <DesktopSidebar label={label} className={className}>
        {children}
      </DesktopSidebar>
      <MobileSidebar label={label} closeLabel={closeLabel} className={className}>
        {children}
      </MobileSidebar>
    </>
  );
}

export function DesktopSidebar({
  label,
  className,
  children,
}: {
  label: string;
  className?: string | undefined;
  children: ReactNode;
}): React.JSX.Element {
  const { animate } = useSidebar();
  const reduced = usePrefersReducedMotion();
  // The rail's own state, not the drawer's — see the note at the top of the
  // file. Nothing outside needs it: the only thing that opens the rail is a
  // pointer or a Tab landing inside it.
  const [open, setOpen] = useState(false);

  return (
    <SidebarContext.Provider value={{ open, setOpen, animate }}>
      <motion.nav
        aria-label={label}
        className={cx(
          'hidden shrink-0 flex-col overflow-y-auto overflow-x-hidden',
          // Scrolls, but without the bar: a native scrollbar is a light gutter
          // cut down sixty pixels of chrome, and it appears and disappears as
          // pages of different heights load. Wheel, trackpad, touch and keyboard
          // all still scroll it — only the drawn bar is gone.
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          'border-r border-border bg-surface px-2.5 py-4 md:flex',
          className,
        )}
        animate={{ width: animate ? (open ? OPEN_WIDTH : RAIL_WIDTH) : OPEN_WIDTH }}
        transition={reduced ? { duration: 0 } : { duration: 0.2, ease: 'easeInOut' }}
        onMouseEnter={() => {
          setOpen(true);
        }}
        onMouseLeave={() => {
          setOpen(false);
        }}
        // Tabbing into the rail opens it too. Without this a keyboard user
        // walks fourteen rows of icons whose labels are `display: none`, which
        // is the one state this design has that nobody can read.
        onFocus={() => {
          setOpen(true);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        }}
      >
        {children}
      </motion.nav>
    </SidebarContext.Provider>
  );
}

/**
 * The drawer, below `md`.
 *
 * A modal, and treated as one. The three things that separate a drawer from a
 * panel that merely slid in:
 *
 *   - Focus moves in on open and back to the control that opened it on close —
 *     but only when the close was a dismissal. Following a row closes it too,
 *     and there the new page has already taken focus.
 *   - Tab cycles inside it. Without the cycle, tabbing past the last row lands
 *     on the page behind the scrim, where nothing is visible and every
 *     keystroke afterwards goes somewhere the user cannot see.
 *   - The page behind it does not scroll, so dismissing it does not also mean
 *     finding your place again.
 */
export function MobileSidebar({
  label,
  closeLabel,
  className,
  children,
}: {
  label: string;
  closeLabel: string;
  className?: string | undefined;
  children: ReactNode;
}): React.JSX.Element {
  const { open, setOpen, animate } = useSidebar();
  const reduced = usePrefersReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // Set by the three dismissals and by nothing else, so a close that came from
  // a navigation does not snatch focus back off the page it just opened.
  const restoreFocusRef = useRef(false);

  const dismiss = (): void => {
    restoreFocusRef.current = true;
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return undefined;

    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        restoreFocusRef.current = true;
        setOpen(false);
        return;
      }

      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (panel === null) return;

      const focusable = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);

      if (restoreFocusRef.current) {
        restoreFocusRef.current = false;
        openerRef.current?.focus();
      }
    };
  }, [open, setOpen]);

  return (
    <AnimatePresence>
      {open && (
        // A motion element rather than a plain one, so the panel and the scrim
        // inside it are still mounted while their exit animations run.
        <motion.div className="fixed inset-0 z-50 md:hidden">
          <motion.button
            type="button"
            aria-label={closeLabel}
            className="absolute inset-0 bg-ink/50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reduced ? { duration: 0 } : { duration: 0.2 }}
            onClick={dismiss}
          />

          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={label}
            className={cx(
              'absolute inset-y-0 left-0 flex w-[17rem] max-w-[85%] flex-col overflow-y-auto',
              '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
              'border-r border-border bg-surface px-2.5 py-4 shadow-xl',
              className,
            )}
            initial={reduced ? { opacity: 0 } : { x: '-100%' }}
            animate={reduced ? { opacity: 1 } : { x: 0 }}
            exit={reduced ? { opacity: 0 } : { x: '-100%' }}
            transition={reduced ? { duration: 0 } : { duration: 0.3, ease: 'easeInOut' }}
          >
            <button
              ref={closeRef}
              type="button"
              onClick={dismiss}
              className="absolute right-2 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
            >
              <CloseIcon className="h-5 w-5" />
              <span className="sr-only">{closeLabel}</span>
            </button>

            {/* Always expanded: a drawer somebody deliberately opened is not a
                place to hide the labels. */}
            <SidebarContext.Provider value={{ open: true, setOpen, animate }}>
              {children}
            </SidebarContext.Provider>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Text that is there only while the rail is open.
 *
 * `display` rather than opacity alone: a label that is merely transparent
 * still takes its three hundred pixels, so the rail would be sixty pixels wide
 * with its rows hanging out of it.
 */
export function SidebarLabel({
  className,
  display = 'inline-block',
  ariaHidden = false,
  children,
}: {
  className?: string | undefined;
  /** `block` for anything that is more than one line — a brand, a name. */
  display?: 'inline-block' | 'block' | undefined;
  /** For text that repeats something its row already says another way. */
  ariaHidden?: boolean | undefined;
  children: ReactNode;
}): React.JSX.Element {
  const { open, animate } = useSidebar();
  const reduced = usePrefersReducedMotion();
  const shown = !animate || open;

  return (
    <motion.span
      aria-hidden={ariaHidden ? 'true' : undefined}
      animate={{ display: shown ? display : 'none', opacity: shown ? 1 : 0 }}
      transition={reduced ? { duration: 0 } : { duration: 0.15 }}
      className={cx('whitespace-pre', className)}
    >
      {children}
    </motion.span>
  );
}

/**
 * A group of rows, under the name of what they have in common.
 *
 * The heading does not disappear when the rail closes — it becomes the rule
 * that separates one group from the next, so the grouping survives at sixty
 * pixels even though the words do not. It stays in the accessibility tree
 * either way: it is faded, not removed, because a screen reader is reading the
 * rail at whatever width it happens to be.
 */
export function SidebarSection({
  label,
  children,
}: {
  /** Null for a group that needs no heading — the one above the dashboard. */
  label: string | null;
  children: ReactNode;
}): React.JSX.Element {
  const { open, animate } = useSidebar();
  const reduced = usePrefersReducedMotion();
  const shown = !animate || open;
  const fade = reduced ? { duration: 0 } : { duration: 0.15 };

  return (
    <div>
      {label !== null && (
        <h2 className="relative mx-3 mb-1.5 h-4">
          <motion.span
            animate={{ opacity: shown ? 1 : 0 }}
            transition={fade}
            className="absolute inset-x-0 top-0 block truncate text-xxs font-semibold uppercase tracking-[0.12em] text-ink-subtle"
          >
            {label}
          </motion.span>
          <motion.span
            aria-hidden="true"
            animate={{ opacity: shown ? 0 : 1 }}
            transition={fade}
            className="absolute inset-x-0 top-2 block h-px bg-border"
          />
        </h2>
      )}

      <ul className="space-y-px">{children}</ul>
    </div>
  );
}

/**
 * One row.
 *
 * Three signals separate the current row from the others, because one is never
 * enough: a tinted ground, a brand-blue label and icon against the muted rest,
 * and a rail down its left edge. The rail is what survives a monochrome
 * screen; `aria-current="page"`, which `NavLink` sets, is what survives no
 * screen at all.
 */
export function SidebarLink({
  link,
  onNavigate,
  className,
}: {
  link: SidebarLinkItem;
  /** Called after the row is followed — the drawer closes on it. */
  onNavigate?: (() => void) | undefined;
  className?: string | undefined;
}): React.JSX.Element {
  const { open, animate } = useSidebar();
  const Icon = link.icon;
  const waiting = link.badge ?? 0;
  const collapsed = animate && !open;

  return (
    <li>
      <NavLink
        to={link.to}
        end={link.matchPrefix !== true}
        onClick={onNavigate}
        // The name is on the link and not only in the span, because the span is
        // `display: none` at sixty pixels wide, and a row with no name is a row
        // a screen reader reads out as its own URL.
        aria-label={link.ariaLabel ?? link.label}
        className={({ isActive }) =>
          cx(
            'group/row relative flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors',
            isActive
              ? // `before:` rather than a sibling element, so the rail cannot
                // drift out of step with the state that draws it.
                'bg-brand-soft font-medium text-brand ' +
                  'before:absolute before:left-0 before:top-2 before:h-5 before:w-[3px] ' +
                  "before:rounded-full before:bg-brand before:content-['']"
              : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
            className,
          )
        }
      >
        {({ isActive }) => (
          <>
            <span className="relative flex shrink-0 items-center">
              <Icon
                className={cx(
                  'h-[1.15rem] w-[1.15rem] shrink-0 transition-colors',
                  isActive ? 'text-brand' : 'text-ink-subtle group-hover/row:text-ink-muted',
                )}
              />
              {/* The count has nowhere to go at sixty pixels, so it becomes a
                  dot on the icon. A row with work behind it still looks
                  different from a row without any, which is the whole reason
                  the badge is on the rail rather than on the screen it opens. */}
              {waiting > 0 && collapsed && (
                <span
                  aria-hidden="true"
                  className="absolute -right-1 -top-0.5 h-2 w-2 rounded-full bg-danger-fill ring-2 ring-surface"
                />
              )}
            </span>

            <SidebarLabel className="min-w-0 flex-1 truncate">{link.label}</SidebarLabel>

            {waiting > 0 && (
              <SidebarLabel
                ariaHidden
                className="ml-auto flex h-[1.15rem] min-w-[1.15rem] shrink-0 items-center justify-center rounded-full bg-danger-fill px-1.5 text-center text-xxs font-semibold leading-none text-white"
              >
                {waiting > 99 ? '99+' : waiting}
              </SidebarLabel>
            )}
          </>
        )}
      </NavLink>
    </li>
  );
}
