/**
 * UBOSS AI Insights.
 *
 * Explains the figures on the dashboard beside it, answers a typed question
 * about them, and suggests what to look at first. It is a reading aid, not an
 * operator: nothing in this card changes anything.
 *
 * KEPT BYTE-IDENTICAL across apps/customer-web, apps/admin-web and
 * apps/logistics-web — see the note at the top of console.tsx. It takes no
 * translation key and no router type; strings arrive translated and links are
 * rendered by a callback, so the three copies cannot drift.
 *
 * ---
 *
 * WHAT THIS CARD PROMISES THE READER, AND HOW IT KEEPS IT
 *
 *   - **Every claim can be checked on this screen.** The server only lets the
 *     model cite metric keys it was handed, and the card lists that evidence
 *     under the answer with the figures beside it. A finding with nothing
 *     behind it never arrives, because the server drops it.
 *   - **It says where the answer came from.** A deployment with no AI provider
 *     configured gets a deterministic summary, and this card says so in as
 *     many words rather than passing it off as a model reply. The provider and
 *     the model are named when there is one, which is also what AI Act Art. 50
 *     asks for.
 *   - **It never claims to have done anything.** Suggested actions are links
 *     to the screen where the work is done. Approving, paying, assigning and
 *     resolving all remain a deliberate press behind their own authorization
 *     check and their own audit entry.
 *
 * The answer is announced once, politely, when it lands. Not word by word:
 * this is a paragraph appearing in the corner of a dashboard somebody is
 * reading, and a live region that chatters through a stream makes the rest of
 * the screen unusable to a screen-reader user.
 */
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cx } from '@/lib/cx';
import { InsightCta } from './InsightCta';

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export type InsightSeverity = 'info' | 'attention' | 'urgent';

export interface InsightFinding {
  title: string;
  detail: string;
  severity: InsightSeverity;
  evidence: string[];
}

export interface InsightAction {
  label: string;
  detail: string;
  metricKey: string | null;
  href: string | null;
}

export interface InsightEvidence {
  metricKey: string;
  label: string;
  value: number;
  unit: string;
  href: string | null;
}

/** Mirrors `Insight` in backend/src/modules/assistant/insights.service.ts. */
export interface Insight {
  summary: string;
  findings: InsightFinding[];
  suggestedActions: InsightAction[];
  evidence: InsightEvidence[];
  generatedAt: string;
  window: { from: string; to: string };
  metricKeys: string[];
  source: 'model' | 'deterministic';
  model: string | null;
  fallbackReason: 'not-configured' | 'unavailable' | 'unusable' | null;
}

export interface AiInsightsLabels {
  title: string;
  /** "Ask about this dashboard". The field's accessible name. */
  askLabel: string;
  ask: string;
  asking: string;
  asked: string;
  askFailed: string;
  explainChart: string;
  explaining: string;
  explained: string;
  explainFailed: string;
  /** "Suggestions" — the heading over the prompt chips. */
  suggestions: string;
  findings: string;
  nextSteps: string;
  evidence: string;
  /** "Generated {{when}}" — the caller substitutes a formatted time. */
  generated: string;
  /** "Answers are generated. Figures come from your data, not from the model." */
  disclosure: string;
  /** "No AI provider is configured. This summary was built from your figures." */
  deterministic: string;
  /** "The AI provider could not be reached. This summary is from your figures." */
  unavailable: string;
  /** "Ask a question about the figures on this page" — the empty state. */
  idle: string;
  severity: Record<InsightSeverity, string>;
}

export interface AiInsightsCardProps {
  labels: AiInsightsLabels;
  /** The finished, validated answer. Null until the stream ends. */
  insight: Insight | null;
  /**
   * The summary as it arrives, before `insight` exists.
   *
   * Shown in place of `insight.summary` while a stream is open, and then
   * replaced by it. The two are the same words — the streamed copy is simply
   * the one that was on screen first.
   */
  streamedSummary: string;
  /** True while a stream is open. */
  busy: boolean;
  /** True where the last request failed outright. */
  failed: boolean;
  /** Asks for the opening summary of the chart. */
  onExplain: () => void;
  /** Asks a typed question. */
  onAsk: (question: string) => void;
  /** Role-specific prompts, already translated. */
  suggestions: readonly string[];
  /** The cycling placeholders for the field, already translated. */
  placeholders: readonly string[];
  /** Renders an in-app link. Supplied so this file needs no router type. */
  renderLink: (href: string, children: ReactNode) => ReactNode;
  /** Already formatted, e.g. "2 minutes ago". */
  generatedLabel?: string | undefined;
  className?: string | undefined;
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export function AiInsightsCard({
  labels,
  insight,
  streamedSummary,
  busy,
  failed,
  onExplain,
  onAsk,
  suggestions,
  placeholders,
  renderLink,
  generatedLabel,
  className,
}: AiInsightsCardProps): React.JSX.Element {
  const [question, setQuestion] = useState('');
  const [vanishing, setVanishing] = useState(false);
  const field = useRef<HTMLInputElement | null>(null);

  const placeholder = useCyclingPlaceholder(placeholders, question.length === 0 && !busy);

  const reduced = useReducedMotion() ?? false;

  /*
   * One state for both controls.
   *
   * The CTA and the question field are two ways of asking the same endpoint
   * the same thing, so they cannot be in different states — a spinner on one
   * and an idle button on the other would say two requests are in flight when
   * there is one.
   */
  const askState = busy ? 'streaming' : failed ? 'failed' : insight === null ? 'idle' : 'done';

  /*
   * What the reader is actually looking at.
   *
   * While a stream is open this is the partial text; once it closes it is the
   * finished summary. They are the same words, so the swap is invisible — and
   * reading from `insight` afterwards rather than keeping the streamed copy is
   * what guarantees the panel shows the validated object in the end.
   */
  const shownSummary = busy ? streamedSummary : (insight?.summary ?? '');

  function submit(): void {
    const trimmed = question.trim();
    if (trimmed.length === 0 || busy) return;

    /*
     * The field empties itself as the question goes.
     *
     * A short fade rather than a per-character dissolve: this sits on an
     * operations screen, and the flourish that is charming once is tiresome on
     * the fortieth question. The global reduced-motion rule in index.css turns
     * the transition off, and the field still clears — the information is in
     * the clearing, not in the animation.
     */
    setVanishing(true);
    onAsk(trimmed);

    window.setTimeout(() => {
      setQuestion('');
      setVanishing(false);
    }, 180);
  }

  return (
    <section
      className={cx('console-card flex flex-col overflow-hidden', className)}
      aria-label={labels.title}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-console-border/70 px-5 py-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-title-xs text-ink">
            <SparkIcon />
            {labels.title}
          </h2>
          <p className="mt-0.5 max-w-prose text-xxs leading-relaxed text-ink-subtle">
            {labels.disclosure}
          </p>
        </div>

        <InsightCta
          state={askState}
          onClick={onExplain}
          labels={{
            idle: labels.explainChart,
            streaming: labels.explaining,
            done: labels.explained,
            failed: labels.explainFailed,
            busyAnnouncement: labels.explaining,
          }}
        />
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 py-4">
        {/*
          The answer.

          One polite live region around the whole answer, announced when it is
          complete. `aria-busy` while a request is in flight, so a screen
          reader says "busy" once rather than reading a half-built paragraph.
        */}
        <div aria-live="polite" aria-busy={busy} className="min-w-0">
          {insight === null && !busy ? (
            <p className="text-sm text-ink-subtle">{failed ? labels.askFailed : labels.idle}</p>
          ) : null}

          {/*
            The summary, while it is arriving.

            Rendered separately from the block below so the findings do not
            mount until they exist — a card that grows a heading with nothing
            under it and then fills it in is a card that jumps twice.

            The caret is the only thing on this screen that blinks, it appears
            only while a stream is open, and it is `aria-hidden`: "the answer
            is still coming" is already carried by `aria-busy`.
          */}
          {busy ? (
            <p className="text-sm leading-relaxed text-ink">
              {shownSummary}
              {reduced ? null : (
                <span
                  aria-hidden="true"
                  className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-brand"
                />
              )}
            </p>
          ) : null}

          {insight === null ? null : (
            <>
              {insight.source === 'deterministic' ? (
                <p className="mb-3 rounded-md bg-warning-soft px-3 py-2 text-xxs leading-relaxed text-warning">
                  {insight.fallbackReason === 'not-configured'
                    ? labels.deterministic
                    : labels.unavailable}
                </p>
              ) : null}

              {busy ? null : (
                <p className="text-sm leading-relaxed text-ink">{insight.summary}</p>
              )}

              {insight.findings.length === 0 || busy ? null : (
                <>
                  <h3 className="mt-4 text-xxs font-semibold uppercase tracking-[0.12em] text-ink-subtle">
                    {labels.findings}
                  </h3>
                  {/*
                    A short stagger as the findings land — 40ms apart, once.
                    Enough that they read as arriving in order rather than
                    appearing as a block, and short enough that nobody waits
                    for the fourth. `AnimatePresence` so a re-ask animates the
                    old set out rather than swapping the text underneath.
                  */}
                  <AnimatePresence mode="popLayout">
                  <ul className="mt-2 space-y-2">
                    {insight.findings.map((finding, index) => (
                      <motion.li
                        key={`${finding.title}-${String(index)}`}
                        initial={reduced ? false : { opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        {...(reduced ? {} : { exit: { opacity: 0 } })}
                        transition={{ duration: 0.22, delay: reduced ? 0 : index * 0.04 }}
                        className="rounded-md border border-console-border/70 px-3 py-2"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <SeverityChip severity={finding.severity} label={labels.severity[finding.severity]} />
                          <p className="min-w-0 text-xs font-semibold text-ink">{finding.title}</p>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-ink-muted">{finding.detail}</p>
                      </motion.li>
                    ))}
                  </ul>
                  </AnimatePresence>
                </>
              )}

              {insight.suggestedActions.length === 0 || busy ? null : (
                <>
                  <h3 className="mt-4 text-xxs font-semibold uppercase tracking-[0.12em] text-ink-subtle">
                    {labels.nextSteps}
                  </h3>
                  <ul className="mt-2 space-y-1.5">
                    {insight.suggestedActions.map((action, index) => (
                      <li key={`${action.label}-${String(index)}`} className="text-xs">
                        {/*
                          A link only where the server attached one, and the
                          server only attaches one it took from a metric. An
                          action with no destination is still worth showing —
                          it just is not a link, because a link that goes
                          nowhere is worse than a sentence.
                        */}
                        {action.href === null ? (
                          <span className="font-medium text-ink">{action.label}</span>
                        ) : (
                          renderLink(
                            action.href,
                            <span className="font-medium text-brand underline-offset-2 hover:underline">
                              {action.label}
                            </span>,
                          )
                        )}
                        <span className="text-ink-muted"> — {action.detail}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              {insight.evidence.length === 0 || busy ? null : (
                <details className="group mt-4">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded text-xxs font-medium text-ink-muted transition-colors hover:text-ink">
                    <ChevronIcon />
                    {labels.evidence}
                  </summary>

                  <ul className="mt-2 space-y-1">
                    {insight.evidence.map((entry) => (
                      <li
                        key={entry.metricKey}
                        className="flex items-baseline justify-between gap-3 text-xxs"
                      >
                        <span className="min-w-0 truncate text-ink-muted">{entry.label}</span>
                        <span className="tabular shrink-0 text-ink">
                          {entry.value} {entry.unit}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <p className="mt-3 text-xxs text-ink-subtle">
                {generatedLabel === undefined
                  ? null
                  : labels.generated.replace('{{when}}', generatedLabel)}
                {insight.model === null ? null : ` · ${insight.model}`}
              </p>
            </>
          )}
        </div>

        {/* --- Asking ------------------------------------------------------ */}
        <div className="mt-auto">
          {suggestions.length === 0 ? null : (
            <>
              <h3 className="text-xxs font-semibold uppercase tracking-[0.12em] text-ink-subtle">
                {labels.suggestions}
              </h3>
              <ul className="mb-3 mt-1.5 flex flex-wrap gap-1.5">
                {suggestions.map((suggestion) => (
                  <li key={suggestion}>
                    <button
                      type="button"
                      onClick={() => {
                        setQuestion(suggestion);
                        field.current?.focus();
                      }}
                      className="rounded-full border border-console-border/80 px-2.5 py-1 text-xxs text-ink-muted transition-colors hover:border-border-hover hover:text-ink"
                    >
                      {suggestion}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            className="flex items-center gap-2 rounded-full border border-console-border/80 bg-console-raised/70 py-1 pl-4 pr-1"
          >
            <label htmlFor="uboss-ai-question" className="sr-only">
              {labels.askLabel}
            </label>

            <input
              id="uboss-ai-question"
              ref={field}
              type="text"
              value={question}
              maxLength={500}
              onChange={(event) => {
                setQuestion(event.target.value);
              }}
              placeholder={placeholder}
              className={cx(
                'min-h-[2.25rem] min-w-0 flex-1 border-0 bg-transparent p-0 text-xs text-ink placeholder:text-ink-subtle',
                // The field's own focus ring would be a second box inside the
                // rounded pill it lives in; the pill is the control.
                'focus:outline-none focus:ring-0',
                'transition-opacity',
                vanishing && 'opacity-0',
              )}
            />

            <button
              type="submit"
              aria-disabled={busy || question.trim().length === 0}
              className={cx(
                'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors',
                question.trim().length === 0 || busy
                  ? 'bg-surface-hover text-ink-subtle'
                  : 'bg-brand-fill text-ink-inverse hover:bg-brand-fill-hover',
              )}
            >
              <span className="sr-only">{busy ? labels.asking : labels.ask}</span>
              <ArrowIcon />
            </button>
          </form>

          {/*
            The ask button's state, for anyone who cannot see the field clear.
            `sr-only` rather than absent: the send button's accessible name
            already changes, and this says what happened rather than what the
            control is.
          */}
          <p className="sr-only" aria-live="polite">
            {busy ? labels.asking : failed ? labels.askFailed : insight === null ? '' : labels.asked}
          </p>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/**
 * The placeholder that changes every few seconds.
 *
 * Three things it is careful about, because an ambient timer on a dashboard
 * that is left open all day is exactly the kind of thing that is never noticed
 * and never stops:
 *
 *   - **It stops when the tab is hidden.** A background tab cycling a string
 *     every four seconds for eight hours is work nobody asked for, and on a
 *     laptop it is measurable.
 *   - **It stops when the field is in use.** A placeholder that changes while
 *     somebody is reading it, or typing over it, is a distraction rather than
 *     a suggestion.
 *   - **It does not run at all under reduced motion.** Somebody who has asked
 *     for less movement has asked for less movement, and the first placeholder
 *     says everything the rotation would: the field takes a question.
 */
function useCyclingPlaceholder(placeholders: readonly string[], active: boolean): string {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!active || placeholders.length < 2) return;

    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduced) return;

    let timer = 0;

    function schedule(): void {
      timer = window.setTimeout(() => {
        // Only advance while the tab is in front. Re-scheduling either way so
        // the rotation resumes when somebody comes back to it.
        if (!document.hidden) setIndex((current) => (current + 1) % placeholders.length);
        schedule();
      }, 4500);
    }

    schedule();

    return () => {
      window.clearTimeout(timer);
    };
  }, [active, placeholders.length]);

  return placeholders[index % placeholders.length] ?? '';
}

/**
 * How loud a finding is.
 *
 * Carries its own word as well as its colour, for the same reason every badge
 * in this product does: about one man in twelve cannot separate the red from
 * the amber, and "urgent" has to survive that.
 */
function SeverityChip({
  severity,
  label,
}: {
  severity: InsightSeverity;
  label: string;
}): React.JSX.Element {
  return (
    <span
      className={cx(
        'shrink-0 rounded px-1.5 py-0.5 text-xxs font-semibold uppercase tracking-wide ring-1 ring-inset',
        severity === 'urgent'
          ? 'bg-danger-soft text-danger ring-danger/25'
          : severity === 'attention'
            ? 'bg-warning-soft text-warning ring-warning/25'
            : 'bg-surface-sunken text-ink-muted ring-border',
      )}
    >
      {label}
    </span>
  );
}

function SparkIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-4 w-4 shrink-0 text-brand"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 2.5 11.6 7 16 8.6 11.6 10.2 10 14.7 8.4 10.2 4 8.6 8.4 7Z" />
      <path d="M15.5 13.5 16.2 15.3 18 16l-1.8.7-.7 1.8-.7-1.8L13 16l1.8-.7Z" />
    </svg>
  );
}

function ChevronIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m8 6 4 4-4 4" />
    </svg>
  );
}

function ArrowIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-4 w-4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 15.5v-11" />
      <path d="m5.5 9 4.5-4.5L14.5 9" />
    </svg>
  );
}
