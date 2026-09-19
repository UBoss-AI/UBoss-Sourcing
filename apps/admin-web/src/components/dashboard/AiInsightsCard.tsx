/**
 * UBOSS AI Insights.
 *
 * A short paragraph about the figures beside it, and a field to ask a question
 * about them. It is a reading aid, not an operator: nothing in this card
 * changes anything.
 *
 * KEPT BYTE-IDENTICAL across apps/customer-web, apps/admin-web and
 * apps/logistics-web — see the note at the top of console.tsx. It takes no
 * translation key and no router type; strings arrive translated, so the three
 * copies cannot drift.
 *
 * ---
 *
 * IT IS DELIBERATELY SMALL
 *
 * A role dashboard is a chart and this panel, and the chart is the thing being
 * read. So this panel is the answer and the question box and nothing else: one
 * line of heading, one paragraph, one field.
 *
 * It used to draw the findings, the suggested next steps and an evidence list
 * underneath the summary. Three stacked sections and a row of prompt chips
 * made the panel the tallest thing on the screen — the reading aid had outgrown
 * the thing it was helping somebody read.
 *
 * WHAT WENT, AND WHERE IT IS NOW
 *
 * `Insight` still carries `findings`, `suggestedActions` and `evidence`, the
 * server still checks every citation against the metric bundle before it sends
 * one, and the summary is written knowing all three. This card simply does not
 * draw them. Nothing in them pointed anywhere that is not already in the
 * navigation, and the suggested questions did not disappear either: they are
 * the field's cycling placeholder.
 *
 * WHAT IT STILL PROMISES, AND WHY THAT PART COULD NOT GO
 *
 *   - **It says where the answer came from.** A deployment with no AI provider
 *     configured gets a deterministic summary, and this card says so in as many
 *     words rather than passing it off as a model reply. The provider and the
 *     model are named when there is one, which is what AI Act Art. 50 asks for,
 *     and it is not ours to drop for a few pixels of height.
 *   - **It never claims to have done anything.** There is nothing to press here
 *     but "explain" and "ask". Approving, paying, assigning and resolving all
 *     remain a deliberate press on the screen that owns them, behind their own
 *     authorization check and their own audit entry.
 *
 * The answer is announced once, politely, when it lands. Not word by word:
 * this is a paragraph appearing in the corner of a dashboard somebody is
 * reading, and a live region that chatters through a stream makes the rest of
 * the screen unusable to a screen-reader user.
 */
import { useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
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

/**
 * Mirrors `Insight` in backend/src/modules/assistant/insights.service.ts.
 *
 * `findings`, `suggestedActions` and `evidence` are part of the payload and are
 * deliberately not rendered — see the header. They stay in the type because the
 * stream reader hands this shape on as an `Insight`, and a type that described
 * less than the server sends would make that claim untrue.
 */
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
  /**
   * The cycling placeholders for the field, already translated.
   *
   * These are the role's suggested questions. They were a row of chips above
   * the field as well; one row of buttons repeating what the placeholder
   * already offers is exactly the kind of doubling this panel no longer has
   * the room for.
   */
  placeholders: readonly string[];
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
  placeholders,
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
      {/*
        One row. The title, and the control that asks for the opening summary.
        The standing disclosure used to sit under the heading and cost two
        lines of the card before a single word of the answer; it is at the
        bottom now, beside the field it describes.
      */}
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-console-border/70 px-4 py-2.5">
        <h2 className="flex min-w-0 items-center gap-1.5 text-xs font-semibold text-ink">
          <SparkIcon />
          <span className="truncate">{labels.title}</span>
        </h2>

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

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
        {/*
          The answer.

          One polite live region, announced when it is complete. `aria-busy`
          while a request is in flight, so a screen reader says "busy" once
          rather than reading a half-built paragraph.
        */}
        <div aria-live="polite" aria-busy={busy} className="min-w-0">
          {insight === null && !busy ? (
            <p className="text-xs leading-relaxed text-ink-subtle">
              {failed ? labels.askFailed : labels.idle}
            </p>
          ) : null}

          {/*
            The caret is the only thing on this screen that blinks, it appears
            only while a stream is open, and it is `aria-hidden`: "the answer
            is still coming" is already carried by `aria-busy`.
          */}
          {busy ? (
            <p className="text-xs leading-relaxed text-ink">
              {shownSummary}
              {reduced ? null : (
                <span
                  aria-hidden="true"
                  className="ml-0.5 inline-block h-3 w-[2px] translate-y-0.5 animate-pulse bg-brand"
                />
              )}
            </p>
          ) : null}

          {insight === null || busy ? null : (
            <>
              {insight.source === 'deterministic' ? (
                <p className="mb-2 rounded-md bg-warning-soft px-2.5 py-1.5 text-xxs leading-relaxed text-warning">
                  {insight.fallbackReason === 'not-configured'
                    ? labels.deterministic
                    : labels.unavailable}
                </p>
              ) : null}

              <p className="text-xs leading-relaxed text-ink">{insight.summary}</p>

              {/* When it was written, and what wrote it. One line, always. */}
              <p className="mt-2 text-xxs text-ink-subtle">
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
          <form
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
            className="flex items-center gap-2 rounded-full border border-console-border/80 bg-console-raised/70 py-0.5 pl-3.5 pr-0.5"
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
                'min-h-[2rem] min-w-0 flex-1 border-0 bg-transparent p-0 text-xs text-ink placeholder:text-ink-subtle',
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
                'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors',
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
            The standing disclosure. It belongs to everything above it as much
            as to the field, and this is where somebody's eye already is when
            they are about to type.
          */}
          <p className="mt-1.5 px-1 text-xxs leading-relaxed text-ink-subtle">
            {labels.disclosure}
          </p>

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
 * It carries the role's suggested questions now that the chips are gone, so it
 * is the only thing on the panel that says what may be asked. Three things it
 * is careful about, because an ambient timer on a dashboard that is left open
 * all day is exactly the kind of thing that is never noticed and never stops:
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

function SparkIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-3.5 w-3.5 shrink-0 text-brand"
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

function ArrowIcon(): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-3.5 w-3.5"
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
