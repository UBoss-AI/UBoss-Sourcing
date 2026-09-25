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
import { useEffect, useId, useRef, useState, type Ref } from 'react';
import { Button } from './ui';
import { clampToRules, describeRules } from '@/lib/quantity-rules';
import { MAX_QUANTITY, parseQuantity, type QuantityProblem } from '@/lib/parse-quantity';
import type { PurchaseRules } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

/** How a committed quantity was arrived at. */
export type QuantityCommitSource = 'step' | 'typed';

/**
 * How long typing has to pause before the number counts as the buyer's
 * answer. Long enough that "1", "10", "100" on the way to "1000" are never
 * treated as quantities somebody asked for.
 */
export const TYPING_SETTLE_MS = 800;

interface QuantityInputProps {
  value: number;
  onChange: (next: number) => void;
  /**
   * The quantity the buyer has settled on, as opposed to every keystroke.
   *
   * `onChange` fires as they type so the page can show a live figure. This
   * fires once they are done: a stepper press, an arrow key, Enter, leaving
   * the field, or a pause in typing. It is what decides anything that opens a
   * dialog, so typing "1000" is one decision, not four. `previous` is the
   * last committed quantity, so the caller can tell an increase from a
   * decrease without keeping its own copy.
   */
  onCommit?: (next: number, source: QuantityCommitSource, previous: number) => void;
  /** The number field itself, for a caller that sends focus back to it. */
  inputRef?: Ref<HTMLInputElement>;
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
  onCommit,
  inputRef,
}: QuantityInputProps): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const problemId = `${inputId}-problem`;

  const step = Math.max(1, rules.qtyIncrement);
  const min = Math.max(1, rules.minOrderQty);
  const description = ruleHint ? describeRules(t, rules) : null;

  /*
   * What the box SHOWS while somebody types, kept apart from the number.
   *
   * The box used to show `value` directly. Backspacing it empty handed the
   * page `Number('') === 0`, so the box refilled with 0; typing 1000 after it
   * then read "01000", and stayed that way, because React leaves a number
   * input alone when its text already equals the value as a number. Now an
   * empty box stays empty while it has focus (the page keeps its last good
   * quantity), leading zeros are dropped as they are typed, and the rules
   * settle the number when the field is left. `null` means "not being typed
   * in" - the box shows the value, so the steppers and the page stay in charge.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(value);

  /*
   * What is wrong with what is in the box, if anything. A box showing "1.5"
   * or "-3" is never a quantity: it commits nothing, so nothing downstream -
   * no price, no dialog - acts on it, and leaving the field puts back the
   * last good number rather than guessing what was meant.
   */
  const [problem, setProblem] = useState<QuantityProblem | null>(null);

  /*
   * Commits. `committed` is the last quantity reported through onCommit, so
   * a blur straight after Enter, or a pause after a stepper press, does not
   * report the same number twice. `arrowKey` marks the one change that came
   * from ArrowUp/ArrowDown - a deliberate step, committed at once.
   */
  const committed = useRef(value);
  const arrowKey = useRef(false);
  const settleTimer = useRef<number | null>(null);
  const commit = (next: number, source: QuantityCommitSource): void => {
    if (settleTimer.current !== null) {
      window.clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
    const previous = committed.current;
    if (next === previous) return;
    committed.current = next;
    onCommit?.(next, source, previous);
  };
  const clearSettle = (): void => {
    if (settleTimer.current !== null) {
      window.clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
  };

  /**
   * Read what is now in the box and act on it.
   *
   * 'settle' is ordinary typing: show it, and commit only once typing pauses,
   * so "1", "10", "100" on the way to "1000" never count. 'step' (an arrow
   * key) and 'now' (a paste) are complete answers and commit at once.
   */
  const accept = (raw: string, locale: string, when: 'settle' | 'step' | 'now'): void => {
    const parsed = parseQuantity(raw, locale);
    if (parsed.kind === 'empty') {
      // A box being retyped, not a quantity of zero. The page keeps its last
      // good number until something is typed.
      clearSettle();
      setProblem(null);
      setDraft('');
      return;
    }
    if (parsed.kind === 'invalid') {
      clearSettle();
      setProblem(parsed.problem);
      setDraft(raw.replace(/[^\d.,-]/g, '').slice(0, 12));
      return;
    }
    setProblem(null);
    // Leading zeros dropped as they are typed, so "01000" never shows.
    setDraft(String(parsed.value));
    // Typed input is not clamped on every keystroke — that fights the person
    // typing "15" by rewriting it to "10" after the "1".
    onChange(parsed.value);
    if (when === 'settle') {
      clearSettle();
      settleTimer.current = window.setTimeout(() => {
        settleTimer.current = null;
        commit(clampToRules(parsed.value, rules), 'typed');
      }, TYPING_SETTLE_MS);
      return;
    }
    commit(clampToRules(parsed.value, rules), when === 'step' ? 'step' : 'typed');
  };

  useEffect(() => {
    // A quantity set from outside (a version chosen, an offer taken) is where
    // the next comparison starts from.
    if (draft === null) committed.current = value;
  }, [value, draft]);
  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    },
    [],
  );

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
            const next = clampToRules(value - step, rules);
            onChange(next);
            commit(next, 'step');
          }}
        >
          −
        </Button>

        <input
          ref={inputRef}
          id={inputId}
          type="number"
          inputMode="numeric"
          value={shown}
          min={min}
          step={step}
          disabled={disabled}
          aria-describedby={
            [description === null ? null : hintId, problem === null ? null : problemId]
              .filter((id) => id !== null)
              .join(' ') || undefined
          }
          onChange={(event) => {
            // A number input hands back "" for text it cannot read ("1..2")
            // and says so in badInput; that is a problem, not an empty box.
            if (event.target.validity.badInput) {
              clearSettle();
              setProblem('notANumber');
              return;
            }
            // The value of a number input is always written the machine's way
            // ("1.5"), whatever the page language, so it is read that way.
            accept(event.target.value, 'en', arrowKey.current ? 'step' : 'settle');
            arrowKey.current = false;
          }}
          onPaste={(event) => {
            // Pasted text is read in the page's own language, where "1.000"
            // may be a thousand; a number input would otherwise refuse it.
            const text = event.clipboardData.getData('text');
            event.preventDefault();
            accept(text, intlLocale, 'now');
          }}
          onKeyDown={(event) => {
            // No exponents, signs or negatives: nobody means 1e3 syringes.
            if (event.key === 'e' || event.key === 'E' || event.key === '+' || event.key === '-') {
              event.preventDefault();
              return;
            }
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              arrowKey.current = true;
              return;
            }
            if (event.key !== 'Enter') return;
            if (problem !== null) return;
            // Enter settles the number where it is, without leaving the field.
            const typed = draft === null ? value : draft === '' ? min : Number(draft);
            const next = clampToRules(typed, rules);
            setDraft(null);
            onChange(next);
            commit(next, 'typed');
          }}
          onBlur={() => {
            if (problem !== null) {
              // Not a quantity: put the last good one back.
              clearSettle();
              setProblem(null);
              setDraft(null);
              return;
            }
            // Clamping happens when they stop, so the field always settles on
            // something the server will accept. Left empty, it is the minimum.
            const typed = draft === null ? value : draft === '' ? min : Number(draft);
            const next = clampToRules(typed, rules);
            setDraft(null);
            onChange(next);
            commit(next, 'typed');
          }}
          aria-invalid={problem === null ? undefined : true}
          aria-errormessage={problem === null ? undefined : problemId}
          className={
            'w-16 min-w-0 shrink rounded-md border bg-surface px-3 py-2.5 text-center text-sm tabular text-ink disabled:bg-surface-sunken sm:w-20 ' +
            (problem === null ? 'border-border-strong' : 'border-danger')
          }
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
            const next = clampToRules(value + step, rules);
            onChange(next);
            commit(next, 'step');
          }}
        >
          +
        </Button>
      </div>

      {problem !== null && (
        <p id={problemId} role="alert" className="mt-1.5 text-xs font-medium text-danger">
          {t(`quantityInput.problem.${problem}`, { max: MAX_QUANTITY.toLocaleString(intlLocale) })}
        </p>
      )}

      {description !== null && (
        <p id={hintId} className="mt-1.5 text-xs text-ink-muted">
          {description}
        </p>
      )}
    </div>
  );
}
