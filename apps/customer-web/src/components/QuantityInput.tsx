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

interface QuantityInputProps {
  value: number;
  onChange: (next: number) => void;
  rules: PurchaseRules;
  label?: string;
  disabled?: boolean;
}

export function QuantityInput({
  value,
  onChange,
  rules,
  label = 'Quantity',
  disabled = false,
}: QuantityInputProps): React.JSX.Element {
  const inputId = useId();
  const hintId = `${inputId}-hint`;

  const step = Math.max(1, rules.qtyIncrement);
  const min = Math.max(1, rules.minOrderQty);
  const description = describeRules(rules);

  const canDecrease = !disabled && value > min;
  const canIncrease =
    !disabled && (rules.maxOrderQty === null || value + step <= rules.maxOrderQty);

  return (
    <div>
      <label htmlFor={inputId} className="block text-sm font-medium text-ink">
        {label}
      </label>

      <div className="mt-1.5 flex items-stretch gap-1.5">
        <Button
          size="md"
          disabled={!canDecrease}
          aria-label={`Decrease quantity by ${String(step)}`}
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
          className="w-20 rounded-md border border-border-strong bg-surface px-3 py-2.5 text-center text-sm tabular text-ink disabled:bg-surface-sunken"
        />

        <Button
          size="md"
          disabled={!canIncrease}
          aria-label={`Increase quantity by ${String(step)}`}
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
