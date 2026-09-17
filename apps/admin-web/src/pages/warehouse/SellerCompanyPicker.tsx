/**
 * Choosing an approved seller company.
 *
 * A combobox, built rather than borrowed, because the three things that make
 * one usable are the three things a plain `<input>` plus a `<ul>` gets wrong:
 *
 *   - **Keyboard.** Down and Up move through the list, Enter picks, Escape
 *     closes. Without it the whole control is mouse-only, which on a screen
 *     that operators live in all day is the difference between a tool and a
 *     demo.
 *   - **Announcement.** `role="combobox"` with `aria-activedescendant` is what
 *     makes a screen reader say the company being moved over. A visual
 *     highlight says nothing to anybody who cannot see it.
 *   - **Out-of-order answers.** A slow request for "nor" landing after a fast
 *     one for "northwind" would replace the right list with a stale one. React
 *     Query keys the cache on the search term, so an answer can only ever fill
 *     the query it belongs to - which is the fix, rather than a sequence
 *     number this file would have to maintain.
 *
 * **The search runs on the server.** Downloading every seller and filtering in
 * the browser would ship the marketplace's entire company list to anybody who
 * opens this screen, and would stop working the week the marketplace succeeds.
 *
 * **Only approved sellers are ever offered**, and that is the server's rule
 * rather than this component's: there is no parameter here that could widen it
 * to a suspended or rejected application, because the first thing such a
 * parameter becomes is a way to read the businesses an operator stopped
 * trading with.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui';
import { cx } from '@/lib/cx';
import { useI18n } from '@/i18n/i18n-context';
import {
  fetchSellerSuggestions,
  sellerSearchKey,
  type SellerSuggestion,
} from '@/lib/seller-warehouses';

/**
 * How long the box waits before asking the server.
 *
 * The same 300ms the warehouse search uses, and for the same reason: long
 * enough to swallow a typed word, short enough that nobody waits for it.
 */
const DEBOUNCE_MS = 300;

/**
 * Below this, nothing is requested.
 *
 * Mirrors the server's own floor. Asking anyway would cost a round trip to be
 * told the same thing, and the box says "keep typing" locally instead.
 */
const MIN_LENGTH = 2;

export function SellerCompanyPicker({
  selected,
  onSelect,
  onClear,
}: {
  /** The company currently chosen, or null. */
  selected: SellerSuggestion | null;
  onSelect: (seller: SellerSuggestion) => void;
  onClear: () => void;
}): React.JSX.Element {
  const { t } = useI18n();

  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  /** Index into the list, or -1 for "nothing is being moved over". */
  const [highlight, setHighlight] = useState(-1);

  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();

  // What is in the box runs ahead of what the server has been asked, by up to
  // the debounce.
  useEffect(() => {
    const trimmed = draft.trim();
    if (trimmed === search) return undefined;

    const timer = setTimeout(() => {
      setSearch(trimmed);
      setHighlight(-1);
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [draft, search]);

  const isSearchable = search.length >= MIN_LENGTH;

  const query = useQuery({
    queryKey: sellerSearchKey(search),
    queryFn: () => fetchSellerSuggestions(search),
    enabled: isSearchable && isOpen,
    // A company list does not change while somebody is typing a name, and
    // going back a character should not cost a second request.
    staleTime: 30 * 1000,
  });

  const suggestions = useMemo(() => query.data?.sellers ?? [], [query.data]);

  // Close on an outside click or Escape - the same contract as the bell and
  // the account menu. Without the Escape handler a keyboard user who opens the
  // list has no way back out of it.
  useEffect(() => {
    if (!isOpen) return undefined;

    const onPointerDown = (event: MouseEvent): void => {
      if (containerRef.current?.contains(event.target as Node) !== true) setIsOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [isOpen]);

  const choose = (seller: SellerSuggestion): void => {
    onSelect(seller);
    setIsOpen(false);
    setDraft('');
    setSearch('');
    setHighlight(-1);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      setIsOpen(false);
      setHighlight(-1);
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Prevented so the caret does not jump to either end of the box while
      // the list is being moved through.
      event.preventDefault();
      if (suggestions.length === 0) return;
      setIsOpen(true);

      setHighlight((current) => {
        const next = event.key === 'ArrowDown' ? current + 1 : current - 1;
        // Wraps, because a list of eight is short enough that running off the
        // end and starting again is what somebody expects.
        if (next >= suggestions.length) return 0;
        if (next < 0) return suggestions.length - 1;
        return next;
      });
      return;
    }

    if (event.key === 'Enter') {
      const picked = suggestions[highlight];
      if (picked !== undefined) {
        event.preventDefault();
        choose(picked);
      }
    }
  };

  // A company is chosen: the picker becomes a statement of which one, with the
  // way back out beside it. A search box that still offered a list would
  // invite somebody to type over a selection they had already made.
  if (selected !== null) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-sunken px-3 py-2">
        <span className="text-sm font-semibold text-ink">{selected.displayName}</span>
        <span className="font-mono text-xxs text-ink-subtle">{selected.sellerCode}</span>
        <span className="text-xs text-ink-muted">
          {t('sellerWarehouses.warehouseCount', { count: selected.activeWarehouseCount })}
        </span>
        <button
          type="button"
          onClick={() => {
            onClear();
            // Focus returns to where the control will be, so a keyboard user
            // is not dropped at the top of the document by clearing.
            window.setTimeout(() => inputRef.current?.focus(), 0);
          }}
          className="ml-auto rounded text-xs font-medium text-accent underline-offset-2 transition-colors hover:text-accent-hover hover:underline"
        >
          {t('sellerWarehouses.changeCompany')}
        </button>
      </div>
    );
  }

  const showList = isOpen && isSearchable;

  return (
    <div ref={containerRef} className="relative">
      <Input
        ref={inputRef}
        type="search"
        role="combobox"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setIsOpen(true);
        }}
        onFocus={() => {
          setIsOpen(true);
        }}
        onKeyDown={onKeyDown}
        placeholder={t('sellerWarehouses.searchPlaceholder')}
        aria-label={t('sellerWarehouses.searchLabel')}
        aria-expanded={showList}
        aria-controls={showList ? listboxId : undefined}
        aria-autocomplete="list"
        // What the screen reader announces as the highlight moves. A visual
        // ring alone says nothing to somebody who cannot see it.
        aria-activedescendant={
          highlight >= 0 && suggestions[highlight] !== undefined
            ? `${listboxId}-${suggestions[highlight].sellerAccountId}`
            : undefined
        }
      />

      {showList && (
        <div className="absolute z-30 mt-1 w-full overflow-hidden rounded-md border border-border bg-surface shadow-popover">
          {query.isPending && (
            <p className="px-3 py-3 text-xs text-ink-muted">{t('common.loading')}</p>
          )}

          {query.isError && (
            <div className="px-3 py-3">
              <p className="text-xs text-danger">{t('sellerWarehouses.searchFailed')}</p>
              <button
                type="button"
                onClick={() => {
                  void query.refetch();
                }}
                className="mt-1 rounded text-xs font-medium text-accent underline-offset-2 hover:underline"
              >
                {t('common.retry')}
              </button>
            </div>
          )}

          {query.data !== undefined && suggestions.length === 0 && (
            <div className="px-3 py-3">
              <p className="text-sm text-ink">{t('sellerWarehouses.noCompanies')}</p>
              {/* Says WHY nothing matched, because the commonest reason is not
                  a typo: the company is there and is not approved, and an
                  operator who does not know that keeps retyping the name. */}
              <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                {t('sellerWarehouses.noCompaniesHint')}
              </p>
            </div>
          )}

          {suggestions.length > 0 && (
            <ul id={listboxId} role="listbox" aria-label={t('sellerWarehouses.searchLabel')}>
              {suggestions.map((seller, index) => (
                <li
                  key={seller.sellerAccountId}
                  id={`${listboxId}-${seller.sellerAccountId}`}
                  role="option"
                  aria-selected={index === highlight}
                >
                  <button
                    type="button"
                    // Mouse down rather than click: the input's blur would
                    // otherwise close the list before the click landed.
                    onMouseDown={(event) => {
                      event.preventDefault();
                      choose(seller);
                    }}
                    onMouseEnter={() => {
                      setHighlight(index);
                    }}
                    className={cx(
                      'flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2 text-left',
                      index === highlight ? 'bg-accent-soft' : 'bg-surface',
                    )}
                  >
                    <span className="text-sm font-medium text-ink">{seller.displayName}</span>
                    <span className="font-mono text-xxs text-ink-subtle">{seller.sellerCode}</span>
                    <span className="text-xxs text-ink-muted">{seller.registrationCountry}</span>
                    <span className="ml-auto text-xxs text-ink-muted">
                      {t('sellerWarehouses.warehouseCount', {
                        count: seller.activeWarehouseCount,
                      })}
                    </span>
                  </button>
                </li>
              ))}

              {/* There are more, and the answer was cut. Saying so beats
                  letting somebody conclude their company is not on the
                  marketplace. */}
              {query.data?.isTruncated === true && (
                <li className="border-t border-border-subtle px-3 py-2 text-xxs text-ink-muted">
                  {t('sellerWarehouses.moreCompanies', { count: suggestions.length })}
                </li>
              )}
            </ul>
          )}
        </div>
      )}

      {isOpen && !isSearchable && (
        <p className="absolute z-30 mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-xs text-ink-muted shadow-popover">
          {t('sellerWarehouses.keepTyping', { count: MIN_LENGTH })}
        </p>
      )}
    </div>
  );
}
