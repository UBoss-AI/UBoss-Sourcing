/**
 * Language, and the market this sign-in is being priced against — one control
 * in the top bar.
 *
 * It replaces three separate chips: the language `<select>`, the sign-in
 * location, and the market indicator. Three controls answering one question
 * ("where am I and what am I reading?") took 380px of a bar that also has to
 * hold a page title, a notification bell and an account menu, and on a laptop
 * they were the reason the account menu was the first thing to get squeezed.
 * The storefront had the same problem with three `<select>`s and solved it the
 * same way — see `components/market/MarketMenu.tsx` there. This is that
 * control, in the panel, with the panel's own semantics.
 *
 * ---
 *
 * **The market is a label here, and that is not an oversight.**
 *
 * On the storefront the country and currency are a *choice*: a shopper says
 * which market they are buying in and every price requotes. In this panel they
 * are a *fact* about the session, resolved from the position the browser gave
 * at sign-in, and making them selectable was considered and rejected before
 * either chip existed. The argument is worth repeating because this control
 * looks like the storefront's, and somebody will reasonably ask why it does
 * not behave like it:
 *
 *   - **A picker over the market** would let any member of staff read the
 *     whole catalogue against a member state nobody in the business sells in,
 *     and the one number they could not then check is the number they were
 *     checking. Somebody who needs German prices is somebody signing in from
 *     Germany. The market is not the currency, either: Germany, the
 *     Netherlands and Ireland are all euro and charge 19%, 21% and 23% on the
 *     same box, so the country decides both which VAT rate lands and which
 *     price list is read.
 *   - **A picker over the location** would let somebody claim a place they are
 *     not in, which is the opposite of what a sign-in location is for. The
 *     position is what the browser reported.
 *
 * Why either is on screen at all: a column headed "Customer pays" is only
 * honest if the reader can see *which* customer, and a self-hosted console is
 * shared by several staff accounts behind nothing but a password — the same
 * laptop gets handed round a warehouse, staff travel, and the panel quietly
 * changes what it prices and what language it speaks when they do. The
 * sign-in bell said so once at 09:04 and has been scrolled away since
 * mid-morning; this is what still says it at four in the afternoon.
 *
 * So the panel states both, with the currency, and offers the one thing that
 * genuinely is the reader's to choose: which language the interface is in.
 *
 * **It degrades to exactly what it can say.** No country resolved, no market
 * that changes a price, no geocoded place — each disappears independently, and
 * with all three gone this is a language control with a flagless trigger,
 * which is what a single-market deployment with the location feature off
 * should see.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { CountryFlag } from '@/components/CountryFlag';
import { ChevronDownIcon, PinIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { cx } from '@/lib/cx';
import { isLanguageCode } from '@/i18n/config';
import { useI18n } from '@/i18n/i18n-context';
import { LANGUAGES } from '@/i18n/languages';

interface ConfigResponse {
  localisation: {
    countries: { code: string; name: string }[];
    baseCurrency?: string;
    locationPricing?: boolean;
  };
}

/**
 * The first two parts of a geocoded place.
 *
 * Nominatim answers "Shivajinagar, Pune, Pune District, Maharashtra, 411005,
 * India", and the whole of it in a 16px bar would push the account menu off a
 * laptop screen. The neighbourhood and the city are the part a person reads;
 * the full string stays in the panel below, so nothing is hidden, only folded.
 * The coordinate fallback — "18.5204, 73.8567" — comes through unharmed,
 * having exactly two parts.
 */
function shortPlace(place: string): string {
  const parts = place
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) return place.trim();
  return parts.slice(0, 2).join(', ');
}

export function LocaleMenu({ className }: { className?: string }): React.JSX.Element {
  const { language, setLanguage, isMachineTranslated, t } = useI18n();
  const { user } = useSession();

  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // The same query key every page that needs the currency list uses, so the
  // config document is fetched once for the whole panel.
  const config = useQuery({
    queryKey: ['storefront-config'],
    queryFn: () => api.get<ConfigResponse>('/config'),
    staleTime: 5 * 60_000,
    // A config read must never take the panel down with it: without it there
    // is no market label, which is the state a single-market deployment is in
    // anyway.
    retry: false,
    enabled: user !== null,
  });

  /*
   * Close on an outside press or Escape, and give focus back to the trigger.
   *
   * Returning focus is not a nicety: a keyboard user who escapes this panel
   * would otherwise be dropped at the top of the document with no idea where
   * they had been.
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

  const country = user?.locationCountry ?? null;
  const currency = user?.locationCurrency ?? null;
  const place = user?.locationPlace ?? null;
  const base = config.data?.localisation.baseCurrency ?? null;

  /*
   * Whether being in this country changes a price at all, which is the only
   * reason to name it. Two separate ways it can: the VAT *rate* differs
   * between member states, or the market reads a different *price list*
   * because its currency is not the seller's — which is true in an Indian
   * deployment with a dollar price list as much as in a European one. Where
   * neither holds, every buyer is quoted the listed figure in the listed
   * currency, and naming a country would suggest a difference that does not
   * exist.
   *
   * `!== false` rather than a truthy test: a config response cached from
   * before the flag existed must not read as "location changes nothing".
   */
  const changesRate = config.data?.localisation.locationPricing !== false;
  const changesPriceList = currency !== null && base !== null && currency !== base;
  const marketMatters = country !== null && (changesRate || changesPriceList);

  // The configured name, never a hard-coded list: the deployment decides what
  // its countries are called. Falling back to the code keeps the label
  // truthful while config loads, and for a country the geocoder named that
  // this business does not sell in.
  const countryName =
    config.data?.localisation.countries.find((entry) => entry.code === country)?.name ??
    country;


  return (
    <div ref={containerRef} className={cx('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setIsOpen(!isOpen);
        }}
        aria-expanded={isOpen}
        // A disclosure, not `aria-haspopup="menu"`: that role promises a
        // composite widget where arrow keys move between items, and this is a
        // set of controls in a panel.
        aria-controls={panelId}
        className="flex h-9 items-center gap-1.5 rounded-md border border-border bg-surface px-2 text-ink transition-colors hover:border-border-hover hover:bg-surface-hover sm:px-2.5"
      >
        {/*
          * The flag leads, because it is the fastest thing here to read, and
          * it follows the *country* rather than the market.
          *
          * Those are two different questions and they were briefly answered by
          * one condition. "Which country is this sign-in from" has an answer
          * whenever the browser resolved one; "does being in that country
          * change a price" is the narrower question below, and in a
          * single-market deployment the answer is no. Gating the flag on the
          * narrow one hid it on every such install — while the panel was
          * perfectly able to say India.
          *
          * Absent only where no country resolved at all, which is a deployment
          * with the location feature off or a plain-HTTP install with no
          * Geolocation API. The language code then carries the trigger alone.
          */}
        {country !== null && <CountryFlag code={country} className="h-3.5 w-5" />}

        <span className="text-xs font-semibold tracking-wide">{language.toUpperCase()}</span>

        {/* The market, on wide screens only. Below `lg` the flag says it and
            the panel spells it out. */}
        <span className="hidden min-w-0 items-baseline gap-1.5 lg:flex">
          {marketMatters && (
            <span className="max-w-[8rem] truncate text-xs text-ink-muted">{countryName}</span>
          )}
          {marketMatters && currency !== null && (
            <span className="whitespace-nowrap text-xs font-medium text-ink">{currency}</span>
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
        <span className="sr-only">{t('locale.trigger')}</span>
      </button>

      {isOpen && (
        <div
          id={panelId}
          role="group"
          aria-label={t('locale.trigger')}
          className="absolute right-0 top-full z-40 mt-1.5 w-72 rounded-lg border border-border bg-surface p-3 shadow-lift"
        >
          {/* --- The choice ------------------------------------------------ */}
          <fieldset>
            <legend className="mb-2 text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
              {t('language.label')}
            </legend>

            <div className="flex flex-wrap gap-1.5">
              {LANGUAGES.map((entry) => (
                <button
                  key={entry.code}
                  type="button"
                  aria-pressed={entry.code === language}
                  onClick={() => {
                    // The value can only come from this list, but the DOM is
                    // not a type system and a stray code must not put the
                    // panel into a language with no catalogue.
                    if (isLanguageCode(entry.code)) setLanguage(entry.code);
                  }}
                  className={cx(
                    'rounded-md border px-2 py-1 text-xs transition-colors',
                    entry.code === language
                      ? 'border-brand bg-brand-soft font-semibold text-brand'
                      : 'border-border text-ink hover:border-border-hover hover:bg-surface-hover',
                  )}
                >
                  {/* Its own language, never translated into the current one:
                      somebody stuck in a language they cannot read is scanning
                      for the shape of "Ελληνικά", and rendering that as
                      "Greek" in a language they cannot read is no help. */}
                  {entry.endonym}
                </button>
              ))}
            </div>
          </fieldset>

          {/* --- The facts ------------------------------------------------- */}
          {(marketMatters || place !== null) && (
            <div className="mt-3 space-y-2 border-t border-border-subtle pt-3">
              {marketMatters && (
                <div>
                  <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                    {t('locale.marketHeading')}
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-ink">
                    <CountryFlag code={country} className="h-3.5 w-5" />
                    {currency === null
                      ? t('market.customerIn', { country: countryName ?? '' })
                      : t('market.customerInCurrency', {
                          country: countryName ?? '',
                          currency,
                        })}
                  </p>
                </div>
              )}

              {place !== null && place.trim().length > 0 && (
                <div>
                  <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                    {t('locale.sessionHeading')}
                  </p>
                  <p className="mt-1 flex items-start gap-1.5 text-sm text-ink">
                    <PinIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-subtle" />
                    <span className="min-w-0">{shortPlace(place)}</span>
                  </p>
                  {/* The full geocoded string, folded rather than hidden. */}
                  <p className="mt-0.5 text-xxs leading-relaxed text-ink-subtle">{place}</p>
                </div>
              )}

              {/*
               * Why neither of the two above is a control.
               *
               * This panel looks like the storefront's, where both *are*
               * choices, so the difference has to be stated where somebody
               * looking for the picker will read it — not only in a source
               * comment they will never open.
               */}
              <p className="text-xxs leading-relaxed text-ink-subtle">
                {t('locale.notAChoice')}
              </p>
            </div>
          )}

          {/* The same caveat the old picker carried, in the same words: the
              seven translated catalogues are machine-translated, and staff
              acting on a translated label deserve to know that. */}
          {isMachineTranslated && (
            <p className="mt-3 border-t border-border-subtle pt-3 text-xxs leading-relaxed text-ink-subtle">
              {t('language.machineTranslated')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
