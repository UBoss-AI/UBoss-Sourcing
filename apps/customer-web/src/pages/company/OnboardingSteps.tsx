/**
 * Where a company buyer is in their onboarding, drawn the same way on the two
 * screens it spans.
 *
 * The journey is six steps, and the first one happens on a different page
 * from the rest: the sign-in account is created on the sign-up form, and
 * everything about the business is asked afterwards, inside the account,
 * where it is saved on the server as it is completed. Without one indicator
 * shared by both, somebody finishing the sign-up form has no way to know that
 * five more steps follow - and somebody opening the application afterwards has
 * no way to know the first step is already behind them.
 *
 * Two layouts:
 *
 *   - **The row** - below `lg`, and on the sign-up form at every width
 *     (`compact`). Numbered dots that wrap rather than scroll sideways, so it
 *     can never widen the page, under a "Step 2 of 6" line and a bar. The
 *     step's own name is the heading underneath.
 *   - **The stepper card** - from `lg` up, beside the form. A vertical line of
 *     nodes joined by a connector that fills in as steps are completed, each
 *     with its name and a written state. The state is WORDS, not only a colour:
 *     a yellow dot means nothing to somebody who cannot tell yellow from grey,
 *     and nothing at all to a screen reader.
 *
 * A step's state comes from the server's list of what is missing
 * (`needsAttention`) and from which steps the person has saved past
 * (`completed`) - never from the position alone, which would call an
 * untouched step "Complete" just because it comes before the current one.
 *
 * Each step is a button only where moving to it is allowed (the wizard). On
 * the sign-up form it is plain text: there is nothing to go to yet.
 */
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';

export const ONBOARDING_STEPS = [
  'applicant',
  'business',
  'identifiers',
  'addresses',
  'documents',
  'review',
] as const;

export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

type StepState = 'complete' | 'current' | 'attention' | 'upcoming';

function stateOf(
  key: OnboardingStep,
  current: OnboardingStep,
  needsAttention: ReadonlySet<OnboardingStep>,
  completed: ReadonlySet<OnboardingStep>,
): StepState {
  if (key === current) return 'current';
  // Review is never "missing" anything of its own; its state is its position.
  if (needsAttention.has(key) && key !== 'review') return 'attention';
  if (completed.has(key)) return 'complete';
  return 'upcoming';
}

export function OnboardingSteps({
  current,
  needsAttention = new Set(),
  completed = new Set(),
  onSelect,
  compact = false,
  className,
}: {
  current: OnboardingStep;
  /** Steps the server says still have something missing. */
  needsAttention?: ReadonlySet<OnboardingStep>;
  /** Steps saved and with nothing missing. */
  completed?: ReadonlySet<OnboardingStep>;
  /** Omitted where the steps cannot be moved between. */
  onSelect?: (step: OnboardingStep) => void;
  /** The numbered row at every width - for a narrow column like the sign-up form. */
  compact?: boolean;
  className?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const index = ONBOARDING_STEPS.indexOf(current);
  const total = ONBOARDING_STEPS.length;
  const states = ONBOARDING_STEPS.map((key) => stateOf(key, current, needsAttention, completed));
  const doneCount = states.filter((state) => state === 'complete').length;
  const label = (key: OnboardingStep): string => t(`companyWizard.step.${key}` as TranslationKey);
  const stateText = (state: StepState): string => t(`companyWizard.stepState.${state}` as TranslationKey);

  return (
    <nav aria-label={t('companyWizard.stepsLabel')} className={className}>
      {/* --- The row: phones, and the sign-up form ------------------------ */}
      <div className={compact ? undefined : 'lg:hidden'}>
        <p className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
          {t('companyWizard.stepOf', { current: String(index + 1), total: String(total) })}
        </p>
        {/* Decoration: the list below says the same thing to assistive technology. */}
        <div aria-hidden="true" className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
          <div className="h-full rounded-full bg-brand transition-[width] duration-300" style={{ width: `${String(((index + 1) / total) * 100)}%` }} />
        </div>
        <ol className="mt-3 flex flex-wrap gap-2">
          {ONBOARDING_STEPS.map((key, position) => {
            const state = states[position] ?? 'upcoming';
            const node = (
              <>
                <StepNode state={state} number={position + 1} size="sm" />
                <span className="sr-only">{`${label(key)}, ${stateText(state)}`}</span>
              </>
            );
            return (
              <li key={key}>
                {onSelect === undefined ? (
                  <span className="relative flex" {...(state === 'current' ? { 'aria-current': 'step' as const } : {})}>
                    {node}
                  </span>
                ) : (
                  <button
                    type="button"
                    title={label(key)}
                    aria-current={state === 'current' ? 'step' : undefined}
                    onClick={() => {
                      onSelect(key);
                    }}
                    className="relative flex rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                  >
                    {node}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </div>

      {/* --- The stepper card: beside the form, from lg up ---------------- */}
      {!compact && (
        <div className="hidden rounded-xl border border-border bg-surface p-4 shadow-card lg:block">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">{t('companyWizard.progressHeading')}</p>
          <p className="mt-1 text-sm font-medium text-ink">
            {t('companyWizard.progressCount', { done: String(doneCount), total: String(total) })}
          </p>
          <div aria-hidden="true" className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
            <div className="h-full rounded-full bg-success transition-[width] duration-300" style={{ width: `${String((doneCount / total) * 100)}%` }} />
          </div>

          <ol className="mt-4">
            {ONBOARDING_STEPS.map((key, position) => {
              const state = states[position] ?? 'upcoming';
              const isLast = position === total - 1;
              const content = (
                <>
                  <StepNode state={state} number={position + 1} size="md" />
                  <span className="min-w-0 flex-1 pt-0.5">
                    <span
                      className={cx(
                        'block text-sm leading-snug',
                        state === 'current' ? 'font-semibold text-brand' : state === 'upcoming' ? 'text-ink-muted' : 'font-medium text-ink',
                      )}
                    >
                      {label(key)}
                    </span>
                    <span
                      className={cx(
                        'mt-0.5 block text-xs',
                        state === 'attention' ? 'font-medium text-warning' : state === 'complete' ? 'text-success' : 'text-ink-subtle',
                      )}
                    >
                      {stateText(state)}
                    </span>
                  </span>
                </>
              );
              const rowClasses = cx(
                'relative flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left',
                state === 'current' && 'bg-brand-soft',
              );
              return (
                <li key={key} className="relative">
                  {/* The connector to the next node: filled once this step
                      is behind the person, faint while it is ahead. */}
                  {!isLast && (
                    <span
                      aria-hidden="true"
                      className={cx(
                        'absolute left-[1.5625rem] top-11 h-[calc(100%-2.25rem)] w-0.5 rounded-full',
                        state === 'complete' ? 'bg-success' : 'bg-border',
                      )}
                    />
                  )}
                  {onSelect === undefined ? (
                    <span className={rowClasses} {...(state === 'current' ? { 'aria-current': 'step' as const } : {})}>
                      {content}
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-current={state === 'current' ? 'step' : undefined}
                      onClick={() => {
                        onSelect(key);
                      }}
                      className={cx(
                        rowClasses,
                        'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                        state !== 'current' && 'hover:bg-surface-hover',
                      )}
                    >
                      {content}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </nav>
  );
}

/**
 * One step's marker. The number stays readable in every state - a tick
 * replaces it only once the step is done, and "!" only where something is
 * missing - so "step 4" can always be found by its number.
 */
function StepNode({ state, number, size }: { state: StepState; number: number; size: 'sm' | 'md' }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cx(
        'relative z-10 flex shrink-0 items-center justify-center rounded-full font-semibold transition-colors',
        size === 'md' ? 'h-9 w-9 text-sm' : 'h-7 w-7 text-xs',
        state === 'current' && 'bg-brand text-white shadow-[0_0_0_4px_rgb(var(--brand)/0.18)]',
        state === 'complete' && 'bg-success text-white',
        state === 'attention' && 'border-2 border-warning bg-warning-soft text-warning',
        state === 'upcoming' && 'border border-border-strong bg-surface text-ink-muted',
      )}
    >
      {state === 'complete' ? (
        <svg viewBox="0 0 16 16" className={size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5'} fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3.5 8.5l3 3 6-7" />
        </svg>
      ) : state === 'attention' ? (
        '!'
      ) : (
        number
      )}
    </span>
  );
}
