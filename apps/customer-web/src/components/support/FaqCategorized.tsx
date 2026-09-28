/**
 * Frequently asked questions, grouped under tabs, each one an accordion.
 *
 * The approved reference `FaqCategorized`, with its tabs, sliding indicator,
 * accordion and reduced-motion handling kept. What changed, and why:
 *
 *   - **The content is passed in.** The reference carried a UI library's own
 *     FAQ - its install command, its licence, its billing. Here every question
 *     comes from the caller, already translated, with a stable id that React
 *     keys and ARIA ids hang off, so a changed translation never remounts
 *     anything or breaks a relationship.
 *   - **A real tab pattern.** `aria-controls`, a roving `tabIndex`, and Left,
 *     Right, Home and End moving between tabs - the WAI-ARIA tabs pattern,
 *     activating as focus moves because switching a tab is cheap here.
 *   - **Panels stay in the document.** A closed answer is collapsed and made
 *     `inert` rather than unmounted, so `aria-controls` always points at
 *     something, and opening one never has to wait for a mount.
 *   - **Topics as tiles, not an underlined row.** Each topic is a tile with
 *     its icon and how many questions it holds; the selected one is raised,
 *     its icon filled, its name heavier - so active is never only a colour.
 *     The open question carries the turned chevron and a brand border.
 *   - **Brand tokens, this app's icons, `usePrefersReducedMotion`.** No
 *     `lucide-react` for one chevron, and the shared hook rather than motion's
 *     cached one - see `lib/reduced-motion.ts`.
 *   - **Not a `"use client"` module.** This is a Vite app; there is no server
 *     component boundary to mark.
 */
import {
  useId,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDownIcon } from '@/components/icons';
import { cx } from '@/lib/cx';
import { usePrefersReducedMotion } from '@/lib/reduced-motion';

export interface FaqEntry {
  /** Stable across languages: React keys and ARIA ids are built from it. */
  id: string;
  question: string;
  answer: string;
  /** A next step under the answer - a link, usually. */
  action?: ReactNode;
}

export interface FaqCategory {
  id: string;
  name: string;
  faqs: FaqEntry[];
  /** Drawn in the topic's tile. Decorative: the name is what is read out. */
  icon?: ComponentType<{ className?: string }>;
}

export interface FaqCategorizedProps {
  categories: FaqCategory[];
  title: string;
  description: string;
  /** The section's own id, for a `#support-faq` link. */
  id?: string;
  /** Names the tab list for a screen reader, e.g. "Topics". */
  tabListLabel: string;
  /** "5 questions", under each topic's name. Omitted, no count is shown. */
  countLabel?: (count: number) => string;
  className?: string;
}

const spring = { bounce: 0.05, duration: 0.25, type: 'spring' as const };
const still = { duration: 0 };

export function FaqCategorized({
  categories,
  title,
  description,
  id,
  tabListLabel,
  countLabel,
  className,
}: FaqCategorizedProps): React.JSX.Element | null {
  const reduced = usePrefersReducedMotion();
  const [activeIndex, setActiveIndex] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  // One per instance, so two lists on a page could never share an id.
  const base = useId().replace(/:/g, '');
  const headingId = `${base}-heading`;

  const transition = reduced ? still : spring;

  if (categories.length === 0) return null;

  // Clamped: a caller that drops a category must not leave the index past the end.
  const active = categories[Math.min(activeIndex, categories.length - 1)] ?? categories[0];
  if (active === undefined) return null;
  const activePosition = categories.indexOf(active);

  const choose = (index: number): void => {
    setActiveIndex(index);
    // A question from the last topic is not open in this one.
    setOpenId(null);
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const last = categories.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = activePosition === last ? 0 : activePosition + 1;
    else if (event.key === 'ArrowLeft') next = activePosition === 0 ? last : activePosition - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next === null) return;

    event.preventDefault();
    choose(next);
    tabs.current[next]?.focus();
  };

  const tabId = (categoryId: string): string => `${base}-tab-${categoryId}`;
  const panelId = (categoryId: string): string => `${base}-panel-${categoryId}`;

  return (
    <section
      id={id}
      aria-labelledby={headingId}
      // The sticky header is cleared by the page's own scroll-padding-top;
      // this is only a little breathing room above the heading.
      className={cx('scroll-mt-4', className)}
    >
      <motion.div
        initial={reduced ? false : { opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={transition}
        className="mb-8 text-center sm:mb-10"
      >
        <h2 id={headingId} className="mb-3 text-2xl font-bold text-ink sm:text-3xl lg:text-4xl">
          {title}
        </h2>
        <p className="mx-auto max-w-2xl text-base text-ink-muted sm:text-lg">{description}</p>
      </motion.div>

      <motion.div
        initial={reduced ? false : { opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...transition, delay: reduced ? 0 : 0.1 }}
        className="mb-6 sm:mb-8"
      >
        {/*
          A segmented control of equal tiles rather than a row of text tabs.
          Tiles, because six topics with names that run long in German or
          Greek wrap cleanly inside a tile, where a single row either
          overflows sideways or breaks unevenly. Two across on a phone, three
          from a tablet up - no horizontal scroll at any width. On a phone the icon
          sits above the name, so the name has the whole tile to wrap in.

          The selected tile is raised onto the surface, its icon filled and its
          name heavier: position, shape and weight, not colour alone. The raised
          plate slides between tiles; with reduced motion it simply moves.
        */}
        <div
          role="tablist"
          aria-label={tabListLabel}
          className="grid grid-cols-2 gap-1.5 rounded-2xl border border-border bg-surface-sunken p-1.5 sm:grid-cols-3"
        >
          {categories.map((category, index) => {
            const selected = index === activePosition;
            const Icon = category.icon;
            return (
              <button
                key={category.id}
                ref={(node) => {
                  tabs.current[index] = node;
                }}
                id={tabId(category.id)}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={panelId(category.id)}
                tabIndex={selected ? 0 : -1}
                onClick={() => {
                  choose(index);
                }}
                onKeyDown={onTabKey}
                className={cx(
                  // At least 56px tall: a generous touch target at every width.
                  'group relative flex min-h-14 min-w-0 flex-col items-start gap-2 rounded-xl p-3 text-left sm:flex-row sm:items-center sm:gap-3 sm:py-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                  !selected && 'hover:bg-surface-hover/70',
                )}
              >
                {selected && (
                  <motion.span
                    aria-hidden="true"
                    {...(reduced ? {} : { layoutId: `${base}-plate` })}
                    transition={transition}
                    className="absolute inset-0 rounded-xl bg-surface shadow-card ring-1 ring-brand/30"
                  />
                )}
                {Icon !== undefined && (
                  <span
                    aria-hidden="true"
                    className={cx(
                      'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors sm:h-9 sm:w-9',
                      selected
                        ? 'bg-brand-fill text-white'
                        : 'border border-border bg-surface text-ink-subtle group-hover:text-brand',
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </span>
                )}
                <span className="relative flex min-w-0 flex-col">
                  <span
                    className={cx(
                      'hyphens-auto break-words text-sm leading-snug',
                      selected ? 'font-semibold text-ink' : 'font-medium text-ink-muted group-hover:text-ink',
                    )}
                  >
                    {category.name}
                  </span>
                  {countLabel !== undefined && (
                    <span
                      // Kept out of the tab's name: "Orders and payments", not
                      // "Orders and payments 5 questions", on every arrow key.
                      aria-hidden="true"
                      className={cx('text-xs', selected ? 'text-brand' : 'text-ink-subtle')}
                    >
                      {countLabel(category.faqs.length)}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </motion.div>

      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={active.id}
          id={panelId(active.id)}
          role="tabpanel"
          aria-labelledby={tabId(active.id)}
          initial={reduced ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduced ? { opacity: 0, transition: still } : { opacity: 0, y: -10 }}
          transition={transition}
        >
          <ul className="space-y-3 sm:space-y-4">
            {active.faqs.map((faq, index) => {
              const open = openId === faq.id;
              const triggerId = `${base}-q-${faq.id}`;
              const answerId = `${base}-a-${faq.id}`;
              return (
                <motion.li
                  key={faq.id}
                  initial={reduced ? false : { opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ ...transition, delay: reduced ? 0 : index * 0.05 }}
                  className={cx(
                    'overflow-hidden rounded-xl border bg-surface transition-colors',
                    open ? 'border-brand/60' : 'border-border hover:border-brand/50',
                  )}
                >
                  <h3>
                    <button
                      id={triggerId}
                      type="button"
                      aria-expanded={open}
                      aria-controls={answerId}
                      onClick={() => {
                        setOpenId(open ? null : faq.id);
                      }}
                      className="flex min-h-14 w-full cursor-pointer items-center justify-between gap-4 p-4 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand sm:p-5"
                    >
                      <span className="min-w-0 break-words font-medium text-ink">{faq.question}</span>
                      <motion.span
                        aria-hidden="true"
                        animate={{ rotate: open ? 180 : 0 }}
                        transition={transition}
                        className="shrink-0"
                      >
                        <ChevronDownIcon className="h-5 w-5 text-ink-subtle" />
                      </motion.span>
                    </button>
                  </h3>

                  <motion.div
                    id={answerId}
                    role="region"
                    aria-labelledby={triggerId}
                    // Collapsed and inert rather than unmounted: the id stays
                    // resolvable, and a closed answer is out of the tab order
                    // and the accessibility tree.
                    inert={!open}
                    initial={false}
                    animate={open ? { height: 'auto', opacity: 1 } : { height: 0, opacity: 0 }}
                    transition={reduced ? still : { bounce: 0, duration: 0.25, type: 'spring' }}
                    className="overflow-hidden"
                    data-state={open ? 'open' : 'closed'}
                  >
                    <div className="px-4 pb-5 sm:px-5">
                      <p className="max-w-prose break-words leading-relaxed text-ink-muted">
                        {faq.answer}
                      </p>
                      {faq.action !== undefined && <div className="mt-3">{faq.action}</div>}
                    </div>
                  </motion.div>
                </motion.li>
              );
            })}
          </ul>
        </motion.div>
      </AnimatePresence>
    </section>
  );
}
