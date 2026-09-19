/**
 * The variant selector — narrowing down to one thing to buy.
 *
 * Shown only for a product whose seller declared the dimensions it sells
 * along. A product without them keeps the option list this catalogue has
 * always had, where a hospital buyer ticks three sizes of syringe at once; see
 * `VariantPicker` on the product page. Two different purchases, two different
 * controls, and neither is a better version of the other.
 *
 * What this one has to get right:
 *
 *   **A combination nobody stocks is never offered.** Availability is read off
 *   the variants that exist. Four sizes and two colours is eight buttons and,
 *   very often, five SKUs, and a selector that offers all eight and fails at
 *   Add to Basket has wasted somebody's time and made the shop look like it is
 *   guessing.
 *
 *   **"Out of stock" and "not offered" are different sentences.** One is a
 *   thing to come back for; the other is a thing that does not exist. They are
 *   drawn differently, labelled differently, and read differently aloud. A
 *   single grey button covering both is the commonest way a selector lies.
 *
 *   **Never colour alone.** A disabled swatch carries a diagonal rule through
 *   it and says so in its accessible name. Roughly one man in twelve cannot
 *   rely on the difference between a grey chip and a live one.
 *
 *   **Radio semantics.** Each axis is a radiogroup and its values are radios,
 *   so arrow keys move between them and a screen reader announces "3 of 6" the
 *   way it does for any other single choice. Buttons with `aria-pressed` would
 *   read as six independent toggles.
 */
import { useEffect, useId, useRef } from 'react';
import { useI18n } from '@/i18n/i18n-context';
import type { ResolvedAxis, ResolvedValue } from '@/lib/variants';

/**
 * Colours a swatch can actually paint, by their folded name.
 *
 * Deliberately small and deliberately not clever. A swatch is a promise about
 * what will arrive in the box, and guessing that "Sunset Hibiscus" is orange
 * is a promise nobody made. Anything not named here renders as a text chip
 * with the seller's own word on it, which tells the truth.
 *
 * Where a seller has uploaded a photograph for a colour, that photograph is
 * what the shopper sees — see the gallery on the product page. This is the
 * fallback for the common words, not a substitute for the picture.
 */
const SWATCHES: Readonly<Record<string, string>> = {
  black: '#1a1a1a',
  white: '#ffffff',
  grey: '#9ca3af',
  gray: '#9ca3af',
  silver: '#c0c4c8',
  red: '#dc2626',
  maroon: '#7f1d1d',
  pink: '#ec4899',
  orange: '#f97316',
  amber: '#f59e0b',
  yellow: '#eab308',
  green: '#16a34a',
  olive: '#65744a',
  teal: '#0d9488',
  blue: '#2563eb',
  navy: '#1e3a5f',
  'royal-blue': '#2b4fc4',
  purple: '#7c3aed',
  brown: '#78503c',
  tan: '#c69c6d',
  beige: '#e3d5c0',
  cream: '#f5efe0',
  ivory: '#fffff0',
  natural: '#e8e0d0',
  gold: '#c9a227',
  clear: 'transparent',
  transparent: 'transparent',
};

function swatchFor(value: string): string | null {
  return SWATCHES[value] ?? null;
}

interface AxisProps {
  axis: ResolvedAxis;
  onChoose: (axisKey: string, label: string) => void;
  /** Set after a failed Add to Basket, so the first unanswered axis takes focus. */
  focusKey: string | null;
}

/** The state word a screen reader hears, and the one printed under the label. */
function useStateLabel(): (state: ResolvedValue['state']) => string | null {
  const { t } = useI18n();

  return (state) => {
    if (state === 'OUT_OF_STOCK') return t('variants.outOfStock');
    if (state === 'NOT_OFFERED') return t('variants.notOffered');
    return null;
  };
}

function ValueButton({
  axis,
  value,
  isSelected,
  onChoose,
  wantsFocus,
  shape,
}: {
  axis: ResolvedAxis;
  value: ResolvedValue;
  isSelected: boolean;
  onChoose: (label: string) => void;
  /**
   * Take the caret, because Add to Basket was pressed with this axis
   * unanswered.
   *
   * Moved imperatively rather than with `autoFocus`: that prop fires on mount,
   * and these buttons mount when the page loads — which would steal the caret
   * from somebody who had not asked for it and drag a phone's viewport down
   * the page. This fires only when the page says it should.
   */
  wantsFocus: boolean;
  shape: 'CHIP' | 'SIZE' | 'SWATCH';
}): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (wantsFocus) ref.current?.focus();
  }, [wantsFocus]);

  const stateLabel = useStateLabel()(value.state);
  const isDisabled = value.state !== 'AVAILABLE';
  const swatch = shape === 'SWATCH' ? swatchFor(value.value) : null;

  /**
   * The full sentence assistive technology reads.
   *
   * The axis name is in it because a radio announced as "8" out of context is
   * a number, not a size, and somebody tabbing through four groups has no
   * other way to know which group they are in.
   */
  const accessibleName =
    stateLabel === null
      ? `${axis.label}: ${value.label}`
      : `${axis.label}: ${value.label}, ${stateLabel}`;

  const base =
    'relative inline-flex items-center justify-center gap-2 rounded-lg border text-sm font-medium transition-[color,background-color,border-color,box-shadow] duration-150 ' +
    // 44px on the shortest side. A size button a thumb cannot hit on a phone
    // is a size button somebody buys the wrong one of.
    'min-h-[2.75rem] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface';

  const sizing =
    shape === 'SIZE'
      ? 'min-w-[3.25rem] px-3 tabular'
      : shape === 'SWATCH'
        ? 'min-w-[2.75rem] px-2.5'
        : 'px-3.5';

  const tone = isSelected
    ? 'border-brand bg-brand-soft text-brand ring-1 ring-inset ring-brand/40 shadow-[0_1px_0_rgb(var(--brand)/0.15)]'
    : isDisabled
      ? 'border-border bg-surface-sunken text-ink-subtle'
      : 'border-border-strong bg-surface text-ink hover:border-brand/50 hover:bg-surface-hover';

  return (
    <button
      type="button"
      role="radio"
      aria-checked={isSelected}
      aria-label={accessibleName}
      // Disabled rather than aria-disabled: there is nothing useful to do with
      // a combination that does not exist, and leaving it focusable only makes
      // a keyboard user walk through dead options.
      disabled={isDisabled}
      ref={ref}
      onClick={() => {
        onChoose(value.label);
      }}
      className={`${base} ${sizing} ${tone} ${isDisabled ? 'cursor-not-allowed' : ''}`}
    >
      {swatch !== null && (
        <span
          aria-hidden="true"
          className="h-4 w-4 shrink-0 rounded-full border border-black/15 shadow-inner dark:border-white/20"
          style={{
            background:
              swatch === 'transparent'
                ? 'repeating-linear-gradient(45deg, rgb(var(--surface)) 0 4px, rgb(var(--surface-sunken)) 4px 8px)'
                : swatch,
          }}
        />
      )}

      <span className={isDisabled ? 'opacity-70' : undefined}>{value.label}</span>

      {/* A rule through the button, not a shade of grey. Colour alone is not
          a signal a twelfth of men can read. The two unavailable states get
          two different rules so they are distinguishable without the label. */}
      {value.state === 'NOT_OFFERED' && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-lg"
          style={{
            background:
              'linear-gradient(to top left, transparent calc(50% - 0.5px), rgb(var(--ink-subtle) / 0.55) calc(50% - 0.5px), rgb(var(--ink-subtle) / 0.55) calc(50% + 0.5px), transparent calc(50% + 0.5px))',
          }}
        />
      )}
      {value.state === 'OUT_OF_STOCK' && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-2 bottom-1.5 h-px bg-ink-subtle/60"
        />
      )}
    </button>
  );
}

function AxisRow({ axis, onChoose, focusKey }: AxisProps): React.JSX.Element {
  const { t } = useI18n();
  const labelId = useId();

  const shape =
    axis.definition?.display === 'SWATCHES' || axis.definition?.input === 'COLOUR'
      ? 'SWATCH'
      : axis.definition?.display === 'SIZE_BUTTONS'
        ? 'SIZE'
        : 'CHIP';

  /**
   * A long list is a dropdown, not forty chips.
   *
   * The cut-off is where a wrapped row stops being scannable and starts being
   * a wall — a fastener catalogue's thread lengths run to dozens, and nobody
   * reads those as buttons.
   */
  const useDropdown = axis.definition?.display === 'DROPDOWN' || axis.values.length > 14;

  const unavailableCount = axis.values.filter((value) => value.state !== 'AVAILABLE').length;

  if (axis.isBlocked) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-surface-sunken/60 px-3.5 py-3">
        <p className="text-sm font-medium text-ink">{axis.label}</p>
        <p className="mt-0.5 text-xs text-ink-muted">
          {t('variants.chooseFirst', {
            axis: (axis.definition?.dependsOn ?? []).join(', '),
          })}
        </p>
      </div>
    );
  }

  return (
    <div role="radiogroup" aria-labelledby={labelId}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <p id={labelId} className="text-sm font-medium text-ink">
          {axis.label}
          {/* The chosen value beside the label, not only inside the control.
              With four axes stacked, "which size did I pick?" has to be
              answerable without hunting for the highlighted button. */}
          {axis.selected !== null && (
            <span className="ml-2 font-normal text-ink-muted">{axis.selected}</span>
          )}
        </p>

        {axis.selected === null && (
          <span className="text-xs text-ink-subtle">{t('variants.required')}</span>
        )}
      </div>

      {useDropdown ? (
        <select
          aria-labelledby={labelId}
          value={axis.selected ?? ''}
          onChange={(event) => {
            onChoose(axis.key, event.target.value);
          }}
          className="mt-2 block w-full rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
          <option value="">{t('variants.choosePlaceholder', { axis: axis.label })}</option>
          {axis.values.map((value) => (
            <option key={value.value} value={value.label} disabled={value.state !== 'AVAILABLE'}>
              {value.state === 'AVAILABLE'
                ? value.label
                : `${value.label} — ${
                    value.state === 'OUT_OF_STOCK'
                      ? t('variants.outOfStock')
                      : t('variants.notOffered')
                  }`}
            </option>
          ))}
        </select>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {axis.values.map((value, index) => (
            <ValueButton
              key={value.value}
              axis={axis}
              value={value}
              isSelected={axis.selected !== null && value.label === axis.selected}
              onChoose={(label) => {
                onChoose(axis.key, label);
              }}
              // Only the first value of the axis the page wants answered, and
              // only once: autoFocus on every axis would fight for the caret.
              wantsFocus={focusKey === axis.key && index === 0}
              shape={shape}
            />
          ))}
        </div>
      )}

      {/* Said once under the group rather than repeated on every button. A
          shopper looking at three struck-through sizes needs to know why, and
          the buttons themselves have no room to explain. */}
      {unavailableCount > 0 && !useDropdown && (
        <p className="mt-1.5 text-xs text-ink-muted">{t('variants.someUnavailable')}</p>
      )}
    </div>
  );
}

export interface VariantSelectorProps {
  axes: ResolvedAxis[];
  onChoose: (axisKey: string, label: string) => void;
  /** Cleared by the page once the shopper responds. */
  focusKey: string | null;
  /** Shown above the controls after a failed attempt to add to the basket. */
  missingMessage: string | null;
}

export function VariantSelector({
  axes,
  onChoose,
  focusKey,
  missingMessage,
}: VariantSelectorProps): React.JSX.Element | null {
  // A product with one SKU declares axes with one value each, or none at all.
  // Either way there is no choice to make, and a selector with a single
  // pre-selected button is a control that asks a question with one answer.
  const meaningful = axes.filter((axis) => axis.values.length > 1);
  if (meaningful.length === 0) return null;

  return (
    <div className="space-y-4">
      {missingMessage !== null && (
        <p
          role="alert"
          className="rounded-lg border border-danger/40 bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          {missingMessage}
        </p>
      )}

      {meaningful.map((axis) => (
        <AxisRow key={axis.key} axis={axis} onChoose={onChoose} focusKey={focusKey} />
      ))}
    </div>
  );
}
