/**
 * Tabs, as the WAI-ARIA Authoring Practices describe them.
 *
 * - `role="tablist"` / `role="tab"` / `role="tabpanel"`, each tab
 *   `aria-controls` its panel and the panel is `aria-labelledby` its tab.
 * - Roving tabindex: only the selected tab is in the Tab order, so Tab moves
 *   from the tablist straight into the panel, and Left/Right (Up/Down too),
 *   Home and End move between tabs.
 * - Automatic activation: moving to a tab selects it. Right for two short
 *   panels whose content is already on the page - there is nothing to load.
 *
 * The component draws the tablist and renders ONE panel, the selected one.
 * The caller owns the selected key, so a deep link or a URL parameter can
 * decide it.
 */
import { useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { cx } from '@/lib/cx';

export interface TabItem<K extends string> {
  key: K;
  label: ReactNode;
}

export function Tabs<K extends string>({
  tabs,
  value,
  onChange,
  label,
  children,
  className,
  panelClassName,
}: {
  tabs: readonly TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  /** The accessible name of the tablist. */
  label: string;
  /** The selected tab's panel. */
  children: ReactNode;
  className?: string;
  panelClassName?: string;
}): React.JSX.Element {
  const groupId = useId();
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(
    0,
    tabs.findIndex((tab) => tab.key === value),
  );

  function select(position: number): void {
    const tab = tabs[position];
    if (tab === undefined) return;
    onChange(tab.key);
    buttons.current[position]?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>): void {
    const last = tabs.length - 1;
    const moves: Record<string, number> = {
      ArrowRight: index === last ? 0 : index + 1,
      ArrowDown: index === last ? 0 : index + 1,
      ArrowLeft: index === 0 ? last : index - 1,
      ArrowUp: index === 0 ? last : index - 1,
      Home: 0,
      End: last,
    };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(next);
  }

  const selected = tabs[index];

  return (
    <div className={className}>
      <div
        role="tablist"
        aria-label={label}
        className="relative grid rounded-full border border-border bg-surface-sunken p-1"
        style={{ gridTemplateColumns: `repeat(${String(tabs.length)}, minmax(0, 1fr))` }}
      >
        {/* The sliding indicator: decoration over a state aria-selected already carries. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-1 left-1 top-1 rounded-full bg-surface shadow-sm ring-1 ring-border transition-transform duration-200 motion-reduce:transition-none"
          style={{
            width: `calc((100% - 0.5rem) / ${String(tabs.length)})`,
            transform: `translateX(${String(index * 100)}%)`,
          }}
        />
        {tabs.map((tab, position) => {
          const isSelected = position === index;
          return (
            <button
              key={tab.key}
              ref={(element) => {
                buttons.current[position] = element;
              }}
              type="button"
              role="tab"
              id={`${groupId}-tab-${tab.key}`}
              aria-selected={isSelected}
              aria-controls={`${groupId}-panel`}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => {
                select(position);
              }}
              onKeyDown={onKeyDown}
              className={cx(
                'relative z-10 min-h-[2.5rem] rounded-full px-3 py-2 text-sm font-medium transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
                isSelected ? 'text-ink' : 'text-ink-muted hover:text-ink',
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        id={`${groupId}-panel`}
        role="tabpanel"
        aria-labelledby={selected === undefined ? undefined : `${groupId}-tab-${selected.key}`}
        className={cx('focus-visible:outline-none', panelClassName)}
      >
        {children}
      </div>
    </div>
  );
}
