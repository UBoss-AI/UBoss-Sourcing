/**
 * The profile's section switcher.
 *
 * A real ARIA tab list: one tab stop for the whole strip, arrow keys and
 * Home/End move between tabs, and each tab names the panel it controls. On a
 * phone the strip scrolls sideways rather than wrapping into a block of
 * buttons; the active tab is scrolled into view when it changes.
 *
 * The underline slides between tabs (the "animated tabs" pattern), drawn by
 * `motion` with a shared layout id. With reduced motion asked for, it simply
 * appears under the new tab.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { motion } from 'motion/react';
import { cx } from '@/lib/cx';
import { usePrefersReducedMotion } from '@/lib/reduced-motion';

export interface ProfileTab<K extends string> {
  key: K;
  label: string;
  /** A small count or dot beside the label - "needs attention". */
  flag?: boolean;
}

export function ProfileTabs<K extends string>({
  tabs,
  active,
  onChange,
  label,
  idPrefix,
}: {
  tabs: readonly ProfileTab<K>[];
  active: K;
  onChange: (key: K) => void;
  /** The strip's accessible name. */
  label: string;
  idPrefix: string;
}): React.JSX.Element {
  const reduced = usePrefersReducedMotion();
  const refs = useRef(new Map<K, HTMLButtonElement>());
  const mounted = useRef(false);

  useEffect(() => {
    // Not on the first render: a page opened on a deep link would otherwise
    // jump to wherever the strip sits before the reader has seen the header.
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    const node = refs.current.get(active);
    if (typeof node?.scrollIntoView !== 'function') return;
    node.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }, [active, reduced]);

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;

    event.preventDefault();
    const tab = tabs[next];
    if (tab === undefined) return;
    onChange(tab.key);
    refs.current.get(tab.key)?.focus();
  };

  return (
    // Scrolls sideways without a scrollbar - the same treatment the sidebar
    // gives its own overflow - and the right edge fades so a cut-off tab reads
    // as "there is more" rather than as a broken layout.
    <div className="relative -mx-4 overflow-x-auto overflow-y-hidden px-4 [mask-image:linear-gradient(to_right,black_calc(100%_-_2rem),transparent)] [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
      <div
        role="tablist"
        aria-label={label}
        className="flex min-w-max gap-1 border-b border-border-subtle"
      >
        {tabs.map((tab, index) => {
          const selected = tab.key === active;
          return (
            <button
              key={tab.key}
              ref={(node) => {
                if (node === null) refs.current.delete(tab.key);
                else refs.current.set(tab.key, node);
              }}
              type="button"
              role="tab"
              id={`${idPrefix}-tab-${tab.key}`}
              aria-selected={selected}
              aria-controls={`${idPrefix}-panel-${tab.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => {
                onChange(tab.key);
              }}
              onKeyDown={(event) => {
                move(event, index);
              }}
              className={cx(
                'relative inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-t-md px-3 text-sm font-medium',
                'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                selected ? 'text-ink' : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
              )}
            >
              {tab.label}
              {tab.flag === true ? (
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-warning" />
              ) : null}
              {selected ? (
                reduced ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand"
                  />
                ) : (
                  <motion.span
                    layoutId={`${idPrefix}-tab-indicator`}
                    aria-hidden="true"
                    className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-brand"
                    transition={{ type: 'spring', stiffness: 520, damping: 40 }}
                  />
                )
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
