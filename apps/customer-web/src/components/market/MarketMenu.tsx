/**
 * One control for the three questions that decide what the storefront says
 * and what its numbers mean: what language you read it in, where you are
 * ordering from, and what you are quoted in.
 *
 * They used to be three `<select>`s in a row — a native control each, which is
 * the right default and was the wrong answer here for two measurable reasons.
 * Three of them together were 481px of chrome in a 345px viewport, so the
 * whole page scrolled sideways on a phone and the header grew a second sticky
 * band to hold them. And a `<select>` of 43 countries cannot be searched: the
 * platform picker type-ahead matches the first letter only, so finding
 * Netherlands means pressing N four times.
 *
 * So the three collapse into one trigger that states the current answer — flag,
 * language code, country, currency — and one panel that lets all three be
 * changed together and applied once. Changing them together matters: picking
 * "Germany" and then "euro" as two separate acts reprices the entire catalogue
 * twice and restamps the cart twice, and the shopper watches two rounds of
 * skeletons for one decision.
 *
 * Three rules this follows.
 *
 * **Nothing is applied until Apply.** Every other control in this header acts
 * on change, and this one deliberately does not: it is three coupled answers,
 * and a country whose currency the deployment does not price in has to be
 * *shown* to be a problem before it is acted on rather than silently reverting.
 *
 * **The location is never taken, only offered.** The browser's own reading —
 * from the time zone, which needs no permission — appears as a suggestion
 * beside the list. There is no automatic permission prompt: see `lib/geo.ts`
 * for why the time zone is the better signal anyway, and `CountryPicker` for
 * the one place in the app that does ask, where the shopper can see why.
 *
 * **The answer is saved where it will be found again.** A signed-in shopper's
 * choice goes to their profile, a guest's to this browser. Neither is this
 * component's business — `LocaleProvider.choose` and the i18n provider own
 * both, and this only calls them.
 *
 * Two presentations, one DOM: an anchored dropdown from `lg`, a bottom sheet
 * below it. A 43-row list in a 280px popover pinned to the top-right corner of
 * a phone is a list you scroll with your thumb over the content you were
 * reading.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLocale } from '@/app/locale-context';
import { CountryFlag } from '@/components/CountryFlag';
import { CheckIcon, ChevronDownIcon, CloseIcon, SearchIcon } from '@/components/icons';
import { Button } from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { cx } from '@/lib/cx';
import { useI18n } from '@/i18n/i18n-context';
import { isLanguageCode } from '@/i18n/config';
import { LANGUAGES } from '@/i18n/languages';
import type { LanguageCode } from '@/i18n/languages';

/** What the panel is holding before Apply commits it. */
interface Draft {
  country: string;
  language: LanguageCode;
  currency: string;
}

/**
 * Normalise for searching.
 *
 * `NFD` then stripping combining marks, so typing "osterreich" finds Österreich
 * and "espana" finds España. A country list a European buyer cannot search
 * without reaching for their accent keys is a country list they scroll.
 */
function searchKey(value: string): string {
  let out = '';

  for (const character of value.normalize('NFD')) {
    const code = character.codePointAt(0) ?? 0;

    // Combining Diacritical Marks, U+0300 to U+036F. NFD has just split every
    // accented letter into a plain letter followed by one of these, so
    // dropping them is the whole trick. Written as a numeric comparison rather
    // than as a character class: the literals in a class are invisible in an
    // editor, and the first person to reformat this file would delete them
    // without ever knowing they were there.
    if (code >= 0x0300 && code <= 0x036f) continue;

    out += character;
  }

  return out.toLowerCase();
}

export function MarketMenu({ className }: { className?: string }): React.JSX.Element | null {
  const locale = useLocale();
  const toast = useToast();
  const { t, language, setLanguage } = useI18n();

  const [isOpen, setIsOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const panelId = useId();

  /*
   * Close on outside click or Escape, and give focus back to the trigger.
   *
   * Returning focus is not a nicety: this panel can be several screens tall on
   * a phone, and a keyboard user who escapes it would otherwise be dropped at
   * the top of the document with no idea where they were.
   */
  useEffect(() => {
    if (!isOpen) return undefined;

    const onPointerDown = (event: MouseEvent): void => {
      if (containerRef.current?.contains(event.target as Node) !== true) setIsOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setIsOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  // The search box takes focus on open, because searching is what the panel is
  // for. jsdom and a touch keyboard both cope: `focus()` on an input that is
  // already visible does not raise the on-screen keyboard on iOS.
  useEffect(() => {
    if (isOpen) searchRef.current?.focus();
  }, [isOpen]);

  const currentCountry = useMemo(
    () => locale.countries.find((entry) => entry.code === locale.country) ?? null,
    [locale.countries, locale.country],
  );

  const currentCurrency = useMemo(
    () => locale.currencies.find((entry) => entry.code === locale.currency) ?? null,
    [locale.currencies, locale.currency],
  );

  /*
   * Nothing to choose between.
   *
   * A single-market, single-currency deployment gets no control at all, which
   * is the same rule the two switchers this replaced followed. The language
   * list is not part of the test: it is a compile-time constant of eight
   * catalogues, so a check against it is a condition the type system already
   * knows the answer to — and the language picker is the one control somebody
   * stuck in a language they cannot read has to be able to find.
   */
  if (locale.countries.length < 2 && locale.currencies.length < 2) {
    return null;
  }

  const open = (): void => {
    setDraft({
      // A shopper who has never answered opens on the browser's suggestion
      // rather than on nothing, so the common case is one press.
      country: locale.country ?? locale.detectedCountry ?? '',
      language: isLanguageCode(language) ? language : 'en',
      currency: locale.currency,
    });
    setTerm('');
    setError(null);
    setIsOpen(true);
  };

  const close = (): void => {
    setIsOpen(false);
    triggerRef.current?.focus();
  };

  const matches = locale.countries.filter((entry) => {
    if (term.trim() === '') return true;
    const needle = searchKey(term.trim());
    return searchKey(entry.name).includes(needle) || searchKey(entry.code).startsWith(needle);
  });

  /** The currency the drafted country is quoted in by default, if we price it. */
  const draftCountryCurrency = (code: string): string | null => {
    const wanted = locale.countries.find((entry) => entry.code === code)?.currencyCode;
    if (wanted === undefined) return null;
    return locale.currencies.some((entry) => entry.code === wanted) ? wanted : null;
  };

  const chooseCountry = (code: string): void => {
    setDraft((current) => {
      if (current === null) return current;

      // Picking a country adopts that country's currency, which is what
      // somebody selecting "Germany" means. The currency list below is how
      // they say otherwise, and it leaves the country alone.
      return {
        ...current,
        country: code,
        currency: draftCountryCurrency(code) ?? current.currency,
      };
    });
  };

  const apply = async (): Promise<void> => {
    if (draft === null) return;

    setIsSaving(true);
    setError(null);

    try {
      // Language first, and not inside the same await as the reprice: it is a
      // separate preference on a separate row, and a failed currency save must
      // not leave somebody stuck in a language they cannot read.
      if (draft.language !== language) setLanguage(draft.language);

      const currencyMoved = draft.currency !== locale.currency;
      const countryMoved = draft.country !== '' && draft.country !== locale.country;

      if (currencyMoved || countryMoved) {
        if (draft.country === '') await locale.setCurrency(draft.currency);
        else await locale.choose(draft.country, draft.currency);

        /*
         * Say that the numbers moved.
         *
         * Every price on screen has just been requoted from the server — a
         * different price list, and a different destination's tax on top of it
         * — and the cart with them. A catalogue whose figures change while
         * somebody is reading it, with nothing said, is the single most
         * expensive silence this storefront can produce.
         */
        toast.success(
          t('market.pricesRequoted', {
            country:
              locale.countries.find((entry) => entry.code === draft.country)?.name ?? draft.country,
            currency: draft.currency,
          }),
        );
      }

      close();
    } catch {
      setError(t('market.thatCouldNotBeSaved'));
    } finally {
      setIsSaving(false);
    }
  };

  const triggerLanguage = (isLanguageCode(language) ? language : 'en').toUpperCase();
  const suggestion =
    locale.detectedCountry === null
      ? null
      : (locale.countries.find((entry) => entry.code === locale.detectedCountry) ?? null);

  return (
    <div ref={containerRef} className={cx('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (isOpen) close();
          else open();
        }}
        aria-expanded={isOpen}
        // A disclosure, not `aria-haspopup="menu"`. That role promises a
        // composite widget where arrow keys move between items; this is a form
        // in a panel, and announcing it as a menu would describe keyboard
        // behaviour it does not have.
        aria-controls={panelId}
        className="flex h-10 items-center gap-1.5 rounded-md border border-border-strong bg-surface px-2 text-ink transition-colors hover:border-border-hover hover:bg-surface-hover sm:px-2.5"
      >
        {/* The flag is the fastest of the four to read, so it leads. Where no
            country has been chosen yet there is nothing truthful to draw, and
            the language code carries the control on its own. */}
        {locale.country !== null && <CountryFlag code={locale.country} className="h-3.5 w-5" />}

        <span className="text-xs font-semibold tracking-wide">{triggerLanguage}</span>

        {/* The market, on wide screens only. Below `lg` the flag says it and
            the panel spells it out; a header that spends 140px on "United
            Arab Emirates · AED" has no room left for the cart. */}
        <span className="hidden min-w-0 items-baseline gap-1.5 lg:flex">
          {currentCountry !== null && (
            <span className="max-w-[8rem] truncate text-xs text-ink-muted">
              {currentCountry.name}
            </span>
          )}
          {currentCurrency !== null && (
            <span className="whitespace-nowrap text-xs font-medium text-ink">
              {currentCurrency.symbol.trim()} {currentCurrency.code}
            </span>
          )}
        </span>

        <ChevronDownIcon
          className={cx(
            'h-4 w-4 shrink-0 text-ink-subtle transition-transform',
            isOpen && 'rotate-180',
          )}
        />

        {/* The accessible name. The visible parts are a flag, a code and two
            fragments, none of which says what pressing this does. */}
        <span className="sr-only">{t('market.trigger')}</span>
      </button>

      {/*
       * The scrim, phones only. A bottom sheet with the page still tappable
       * behind it is a sheet people dismiss by accident.
       *
       * A `<button>` rather than a `<div onClick>`: tapping outside to dismiss
       * has to be reachable by something other than a pointer, and a div with
       * a click handler is neither focusable nor announced. It carries a real
       * label for the same reason. Keyboard users have Escape as well, but a
       * switch or a screen-reader gesture user has only this.
       */}
      {isOpen && (
        <button
          type="button"
          onClick={close}
          className="fixed inset-0 z-40 cursor-default bg-ink/30 backdrop-blur-[2px] lg:hidden"
        >
          <span className="sr-only">{t('common.close')}</span>
        </button>
      )}

      {isOpen && draft !== null && (
        <div
          id={panelId}
          role="group"
          aria-label={t('market.heading')}
          /*
           * Bottom sheet under `lg`, anchored dropdown from it.
           *
           * `max-h` on both, with the list scrolling inside: 43 countries plus
           * eight languages plus the currencies is taller than a laptop
           * viewport, and a popover that runs off the bottom of the screen
           * takes its own Apply button with it.
           */
          className={cx(
            'z-50 flex flex-col overflow-hidden border border-border bg-surface shadow-popover',
            'fixed inset-x-0 bottom-0 max-h-[85vh] rounded-t-2xl',
            'lg:absolute lg:inset-x-auto lg:bottom-auto lg:right-0 lg:top-full lg:mt-2 lg:max-h-[32rem] lg:w-[22rem] lg:rounded-lg',
          )}
        >
          <div className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <p className="text-title-xs text-ink">{t('market.heading')}</p>
              <p className="mt-0.5 text-xs leading-snug text-ink-muted">
                {t('market.description')}
              </p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label={t('common.close')}
              className="-m-1 shrink-0 rounded p-1 text-ink-subtle transition-colors hover:text-ink"
            >
              <CloseIcon className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            {/* --- Language ------------------------------------------------ */}
            <fieldset className="mb-4">
              <legend className="mb-1.5 text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                {t('market.languageLabel')}
              </legend>

              {/* Every option in its own language and never translated into
                    the current one: somebody stuck in a language they cannot
                    read is scanning for the shape of "Ελληνικά", and rendering
                    that list as "Greek" in a language they cannot read is
                    precisely no help. */}
              <div className="flex flex-wrap gap-1.5">
                {LANGUAGES.map((entry) => (
                  <button
                    key={entry.code}
                    type="button"
                    aria-pressed={draft.language === entry.code}
                    onClick={() => {
                      setDraft({ ...draft, language: entry.code });
                    }}
                    className={cx(
                      'rounded-md border px-2.5 py-1.5 text-sm transition-colors',
                      draft.language === entry.code
                        ? 'border-brand bg-brand-soft font-semibold text-brand'
                        : 'border-border text-ink-muted hover:border-border-hover hover:bg-surface-hover hover:text-ink',
                    )}
                  >
                    {entry.endonym}
                  </button>
                ))}
              </div>
            </fieldset>

            {/* --- Country ------------------------------------------------- */}
            {locale.countries.length > 1 && (
              <div className="mb-4">
                <label
                  htmlFor={`${panelId}-search`}
                  className="mb-1.5 block text-xxs font-semibold uppercase tracking-wider text-ink-subtle"
                >
                  {t('market.countryLabel')}
                </label>

                <div className="relative">
                  <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle" />
                  <input
                    ref={searchRef}
                    id={`${panelId}-search`}
                    type="text"
                    value={term}
                    onChange={(event) => {
                      setTerm(event.target.value);
                    }}
                    placeholder={t('market.searchCountries')}
                    autoComplete="off"
                    className="h-9 w-full rounded-md border border-border-strong bg-surface pl-8 pr-3 text-sm text-ink placeholder:text-ink-subtle"
                  />
                </div>

                {suggestion !== null && term.trim() === '' && (
                  <p className="mt-2 text-xs text-ink-muted">
                    {t('market.browserSuggests', { country: suggestion.name })}{' '}
                    <button
                      type="button"
                      onClick={() => {
                        chooseCountry(suggestion.code);
                      }}
                      className="font-medium text-brand hover:underline"
                    >
                      {t('market.useThat')}
                    </button>
                  </p>
                )}

                {matches.length === 0 ? (
                  <p className="mt-3 text-sm text-ink-muted">{t('market.noCountriesMatch')}</p>
                ) : (
                  <ul className="mt-2 max-h-56 overflow-y-auto rounded-md border border-border">
                    {matches.map((entry) => {
                      const isChosen = draft.country === entry.code;

                      return (
                        <li key={entry.code}>
                          <button
                            type="button"
                            aria-pressed={isChosen}
                            onClick={() => {
                              chooseCountry(entry.code);
                            }}
                            className={cx(
                              'flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors',
                              isChosen
                                ? 'bg-brand-soft font-medium text-brand'
                                : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                            )}
                          >
                            <CountryFlag code={entry.code} className="h-3.5 w-5" />
                            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                            {isChosen && <CheckIcon className="h-4 w-4 shrink-0" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}

            {/* --- Currency ------------------------------------------------ */}
            {locale.currencies.length > 1 && (
              <fieldset>
                <legend className="mb-1.5 text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                  {t('market.currencyLabel')}
                </legend>

                <div className="flex flex-wrap gap-1.5">
                  {locale.currencies.map((entry) => (
                    <button
                      key={entry.code}
                      type="button"
                      aria-pressed={draft.currency === entry.code}
                      onClick={() => {
                        setDraft({ ...draft, currency: entry.code });
                      }}
                      className={cx(
                        'rounded-md border px-2.5 py-1.5 text-sm tabular transition-colors',
                        draft.currency === entry.code
                          ? 'border-brand bg-brand-soft font-semibold text-brand'
                          : 'border-border text-ink-muted hover:border-border-hover hover:bg-surface-hover hover:text-ink',
                      )}
                    >
                      {entry.symbol.trim()} {entry.code}
                    </button>
                  ))}
                </div>

                {/*
                 * The honest answer to an unpriced market.
                 *
                 * Staff can activate a country before anything is priced for
                 * the currency it uses, and the shopper must not be handed an
                 * empty shop for it. Saying which currency they will be quoted
                 * in instead is the fallback; silently leaving them on the old
                 * one and letting them discover it on the grid is not.
                 */}
                {draft.country !== '' && draftCountryCurrency(draft.country) === null && (
                  <p className="mt-2 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs leading-relaxed text-warning">
                    {t('market.currencyNotPriced', { currency: draft.currency })}
                  </p>
                )}
              </fieldset>
            )}

            {error !== null && (
              <p role="alert" className="mt-3 text-sm text-danger">
                {error}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-sunken px-4 py-3">
            <Button variant="secondary" size="sm" onClick={close} disabled={isSaving}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => void apply()} isLoading={isSaving}>
              {t('market.apply')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
