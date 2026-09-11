/**
 * "Delivers to" - the flaps that open over the map when a warehouse is
 * pointed at.
 *
 * It sits **over** the map rather than beside it, and that is the layout
 * decision the rest follows from. Beside it, this would be a third column next
 * to the map and the detail panel and there is not 1,400 pixels of room for
 * three; over it, the answer appears where the reader is already looking, and
 * the ring it describes is visible underneath and around it. The glass is what
 * makes that legible: a panel that floats over a map has to let the map
 * through or it reads as a screen that broke halfway through loading.
 *
 * **Every state is a state, and there are six of them.** Loading, no coverage,
 * not placed, failed, a list, and one card expanded. A panel that only draws
 * the happy path is a panel that shows a spinner forever the first time a
 * geocoder wrote a latitude of 999 into a row.
 *
 * **The flags are drawn, never emoji.** `CountryFlag` explains why at length:
 * Windows ships no font that composes regional-indicator pairs, so `🇳🇱`
 * renders as the letters "NL" in two boxes on the platform most operators run
 * this on. The API returns an emoji for its other consumers and this panel
 * ignores it.
 *
 * **This is the keyboard path to the feature**, not a decoration on the hover
 * one. The map is `aria-hidden` - everything on it is in the table below it,
 * which is the accessible copy - so the coverage answer could not be reached
 * by keyboard through a marker. It is reached through the button in the detail
 * panel, and from there every card here is a real `<button>` in the tab order.
 *
 * **It arrives and it leaves.** Arriving is a keyframe, because there is
 * nothing to interpolate from - the panel did not exist a frame ago. Leaving
 * is a *transition*, because it can be interrupted: a pointer that wandered
 * off a marker and came back inside the 260ms grace must find the panel where
 * it left it, and a transition picks the element up wherever it had got to. A
 * second keyframe would restart from the top and flash.
 *
 * The page is what keeps this mounted for the length of that exit - see
 * `useLingering` - and what it holds on to is the whole answer rather than a
 * flag, so what fades out is the panel that was being read rather than an
 * empty one or a spinner.
 *
 * **Motion is opt-out, not opt-in.** The cards flip in on a stagger; under
 * `prefers-reduced-motion: reduce` the whole animation is switched off by the
 * block in `index.css`, and because the flip animates only `transform` and
 * `opacity`, what is left is the finished card in its final position rather
 * than a hole.
 */
import { useEffect, useRef, useState } from 'react';
import { CountryFlag } from '@/components/CountryFlag';
import { Spinner } from '@/components/ui';
import { cx } from '@/lib/cx';
import { useI18n } from '@/i18n/i18n-context';
import type { CoveredCountry, DeliveryCoverage } from '@/lib/delivery-coverage';

/**
 * A distance in kilometres, in the reader's own number format.
 *
 * Not `formatNumber` from `lib/format`: that one is for counts and is built on
 * a module-level `Intl.NumberFormat()` with no locale and no fraction digits,
 * so 15.4 comes out as "15.4" in a German panel where it has to be "15,4". One
 * decimal, because the boundaries are drawn to about five kilometres and a
 * second decimal would be a lie told to another digit.
 */
function kilometres(value: number, intlLocale: string): string {
  return new Intl.NumberFormat(intlLocale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  }).format(value);
}

export type CoverageFailure = 'notPlaced' | 'error';

interface DeliveryCoveragePanelProps {
  /** The warehouse being asked about, for the heading. */
  warehouseName: string;
  radiusKm: number;
  coverage: DeliveryCoverage | null;
  isLoading: boolean;
  failure: CoverageFailure | null;
  /**
   * Dismiss. Present on touch, where the panel is opened by a tap and there is
   * no pointer to move away; absent on a hover-driven desktop, where moving
   * off the marker is what closes it and a button would be a second way to do
   * what already happened.
   */
  onClose?: (() => void) | undefined;
  /**
   * Nobody is pointing at this warehouse any more and the panel is on its way
   * out. Still mounted only because the page is holding it there for the
   * length of the transition.
   */
  isLeaving?: boolean;
}

/**
 * How long each card waits before flipping in, in milliseconds.
 *
 * 55ms reads as one gesture arriving in order. At 150 it reads as a queue, and
 * a warehouse in the Balkans with six neighbours would take most of a second
 * to finish drawing.
 */
const STAGGER_MS = 55;

/** Past this many cards the stagger stops growing, so the last one is not late. */
const STAGGER_CAP = 8;

/**
 * One country, as a flap.
 *
 * Collapsed it is the flag, the name and the distance; expanded it adds where
 * that distance was measured to. Expanding is a real disclosure rather than a
 * tooltip because the coordinates are the evidence for the number above them -
 * somebody checking whether "15.4 km" is plausible wants to know it is the
 * Dutch border north of Antwerp and not a Dutch island.
 */
function CountryFlap({
  country,
  index,
  isOpen,
  onToggle,
}: {
  country: CoveredCountry;
  index: number;
  isOpen: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  const { t, intlLocale } = useI18n();

  return (
    <li
      className="animate-flap-in [transform-style:preserve-3d]"
      style={{ animationDelay: `${String(Math.min(index, STAGGER_CAP) * STAGGER_MS)}ms` }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className={cx(
          'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left',
          // The glass, per card: a translucent plate that lifts on hover. The
          // ring rather than a border, so the plate keeps its exact size when
          // it lifts and the row below it does not shift by a pixel.
          'bg-surface/55 backdrop-blur-md ring-1 ring-inset',
          'transition duration-200 ease-out',
          'hover:-translate-y-px hover:bg-surface/75',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          /*
           * A closed country is drawn in the refusing colour rather than
           * dropped from the list.
           *
           * The radius decides what geometry reaches; the exclusion list
           * decides what the business serves. A country hidden here would be
           * indistinguishable from one 40 km too far away - and the first is a
           * decision somebody made and may want to undo. So it stays, and it
           * looks like a refusal.
           */
          country.isExcluded
            ? cx(
                'ring-danger/45 hover:ring-danger/70',
                isOpen ? 'bg-danger-soft/85' : 'bg-danger-soft/60',
              )
            : cx('ring-border/70 hover:ring-brand/45', isOpen && 'bg-surface/80 ring-brand/50'),
        )}
      >
        <CountryFlag code={country.code ?? '??'} className="h-4 w-6" />

        <span className="min-w-0 flex-1">
          <span
            className={cx(
              'block truncate text-xs font-semibold',
              // Struck through as well as tinted: the state has to survive
              // being read by somebody who cannot tell the two colours apart,
              // and the "Closed" chip below says it in words.
              country.isExcluded ? 'text-ink line-through decoration-danger/70' : 'text-ink',
            )}
          >
            {country.name}
          </span>
          <span className="block text-xxs tabular-nums text-ink-muted">
            {t('warehouses.coverage.borderDistance', {
              km: kilometres(country.distanceKm, intlLocale),
            })}
          </span>
        </span>

        {/* The code, as the quiet anchor on the right. A reader scanning six
            of these for "is BE in here" finds two letters faster than a name.
            A closed country carries the word instead, because the state is
            what matters more than the code. */}
        {country.isExcluded ? (
          <span className="shrink-0 rounded bg-danger-fill px-1.5 py-0.5 text-xxs font-bold tracking-wide text-white">
            {t('warehouses.coverage.excluded')}
          </span>
        ) : (
          <span className="shrink-0 rounded bg-brand-soft px-1.5 py-0.5 text-xxs font-bold tracking-wide text-brand">
            {country.code ?? '—'}
          </span>
        )}
      </button>

      {isOpen && (
        <dl className="mt-1 space-y-1 rounded-lg bg-surface/45 px-2.5 py-2 text-xxs ring-1 ring-inset ring-border/60 backdrop-blur-md">
          {country.isExcluded && (
            <>
              <p className="font-medium leading-relaxed text-danger">
                {t('warehouses.coverage.excludedNote')}
              </p>
              <p className="leading-relaxed text-ink-muted">
                {country.exclusionReason ?? t('warehouses.coverage.noReason')}
              </p>
            </>
          )}

          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-ink-subtle">{t('warehouses.coverage.nearestBorder')}</dt>
            <dd className="tabular-nums text-ink">
              {country.nearestPoint.latitude.toFixed(4)}, {country.nearestPoint.longitude.toFixed(4)}
            </dd>
          </div>
          <p className="leading-relaxed text-ink-muted">
            {t('warehouses.coverage.nearestBorderNote')}
          </p>
        </dl>
      )}
    </li>
  );
}

export function DeliveryCoveragePanel({
  warehouseName,
  radiusKm,
  coverage,
  isLoading,
  failure,
  onClose,
  isLeaving = false,
}: DeliveryCoveragePanelProps): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const [openCode, setOpenCode] = useState<string | null>(null);

  /**
   * A card left open for a warehouse nobody is pointing at any more would
   * reopen the moment the next one is hovered. Keyed on the warehouse rather
   * than the coverage object, which is a fresh object on every refetch.
   */
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    const id = coverage?.warehouse.id ?? null;
    if (shownFor.current !== id) {
      shownFor.current = id;
      setOpenCode(null);
    }
  }, [coverage?.warehouse.id]);

  const radius = kilometres(radiusKm, intlLocale);

  /** How many of the countries in range the operator has closed. */
  const excludedCount = (coverage?.countries ?? []).filter((country) => country.isExcluded).length;

  return (
    <div
      className={cx(
        // Over the map, top-right, clear of the zoom buttons on the left. Its
        // own scroll at a height that cannot push past the map's own.
        'pointer-events-auto absolute right-3 top-3 z-10 flex max-h-[calc(100%-1.5rem)] w-[15.5rem] flex-col',
        'rounded-xl bg-surface/70 ring-1 ring-inset ring-border/70 backdrop-blur-xl',
        // The lift. A soft, wide shadow plus the faintest brand glow, which is
        // what separates glass from a flat translucent rectangle.
        'shadow-[0_18px_40px_-16px_rgb(var(--brand)/0.35),0_2px_8px_-2px_rgb(0_0_0/0.25)]',
        'animate-flap-panel-in',
        // The exit, and the way back from a half-finished one. Transform and
        // opacity only, so it is composited; `duration-200` is
        // COVERAGE_EXIT_MS and the two have to stay equal.
        'transition-[opacity,transform] duration-200 ease-out',
        isLeaving
          ? // Out the way it came in, and out of the way while it goes: a
            // fading panel that still swallowed a drag of the map underneath
            // it would be a worse fault than the one the fade fixes.
            'pointer-events-none translate-x-2 scale-[0.98] opacity-0'
          : 'translate-x-0 scale-100 opacity-100',
      )}
      // The map around it is aria-hidden; this is not, and it is the accessible
      // copy of what the ring and the arcs are drawing.
      role="region"
      aria-label={t('warehouses.coverage.regionLabel', { name: warehouseName })}
    >
      <div className="flex items-start gap-2 px-3 pt-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-xxs font-bold uppercase tracking-wider text-brand">
            {t('warehouses.coverage.title')}
          </p>
          <p className="truncate text-xs font-semibold text-ink">{warehouseName}</p>
          <p className="text-xxs text-ink-muted">
            {t('warehouses.coverage.withinRadius', { km: radius })}
          </p>
          {/* Where that radius came from. The same number is three different
              statements - this warehouse's own promise, the deployment's
              default, or a figure somebody is trying out - and an operator
              setting up a second warehouse needs to know which. */}
          {coverage !== null && (
            <p className="text-xxs text-ink-subtle">
              {coverage.radiusSource === 'WAREHOUSE'
                ? t('warehouses.coverage.radiusFromWarehouse')
                : coverage.radiusSource === 'DEPLOYMENT_DEFAULT'
                  ? t('warehouses.coverage.radiusFromDefault')
                  : t('warehouses.coverage.radiusFromRequest')}
            </p>
          )}
        </div>

        {onClose !== undefined && (
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 shrink-0 rounded-md p-1 text-ink-subtle transition hover:bg-surface-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('warehouses.coverage.close')}
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true" focusable="false">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          </button>
        )}
      </div>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2.5 pb-2.5">
        {isLoading && (
          <p
            role="status"
            // A floor under the one state that is shorter than all the
            // others, so the panel does not collapse to the height of a
            // spinner and grow back a moment later when the countries land.
            className="flex min-h-[4rem] items-center gap-2 px-0.5 py-3 text-xs text-ink-muted"
          >
            <Spinner className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
            {t('warehouses.coverage.loading')}
          </p>
        )}

        {/* Two failures, two messages, because they have two fixes. One is
            "add the coordinates", which the reader can do; the other is "the
            request did not come back", which they can retry. */}
        {!isLoading && failure !== null && (
          <p role="alert" className="px-0.5 py-2 text-xs leading-relaxed text-ink-muted">
            {failure === 'notPlaced'
              ? t('warehouses.coverage.notPlaced')
              : t('warehouses.coverage.failed')}
          </p>
        )}

        {!isLoading && failure === null && coverage !== null && (
          <>
            {/* The country the warehouse stands in, above the line. Not one of
                the flaps: "delivers to" is a list of places the radius reaches,
                and the building's own country is not news. */}
            {coverage.home !== null && (
              <p className="mb-2 flex items-center gap-2 px-0.5 text-xxs text-ink-muted">
                <CountryFlag code={coverage.home.code ?? '??'} className="h-3 w-[1.125rem]" />
                {t('warehouses.coverage.basedIn', { country: coverage.home.name })}
              </p>
            )}

            {coverage.countries.length === 0 ? (
              // The honest empty answer, and the one the whole feature is
              // judged on. A warehouse in central Spain reaches no foreign
              // border inside 100 km, and this says so rather than offering
              // the nearest country as though it were in range.
              <p className="px-0.5 py-2 text-xs leading-relaxed text-ink-muted">
                {t('warehouses.coverage.noneInRange', { km: radius })}
              </p>
            ) : (
              <>
                <p className="mb-1.5 px-0.5 text-xxs font-medium text-ink-subtle">
                  {t('warehouses.coverage.count', { count: coverage.countries.length })}
                </p>
                {/* Said separately from the count above rather than folded
                    into it. "Six countries, two of them closed" is two facts,
                    and a reader deciding whether the geofence is right needs
                    the second one to stand out rather than be arithmetic. */}
                {excludedCount > 0 && (
                  <p className="mb-1.5 px-0.5 text-xxs font-medium text-danger">
                    {t('warehouses.coverage.excludedCount', { count: excludedCount })}
                  </p>
                )}
                <ul className="space-y-1.5 [perspective:900px]">
                  {coverage.countries.map((country, index) => (
                    <CountryFlap
                      key={country.code ?? `${country.name}-${String(index)}`}
                      country={country}
                      index={index}
                      isOpen={openCode === (country.code ?? country.name)}
                      onToggle={() => {
                        const key = country.code ?? country.name;
                        setOpenCode((current) => (current === key ? null : key));
                      }}
                    />
                  ))}
                </ul>
              </>
            )}

            {/*
              The exclusions that are currently doing nothing.

              Kept and shown rather than quietly dropped: a radius grows, and
              somebody who closed Switzerland at 300 km has said something that
              must still hold at 800. It is also how an exclusion added to the
              wrong warehouse gets found - otherwise it is invisible until the
              day it starts to bite.
            */}
            {coverage.dormantExclusions.length > 0 && (
              <div className="mt-3 border-t border-border/60 pt-2">
                <p className="px-0.5 text-xxs font-medium text-ink-subtle">
                  {t('warehouses.coverage.dormantTitle')}
                </p>
                <ul className="mt-1.5 flex flex-wrap gap-1">
                  {coverage.dormantExclusions.map((country) => (
                    <li
                      key={country.code}
                      className="flex items-center gap-1 rounded bg-surface/55 px-1.5 py-1 ring-1 ring-inset ring-border/60 backdrop-blur-md"
                      // The reason, on a title rather than in the flow: these
                      // are not acting on anything today, so they get a line
                      // of the panel rather than a card each.
                      title={country.reason ?? t('warehouses.coverage.noReason')}
                    >
                      <CountryFlag code={country.code} className="h-3 w-[1.125rem]" />
                      <span className="text-xxs text-ink-muted">{country.name}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 px-0.5 text-xxs leading-relaxed text-ink-subtle">
                  {t('warehouses.coverage.dormantNote')}
                </p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
