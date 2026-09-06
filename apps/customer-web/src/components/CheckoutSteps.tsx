/**
 * The purchase-flow progress indicator: Cart → Address → Payment → Confirmed.
 *
 * The rule this component exists to hold: **a step is only ever shown as done
 * when it actually is.** A progress bar that ticks "Payment" the moment the
 * customer reaches the payment page is a lie told in a graphic, and it is the
 * same lie the payment page spends its whole implementation refusing to tell
 * in words. So the state of every step is passed in by the page that knows —
 * see `lib/checkout-steps.ts` — and this file decides nothing about the flow.
 *
 * Four states, because four different things are true at different moments:
 *
 *   complete   Done. A tick.
 *   current    Where the customer is now. A filled dot, and `aria-current`.
 *   waiting    Reached, but not finished — an order placed and not yet paid.
 *              Deliberately not a tick, and visibly not one: a dashed ring
 *              and a caption saying what is outstanding.
 *   upcoming   Not reached. The step's number.
 *
 * Colour is never the only signal: each marker carries a different *glyph*,
 * the current step is the only one in semibold, and every state contributes an
 * `sr-only` word so the list reads correctly aloud.
 */
import { cx } from '@/lib/cx';
import { CheckIcon, ClockIcon, DotIcon } from '@/components/icons';
import type {
  CheckoutStepId,
  CheckoutStepNotes,
  CheckoutStepState,
  CheckoutStepStates,
} from '@/lib/checkout-steps';
import { useI18n } from '@/i18n/i18n-context';

const STEPS: { id: CheckoutStepId; label: string }[] = [
  { id: 'cart', label: 'Cart' },
  { id: 'address', label: 'Address' },
  { id: 'payment', label: 'Payment' },
  { id: 'confirmation', label: 'Confirmation' },
];

/** What each state says to a screen reader, after the step's own name. */
const STATE_WORDING: Record<CheckoutStepState, string> = {
  complete: 'completed',
  current: 'current step',
  waiting: 'waiting',
  upcoming: 'not started',
};

const MARKER_STYLES: Record<CheckoutStepState, string> = {
  complete: 'border-brand bg-brand text-white',
  current: 'border-brand bg-surface text-brand',
  // Dashed, because "reached but unfinished" must not be mistakable for a
  // tick at a glance or in a screenshot.
  waiting: 'border-dashed border-warning bg-warning-soft text-warning',
  upcoming: 'border-border bg-surface text-ink-subtle',
};

const LABEL_STYLES: Record<CheckoutStepState, string> = {
  complete: 'text-ink',
  current: 'font-semibold text-ink',
  waiting: 'text-ink',
  upcoming: 'text-ink-subtle',
};

function Marker({
  state,
  position,
}: {
  state: CheckoutStepState;
  position: number;
}): React.JSX.Element {
  return (
    <span
      className={cx(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold',
        MARKER_STYLES[state],
      )}
    >
      {state === 'complete' && <CheckIcon className="h-4 w-4" />}
      {state === 'current' && <DotIcon className="h-4 w-4" />}
      {state === 'waiting' && <ClockIcon className="h-4 w-4" />}
      {state === 'upcoming' && position}
    </span>
  );
}

export function CheckoutSteps({
  states,
  notes,
  className,
}: {
  states: CheckoutStepStates;
  notes?: CheckoutStepNotes;
  className?: string;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <nav aria-label={t('checkoutSteps.checkoutProgress')} className={cx('mb-6', className)}>
      <ol className="flex items-start gap-1 sm:gap-2">
        {STEPS.map((step, index) => {
          const state = states[step.id];
          const note = notes?.[step.id];
          const isLast = index === STEPS.length - 1;

          return (
            <li
              key={step.id}
              className="flex min-w-0 flex-1 items-start gap-1 sm:gap-2"
              {...(state === 'current' ? { 'aria-current': 'step' as const } : {})}
            >
              <div className="flex min-w-0 flex-col items-center gap-1.5 text-center">
                <Marker state={state} position={index + 1} />

                <span className={cx('text-xxs sm:text-xs', LABEL_STYLES[state])}>
                  {step.label}
                  <span className="sr-only">: {STATE_WORDING[state]}</span>
                </span>

                {note !== undefined && (
                  // The one place this component says anything specific, and
                  // it is the page's own words, not an inference from `state`.
                  <span className="max-w-[10rem] text-xxs leading-tight text-ink-muted">
                    {note}
                  </span>
                )}
              </div>

              {!isLast && (
                /* The connector belongs to the step *before* it, and is only
                   filled when that step is genuinely complete — so the line
                   never runs ahead of the progress it is drawing. */
                <span
                  aria-hidden="true"
                  className={cx(
                    'mt-4 h-0.5 min-w-4 flex-1 rounded-full',
                    state === 'complete' ? 'bg-brand' : 'bg-border',
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
