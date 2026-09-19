/**
 * The UBOSS AI Insights call to action.
 *
 * The one deliberately flashy control in the product. It is the button that
 * starts a stream, so it has a job beyond looking expensive: it has to say, at
 * a glance, whether it is idle, generating, or finished — and it has to keep
 * saying it to somebody who cannot see it.
 *
 * KEPT BYTE-IDENTICAL across apps/customer-web, apps/admin-web and
 * apps/logistics-web — see the note at the top of console.tsx.
 *
 * ---
 *
 * WHAT IS BORROWED, AND WHAT IS NOT
 *
 * The treatment follows the visual language Aceternity UI popularised — a
 * conic-gradient border that travels around the edge, a shimmer that crosses
 * the face on hover, a spring press. It is written here on `motion` (the same
 * library those components use) against UBOSS tokens, rather than pasted: an
 * Aceternity component ships its own colours and its own `cn`, and this
 * product's palette is audited in two themes by a script that cannot see a
 * hard-coded hex.
 *
 * ---
 *
 * THREE THINGS THE DECORATION IS NOT ALLOWED TO DO
 *
 *   - **Run when nothing is happening.** The travelling border animates only
 *     while a stream is open. An idle dashboard on a wall has one static
 *     button on it, not a light show.
 *   - **Be the only signal.** The label changes with the state, the icon
 *     changes with the state, and `aria-live` announces it. Take every pixel
 *     of gradient away and the control still reports what it is doing.
 *   - **Ignore a preference.** `useReducedMotion` is read, and under it the
 *     border stops travelling, the shimmer stops crossing and the press stops
 *     springing. Nothing is lost but movement.
 */
import { motion, useReducedMotion } from 'motion/react';
import { cx } from '@/lib/cx';

export type InsightCtaState = 'idle' | 'streaming' | 'done' | 'failed';

export interface InsightCtaLabels {
  idle: string;
  streaming: string;
  done: string;
  failed: string;
  /** "Generating your insight" — announced, not drawn. */
  busyAnnouncement: string;
}

export function InsightCta({
  state,
  labels,
  onClick,
  className,
}: {
  state: InsightCtaState;
  labels: InsightCtaLabels;
  onClick: () => void;
  className?: string | undefined;
}): React.JSX.Element {
  const reduced = useReducedMotion() ?? false;
  const streaming = state === 'streaming';

  return (
    <div className={cx('relative inline-flex', className)}>
      {/*
        The travelling border.

        A conic gradient on a wrapper, rotated, with the button itself sitting
        inset on an opaque ground — so what shows is a 1px ring of moving
        colour. Rotating a gradient is a compositor job; animating a
        `border-image` is not, which is why it is built this way.

        `aria-hidden`, and only present while a stream is open.
      */}
      {streaming && !reduced ? (
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute -inset-px overflow-hidden rounded-full"
        >
          <motion.span
            className="absolute left-1/2 top-1/2 h-[220%] w-[220%] -translate-x-1/2 -translate-y-1/2"
            style={{
              background:
                'conic-gradient(from 0deg, transparent 0%, rgb(var(--console-glow)) 18%, rgb(var(--console-glow-alt)) 30%, transparent 46%)',
            }}
            animate={{ rotate: 360 }}
            transition={{ duration: 2.4, repeat: Infinity, ease: 'linear' }}
          />
        </motion.span>
      ) : null}

      <motion.button
        type="button"
        onClick={onClick}
        aria-disabled={streaming}
        /*
         * A spring on press rather than a duration, because a spring is what
         * makes a control feel physical rather than timed. Disabled under
         * reduced motion, where `whileTap` becomes a no-op object.
         */
        whileTap={reduced ? {} : { scale: 0.97 }}
        whileHover={reduced ? {} : { y: -1 }}
        transition={{ type: 'spring', stiffness: 420, damping: 28 }}
        className={cx(
          /*
           * Sized to sit in the insights panel's one-line header. It was a
           * 2.75rem pill at `text-sm`, which was taller than the heading it
           * shares a row with and set the height of the whole header. 2rem
           * still clears the 24px WCAG 2.2 target minimum comfortably.
           */
          'group relative isolate inline-flex min-h-[2rem] items-center gap-1.5 overflow-hidden rounded-full px-3.5 py-1.5',
          'text-xs font-semibold transition-colors',
          // The ground sits ON TOP of the rotating gradient behind it, which
          // is what turns a spinning disc into a travelling edge.
          'bg-console-raised text-ink',
          'ring-1 ring-inset ring-console-border',
          streaming ? 'cursor-progress' : 'hover:ring-console-glow/60',
          state === 'failed' && 'ring-danger/50',
        )}
      >
        {/*
          The shimmer. One translated bar of light crossing the face on hover,
          clipped by the button's own rounding. Transform only, so it is a
          compositor job and costs no layout.
        */}
        {reduced ? null : (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-console-glow/25 to-transparent transition-transform duration-700 group-hover:translate-x-full"
          />
        )}

        <span className="relative z-10 flex items-center gap-1.5">
          <SparkIcon spinning={streaming && !reduced} />
          <span>{labels[state]}</span>
        </span>
      </motion.button>

      {/*
        What a screen reader is told, separately from what is drawn.

        The button's own label already changes, but a `polite` region is what
        makes the CHANGE announced rather than merely present — and it is the
        only way somebody who is not focusing the button learns the answer has
        started arriving.
      */}
      <span className="sr-only" aria-live="polite">
        {streaming ? labels.busyAnnouncement : ''}
      </span>
    </div>
  );
}

/**
 * The spark.
 *
 * It turns only while a stream is open, and the rotation is a CSS animation on
 * a transform rather than a `motion` value, so it costs nothing to leave
 * mounted when it is still.
 */
function SparkIcon({ spinning }: { spinning: boolean }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      className={cx('h-3.5 w-3.5 shrink-0 text-brand', spinning && 'animate-spin')}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M10 2.5 11.6 7 16 8.6 11.6 10.2 10 14.7 8.4 10.2 4 8.6 8.4 7Z" />
      <path d="M15.5 13.5 16.2 15.3 18 16l-1.8.7-.7 1.8-.7-1.8L13 16l1.8-.7Z" />
    </svg>
  );
}
