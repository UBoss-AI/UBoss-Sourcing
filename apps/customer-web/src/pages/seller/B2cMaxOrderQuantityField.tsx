/**
 * "B2C Maximum Order Quantity", as a seller types it.
 *
 * The most units of this product an Individual buyer may order at once -
 * every size and colour of it together. Deliberately NOT labelled "MOQ",
 * which means the minimum everywhere else in Seller Hub and in the trade.
 *
 * Used by the new-listing wizard and by the edit page, so the two cannot
 * drift apart. What it does:
 *
 *   - A number box with its own − and + buttons and ordinary keyboard entry.
 *     The keys a number box would otherwise take - e, E, +, -, . - are
 *     refused, so "1e2" cannot even be typed.
 *   - Nothing typed is ever replaced. A bad figure is shown with the reason
 *     beside it, and saving is left to the page, which refuses it too.
 *   - Label, helper text and the error are tied to the input for a screen
 *     reader (`Field` does the ids); the information icon's tooltip is read
 *     on focus as well as hover.
 *   - "Not configured" is said plainly for a listing from before the rule,
 *     with the same box to set it.
 */
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { Tooltip } from '@/components/Tooltip';
import { Badge, Field, Input } from '@/components/ui';
import { B2C_LIMIT_CEILING, type B2cLimitInputProblem } from '@/lib/b2c-limit';
import { formatNumber } from '@/lib/format';

export interface B2cMaxOrderQuantityFieldProps {
  value: string;
  onChange: (next: string) => void;
  /** A problem to show under the box: the form's own check or the server's. */
  problem?: B2cLimitInputProblem | null;
  /** True where the saved listing has no limit yet - shows "Not configured". */
  notConfigured?: boolean;
  disabled?: boolean;
  /** The listing's minimum, for the "below your minimum" sentence. */
  minimumOrderQuantity?: number;
}

const BLOCKED_KEYS = new Set(['e', 'E', '+', '-', '.', ',']);

export function B2cMaxOrderQuantityField({
  value,
  onChange,
  problem = null,
  notConfigured = false,
  disabled = false,
  minimumOrderQuantity = 1,
}: B2cMaxOrderQuantityFieldProps): React.JSX.Element {
  const { t } = useI18n();

  const current = /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
  const step = (delta: number): void => {
    const base = current ?? 0;
    const next = Math.min(B2C_LIMIT_CEILING, Math.max(1, base + delta));
    onChange(String(next));
  };

  const error =
    problem === null
      ? undefined
      : t(`sellerB2c.problem.${problem}` as TranslationKey, {
          maximum: formatNumber(B2C_LIMIT_CEILING),
          minimum: formatNumber(minimumOrderQuantity),
        });

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {notConfigured && <Badge tone="warning">{t('sellerB2c.notConfigured')}</Badge>}
      </div>
      <Field label={t('sellerB2c.label')} hint={t('sellerB2c.helper')} error={error} required>
        {({ inputId, describedBy }) => (
          <div className="flex items-center gap-2">
            <div className="flex items-stretch">
              <button
                type="button"
                className="rounded-l-md border border-border-strong bg-surface px-3 text-lg leading-none text-ink hover:bg-surface-sunken disabled:opacity-50"
                aria-label={t('sellerB2c.decrease')}
                aria-controls={inputId}
                disabled={disabled || current === null || current <= 1}
                onClick={() => {
                  step(-1);
                }}
              >
                −
              </button>
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={problem !== null}
                type="number"
                inputMode="numeric"
                min={1}
                max={B2C_LIMIT_CEILING}
                step={1}
                value={value}
                disabled={disabled}
                className="w-32 rounded-none text-center tabular"
                onKeyDown={(event) => {
                  if (BLOCKED_KEYS.has(event.key)) event.preventDefault();
                }}
                onChange={(event) => {
                  onChange(event.currentTarget.value);
                }}
              />
              <button
                type="button"
                className="rounded-r-md border border-border-strong bg-surface px-3 text-lg leading-none text-ink hover:bg-surface-sunken disabled:opacity-50"
                aria-label={t('sellerB2c.increase')}
                aria-controls={inputId}
                disabled={disabled || (current !== null && current >= B2C_LIMIT_CEILING)}
                onClick={() => {
                  step(1);
                }}
              >
                +
              </button>
            </div>
            <span className="text-sm text-ink-muted">{t('sellerB2c.units')}</span>
            <Tooltip label={t('sellerB2c.tooltip')}>
              <button
                type="button"
                className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-border-strong text-xs font-semibold text-ink-muted hover:text-ink"
                aria-label={t('sellerB2c.tooltipLabel')}
              >
                i
              </button>
            </Tooltip>
          </div>
        )}
      </Field>
    </div>
  );
}
