/**
 * A quantity control that respects a product's purchasing rules.
 *
 * B2B products carry a minimum, an optional maximum and an increment — "at
 * least 10, in multiples of 5". Those rules are shown and applied here so the
 * customer meets them while choosing, rather than being rejected at the cart.
 *
 * This is a convenience, never a control. The backend re-checks every rule on
 * add-to-cart and again at checkout; nothing here is trusted.
 *
 * The steppers move by the increment, not by one, because stepping by one
 * through a multiple-of-5 rule produces three invalid values out of every four.
 */
import { useId } from 'react';
import { Button } from './ui';
import { clampToRules, describeRules } from '@/lib/quantity-rules';
import type { PurchaseRules } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

interface QuantityInputProps {
  value: number;
  onChange: (next: number) => void;
  rules: PurchaseRules;
  label?: string;
  disabled?: boolean;
  /**
   * What is being counted, for the stepper labels.
   *
   * A product page where a customer has chosen three options has three of
   * these on it, and "Increase quantity by 5" three times is not three labels
   * — it is the same label three times, which leaves a screen reader with no
   * way to tell the 3 ml stepper from the 5 ml one. Where this is given, the
   * name goes into the button labels.
   */
  itemName?: string;
  /**
   * Whether to restate the purchasing rules under the field. On by default.
   *
   * The variant picker turns it off: it prints the rules once above a list of
   * steppers that all share them, and the same grey sentence repeated under
   * every row is noise where one copy of it was guidance.
   */
  ruleHint?: boolean;
}

export function QuantityInput({
  value,
  onChange,
  rules,
  // Resolved in the body, not as a default parameter: a default cannot call
  // `t`, and an English default here would label every quantity box that did
  // not pass one.
  label,
  disabled = false,
  itemName,
  ruleHint = true,
}: QuantityInputProps): React.JSX.Element {
  const { t } = useI18n();
  const inputId = useId();
  const hintId = `${inputId}-hint`;

  const step = Math.max(1, rules.qtyIncrement);
  const min = Math.max(1, rules.minOrderQty);
  const description = ruleHint ? describeRules(t, rules) : null;

  const canDecrease = !disabled && value > min;
  const canIncrease =
    !disabled && (rules.maxOrderQty === null || value + step <= rules.maxOrderQty);

  return (
    <div>
      <label htmlFor={inputId} className="block text-sm font-medium text-ink">
        {label ?? t('product.quantity')}
      </label>

      {/*
       * The steppers keep their size and the field gives way.
       *
       * At 320px a cart line has about 135px left for this after the
       * thumbnail, and the control used to be a rigid 177px — it pushed out of
       * its own column. What shrinks is the number field (`min-w-0 shrink`,
       * since an `<input>` carries an intrinsic minimum that ignores a flex
       * container otherwise); the two buttons are `shrink-0` because they are
       * the touch targets, and a 44px stepper squeezed to 20px on a phone is
       * the one part of this control that must not give.
       */}
      <div className="mt-1.5 flex items-stretch gap-1.5">
        <Button
          size="md"
          className="shrink-0"
          disabled={!canDecrease}
          aria-label={
            itemName === undefined
              ? t('product.decreaseQuantityBy', { step: String(step) })
              : t('product.decreaseNamedQuantityBy', { name: itemName, step: String(step) })
          }
          onClick={() => {
            onChange(clampToRules(value - step, rules));
          }}
        >
          −
        </Button>

        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          value={value}
          min={min}
          step={step}
          disabled={disabled}
          aria-describedby={description === null ? undefined : hintId}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            // Typed input is not clamped on every keystroke — that fights the
            // person typing "15" by rewriting it to "10" after the "1".
            if (Number.isFinite(parsed)) onChange(parsed);
          }}
          onBlur={(event) => {
            // Clamping happens when they stop, so the field always settles on
            // something the server will accept.
            const parsed = Number(event.target.value);
            onChange(clampToRules(Number.isFinite(parsed) ? parsed : min, rules));
          }}
          className="w-16 min-w-0 shrink rounded-md border border-border-strong bg-surface px-3 py-2.5 text-center text-sm tabular text-ink disabled:bg-surface-sunken sm:w-20"
        />

        <Button
          size="md"
          className="shrink-0"
          disabled={!canIncrease}
          aria-label={
            itemName === undefined
              ? t('product.increaseQuantityBy', { step: String(step) })
              : t('product.increaseNamedQuantityBy', { name: itemName, step: String(step) })
          }
          onClick={() => {
            onChange(clampToRules(value + step, rules));
          }}
        >
          +
        </Button>
      </div>

      {description !== null && (
        <p id={hintId} className="mt-1.5 text-xs text-ink-muted">
          {description}
        </p>
      )}
    </div>
  );
}
