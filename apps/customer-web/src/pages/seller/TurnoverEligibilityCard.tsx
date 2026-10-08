/**
 * The seller eligibility card: the marketplace's turnover policy, stated
 * before anybody starts an application, and the three answers it needs.
 *
 * Used twice, from one implementation: on the public "Sell" page in front of
 * the short application form, and at the top of the Business identity step for
 * an application already under way. Two copies of "is this turnover enough"
 * is how the page that lets somebody in and the page that keeps them out end
 * up disagreeing.
 *
 * What it promises, and what it does not:
 *
 *   - It says what the SERVER will say, sooner. The figure is converted to
 *     whole minor units exactly (lib/turnover.ts) and compared as a `bigint`,
 *     so "Turnover requirement met" appears for exactly the figures the server
 *     accepts - and never for the minimum itself.
 *   - Ticking the declaration never makes a business eligible. The figure
 *     does; the tick only confirms it is true.
 *   - It is this marketplace's own policy. Nothing on it suggests a
 *     government or legal requirement.
 */
import { useId } from 'react';
import { ButtonLink, Field, Input, Select } from '@/components/ui';
import { AlertIcon, CheckIcon, InfoIcon, ShieldIcon } from '@/components/icons';
import { Tooltip } from '@/components/Tooltip';
import { useStorefront } from '@/app/storefront-context';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import {
  financialYearOptions,
  formatPeriod,
  formatTurnover,
  minorToEntry,
  parseTurnoverEntry,
  shortYearLabel,
  type TurnoverPolicy,
  type TurnoverUnit,
} from '@/lib/turnover';
import {
  evaluateTurnover,
  useThresholdText,
  type TurnoverDraft,
} from './turnover-draft';

/**
 * The policy itself: what is asked, the threshold, and that it is this
 * marketplace's own rule. The card's header, and on its own the notice the
 * public "Sell" page shows somebody who has not signed in yet.
 */
function PolicyHeader({
  policy,
  titleId,
  standalone = false,
}: {
  policy: TurnoverPolicy;
  titleId: string;
  /** No rule under it when nothing follows. */
  standalone?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const { threshold, equivalent } = useThresholdText(policy);

  return (
    <div className={cx('relative bg-gradient-to-br', !standalone && 'border-b border-border', ' from-brand-soft via-surface to-surface px-5 py-5 sm:px-6')}>
      <div className="flex flex-col gap-5 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 gap-4">
          <span
            aria-hidden="true"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-brand-fill text-white shadow-card"
          >
            <ShieldIcon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={titleId} className="text-title text-ink">
                {t('seller.turnover.title')}
              </h2>
              <span className="rounded-full bg-surface px-2 py-0.5 text-xxs font-semibold uppercase tracking-wide text-ink-muted ring-1 ring-inset ring-border">
                {t('seller.turnover.policyBadge')}
              </span>
            </div>
            <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink">
              {t('seller.turnover.lede', { threshold })}
            </p>
            <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-ink-muted">
              {equivalent === null
                ? t('seller.turnover.supportingNoEquivalent')
                : t('seller.turnover.supporting', { equivalent })}
            </p>
          </div>
        </div>

        {/* The number, large, with the word that matters beside it. */}
        <div className="shrink-0 rounded-lg border border-brand/20 bg-surface px-4 py-3 text-left shadow-card md:min-w-44 md:text-right">
          <p className="text-xxs font-semibold uppercase tracking-[0.14em] text-brand">
            {t('seller.turnover.moreThan')}
          </p>
          <p className="mt-0.5 text-title-xl tabular-nums text-ink">{threshold}</p>
          <p className="text-xs text-ink-muted">{t('seller.turnover.annualTurnover')}</p>
        </div>
      </div>
    </div>
  );
}

/** The policy alone, for a visitor who cannot apply yet. Nothing when the policy is off. */
export function TurnoverPolicyNotice(): React.JSX.Element | null {
  const { sellerEligibility } = useStorefront();
  const titleId = useId();
  if (sellerEligibility?.required !== true) return null;

  return (
    <section
      aria-labelledby={titleId}
      className="mt-6 overflow-hidden rounded-xl border border-border bg-surface text-left shadow-card"
    >
      <PolicyHeader policy={sellerEligibility} titleId={titleId} standalone />
    </section>
  );
}

const ERROR_KEY = {
  REQUIRED: 'seller.turnover.error.required',
  NEGATIVE: 'seller.turnover.error.negative',
  MALFORMED: 'seller.turnover.error.malformed',
  TOO_PRECISE: 'seller.turnover.error.tooPrecise',
  TOO_LARGE: 'seller.turnover.error.tooLarge',
} as const;

export function TurnoverEligibilityCard({
  policy,
  draft,
  onChange,
  disabled = false,
  showAllErrors = false,
  showShoppingLink = false,
  children,
}: {
  policy: TurnoverPolicy;
  draft: TurnoverDraft;
  onChange: (next: TurnoverDraft) => void;
  disabled?: boolean;
  /** After a refused submit: say what is missing even in fields never touched. */
  showAllErrors?: boolean;
  /** Offer the way back to buying when the business does not qualify. */
  showShoppingLink?: boolean;
  /** Actions, rendered under the declaration. */
  children?: React.ReactNode;
}): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const titleId = useId();
  const declarationId = useId();
  const statusId = useId();
  const { threshold } = useThresholdText(policy);

  const evaluation = evaluateTurnover(draft, policy);
  const years = financialYearOptions(policy.financialYearStartMonth, new Date());
  const offersCrore = policy.currency === 'INR';
  const showErrors = draft.touched || showAllErrors;

  const amountError =
    evaluation.state === 'INVALID' && evaluation.problem !== null && (showErrors || evaluation.problem !== 'REQUIRED')
      ? t(ERROR_KEY[evaluation.problem], {
          places: String(draft.unit === 'CRORE' ? 7 + policy.currencyExponent : policy.currencyExponent),
        })
      : undefined;

  const set = (patch: Partial<TurnoverDraft>): void => {
    onChange({ ...draft, ...patch });
  };

  /** Switch the unit and convert what is typed, exactly, so nothing is retyped. */
  const switchUnit = (unit: TurnoverUnit): void => {
    if (unit === draft.unit) return;
    const parsed = parseTurnoverEntry(draft.amountText, draft.unit, policy.currencyExponent);
    set({
      unit,
      amountText: parsed.ok ? minorToEntry(parsed.minor, unit, policy.currencyExponent) : draft.amountText,
    });
  };

  const exactAmount =
    evaluation.state === 'INVALID' ? null : formatTurnover(evaluation.amountMinor, policy, intlLocale);

  return (
    <section
      aria-labelledby={titleId}
      className="overflow-hidden rounded-xl border border-border bg-surface shadow-card"
    >
      <PolicyHeader policy={policy} titleId={titleId} />

      <div className="space-y-5 px-5 py-5 sm:px-6">
        <div className="grid gap-5 md:grid-cols-2">
          {/* Reporting period */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <label htmlFor={`${titleId}-year`} className="text-sm font-medium text-ink">
                {t('seller.turnover.year.label')}
                <span className="ml-1 text-danger" aria-hidden="true">*</span>
              </label>
              <Tooltip label={t('seller.turnover.year.tooltip')}>
                <button
                  type="button"
                  aria-label={t('seller.turnover.year.info')}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                >
                  <InfoIcon className="h-4 w-4" />
                </button>
              </Tooltip>
            </div>
            <Select
              id={`${titleId}-year`}
              value={draft.yearKey}
              disabled={disabled}
              invalid={showErrors && draft.yearKey.length === 0}
              aria-describedby={`${titleId}-year-hint`}
              onChange={(event) => {
                set({ yearKey: event.currentTarget.value });
              }}
            >
              <option value="">{t('seller.turnover.year.choose')}</option>
              {years.map((year) => (
                <option key={year.key} value={year.key}>
                  {t('seller.turnover.year.option', {
                    label: shortYearLabel(year.start, year.end),
                    period: formatPeriod(year.start, year.end, intlLocale),
                  })}
                </option>
              ))}
            </Select>
            <p id={`${titleId}-year-hint`} className="text-xs leading-relaxed text-ink-muted">
              {t('seller.turnover.year.hint')}
            </p>
            {showErrors && draft.yearKey.length === 0 && (
              <p role="alert" className="text-xs font-medium text-danger">
                {t('seller.turnover.error.year')}
              </p>
            )}
          </div>

          {/* Amount, in the currency named on the label */}
          <Field
            label={t('seller.turnover.amount.label', { currency: policy.currency })}
            hint={
              exactAmount === null
                ? t('seller.turnover.amount.hint')
                : t('seller.turnover.amount.exactly', { amount: exactAmount })
            }
            error={amountError}
            required
          >
            {({ inputId, describedBy }) => (
              <div className="flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    inputMode="decimal"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={disabled}
                    invalid={amountError !== undefined}
                    value={draft.amountText}
                    placeholder={draft.unit === 'CRORE' ? '35.5' : '355000000'}
                    className="pr-16 tabular-nums"
                    onChange={(event) => {
                      set({ amountText: event.currentTarget.value });
                    }}
                    onBlur={() => {
                      if (!draft.touched) set({ touched: true });
                    }}
                  />
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-semibold text-ink-muted"
                  >
                    {draft.unit === 'CRORE' ? t('seller.turnover.unit.crore') : policy.currency}
                  </span>
                </div>
                {offersCrore && (
                  <div
                    role="radiogroup"
                    aria-label={t('seller.turnover.unit.label')}
                    className="inline-flex h-10 shrink-0 rounded-md border border-border-strong bg-surface-sunken p-0.5"
                  >
                    {(['CRORE', 'MAJOR'] as const).map((unit) => (
                      <button
                        key={unit}
                        type="button"
                        role="radio"
                        aria-checked={draft.unit === unit}
                        // One tab stop for the group; the arrow keys move
                        // within it, as a radio group does.
                        tabIndex={draft.unit === unit ? 0 : -1}
                        disabled={disabled}
                        onClick={() => {
                          switchUnit(unit);
                        }}
                        onKeyDown={(event) => {
                          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
                          event.preventDefault();
                          const next = unit === 'CRORE' ? 'MAJOR' : 'CRORE';
                          switchUnit(next);
                          const group = event.currentTarget.parentElement;
                          requestAnimationFrame(() => {
                            group?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
                          });
                        }}
                        className={cx(
                          'rounded px-3 text-xs font-semibold transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand',
                          draft.unit === unit
                            ? 'bg-surface text-ink shadow-card'
                            : 'text-ink-muted hover:text-ink',
                        )}
                      >
                        {unit === 'CRORE' ? t('seller.turnover.unit.crore') : policy.currency}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Field>
        </div>

        {/* The answer, announced politely as it changes. */}
        <div id={statusId} aria-live="polite" className="min-h-0">
          {evaluation.state === 'ELIGIBLE' && (
            <div className="flex gap-3 rounded-lg border border-success/30 bg-success-soft px-4 py-3 motion-safe:animate-tile-in">
              <CheckIcon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-success" />
              <div>
                <p className="text-sm font-semibold text-success">{t('seller.turnover.met.title')}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-ink">{t('seller.turnover.met.body')}</p>
              </div>
            </div>
          )}
          {evaluation.state === 'BELOW' && (
            <div className="flex gap-3 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 motion-safe:animate-tile-in">
              <AlertIcon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
              <div className="min-w-0">
                <p className="text-sm leading-relaxed text-ink">{t('seller.turnover.notMet.body', { threshold })}</p>
                {showShoppingLink && (
                  <div className="mt-3">
                    <ButtonLink to="/" size="sm">
                      {t('seller.turnover.notMet.shop')}
                    </ButtonLink>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* The declaration. Never ticked for them, and never enough on its own. */}
        <div className="space-y-1.5">
          <label
            htmlFor={declarationId}
            className={cx(
              'flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition-colors duration-150',
              draft.declared ? 'border-brand/40 bg-brand-soft/50' : 'border-border hover:bg-surface-hover',
              disabled && 'cursor-not-allowed opacity-70',
            )}
          >
            <input
              id={declarationId}
              type="checkbox"
              disabled={disabled}
              checked={draft.declared}
              aria-describedby={showAllErrors && !draft.declared ? `${declarationId}-error` : undefined}
              onChange={(event) => {
                set({ declared: event.currentTarget.checked });
              }}
              className="mt-0.5 h-4 w-4 shrink-0 rounded border-border-strong text-brand-fill focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            />
            <span className="text-sm leading-relaxed text-ink">{t('seller.turnover.declaration')}</span>
          </label>
          {showAllErrors && !draft.declared && (
            <p id={`${declarationId}-error`} role="alert" className="text-xs font-medium text-danger">
              {t('seller.turnover.error.declaration')}
            </p>
          )}
        </div>

        <p className="text-xxs leading-relaxed text-ink-subtle">{t('seller.turnover.policyNote')}</p>

        {children}
      </div>
    </section>
  );
}
