/**
 * Text that blows away when it is sent.
 *
 * On submit the words are painted onto a canvas, broken into one particle per
 * few pixels, and swept away right to left while the real field goes
 * transparent underneath. The field is not cleared by this — the particles are
 * a picture of what was there, and who owns the actual value is the caller's
 * business. That distinction is the reason `useVanish` exists next to the
 * component: `pages/ai/AiComposer.tsx` sends a message whose draft is only
 * cleared once the API has accepted it, and a restored draft after a failed
 * send has to reappear rather than having been eaten by an animation.
 *
 * The placeholders cycle while the field is empty, so an empty composer keeps
 * suggesting what it is for.
 *
 * ---
 *
 * WHERE THIS CAME FROM, AND WHAT HAD TO CHANGE
 *
 * The shape of this is the Aceternity `placeholders-and-vanish-input`. Ten
 * things could not survive contact with this repository, and most of them are
 * defects rather than house style — `ui/flip-words.tsx` and `ui/gooey-input.tsx`
 * keep the same kind of list, for the same reason.
 *
 *   - **`cn` is `cx`, and there is no `"use client"`.** Same two as every other
 *     adapted component here. This is a Vite single-page application.
 *   - **The interval is armed off a length, and only ever one is alive.** The
 *     original's effect depends on the `placeholders` array itself, and its own
 *     demo passes an array literal — a new identity on every render, so the
 *     effect re-runs on every render and leaves another live interval behind
 *     each time. Its `visibilitychange` handler then calls `startAnimation()`
 *     again without clearing the one already running, so every trip away from
 *     the tab adds one more. Within a minute the placeholder is flickering.
 *     Here the effect depends on `placeholders.length`, a number, and there is
 *     exactly one timer.
 *   - **A pixel is found by its alpha, not by its colour.** The original keeps
 *     a pixel when all three of red, green and blue are non-zero. That works
 *     only for the white-on-nothing it hard-codes: any ink with a zero channel
 *     — this storefront's danger red among them — is invisible to the test, so
 *     the text simply fails to disperse. Alpha is the question being asked.
 *   - **It is painted in the field's own colour.** The original fills `#FFF`
 *     and then puts a CSS `invert` over the canvas to get back to black, which
 *     inverts to the wrong colour under any theme that is not black-on-white.
 *     Reading `color` off the field is both simpler and right in both themes.
 *   - **The canvas is the size of the field.** The original is a fixed 800×800
 *     drawn at one baseline, so a message wider than 800 pixels is cut and a
 *     second line is never drawn at all. The AI composer is a textarea that
 *     grows to two hundred pixels of wrapped text, which is the normal case
 *     here, not the edge one. This measures the field, wraps to its width, and
 *     draws every line.
 *   - **Particles are typed, and sampled.** `any[]` does not survive this
 *     project's TypeScript settings. Sampling every second pixel on both axes
 *     quarters the particle count at twice the device resolution, which is the
 *     difference between a long message dissolving smoothly and dropping
 *     frames on the fourth line.
 *   - **A particle is filled, not stroked.** The original calls `stroke()` on a
 *     one-pixel rect and never `fill()`, so what lands on screen is a hairline
 *     outline that happens to look solid at r=1 and disappears as r shrinks.
 *   - **The timer is a browser timer.** `NodeJS.Timeout` is the wrong type in a
 *     browser bundle; `window.setInterval` returns a number.
 *   - **The frame loop is cancelled.** The original's `requestAnimationFrame`
 *     chain keeps running after the component has gone, writing to a canvas
 *     that is no longer in the document.
 *   - **`prefers-reduced-motion` gets neither effect.** Text that shatters is
 *     precisely what that preference is asking to be spared, and a placeholder
 *     that rewrites itself under the reader is the other half of it. Under it
 *     the first placeholder is rendered and left alone, and a submit clears
 *     without a picture. `docs/ACCESSIBILITY.md` has the rule.
 */

import { useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { SendIcon } from '@/components/icons';
import { useCyclingPlaceholder, useVanish } from '@/components/ui/vanish';
import { cx } from '@/lib/cx';

// ---------------------------------------------------------------------------
// The placeholder line
// ---------------------------------------------------------------------------

/**
 * The placeholder line, rising into place as the one before it leaves.
 *
 * Laid over the field rather than set on it, because a real `placeholder`
 * attribute cannot be animated and swapping it mid-word is a jump. It is
 * `aria-hidden` and `pointer-events-none`: the field carries its own accessible
 * name, and a placeholder that a screen reader reads five times is noise.
 */
export function CyclingPlaceholder({
  placeholders,
  index,
  className,
}: {
  placeholders: string[];
  index: number;
  className?: string;
}): React.JSX.Element {
  const current = placeholders[index] ?? '';

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-start">
      <AnimatePresence mode="wait">
        <motion.p
          key={`${String(index)}:${current}`}
          initial={{ y: 5, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -15, opacity: 0 }}
          transition={{ duration: 0.3, ease: 'linear' }}
          className={cx('w-full truncate text-left', className)}
        >
          {current}
        </motion.p>
      </AnimatePresence>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The whole control
// ---------------------------------------------------------------------------

/**
 * A single-line field with both behaviours wired together.
 *
 * This is the component as the original offers it, minus the defects listed in
 * the header. It owns its own value, which is what makes it a drop-in for a
 * plain search box and what makes it the wrong choice for the AI composer —
 * that one uses `useVanish` directly.
 */
export function PlaceholdersAndVanishInput({
  placeholders,
  label,
  submitLabel,
  onChange,
  onSubmit,
  className,
}: {
  placeholders: string[];
  /** The field's accessible name. The placeholders cycle and cannot be it. */
  label: string;
  /** The submit button's accessible name. It is an icon on its own. */
  submitLabel: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  className?: string;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const { canvasRef, isVanishing, vanish } = useVanish(inputRef);

  const [value, setValue] = useState('');
  const index = useCyclingPlaceholder(placeholders.length, value.length > 0);

  const submit = (): void => {
    if (value.length === 0 || isVanishing) return;
    vanish(value);
    onSubmit?.(value);
    setValue('');
  };

  return (
    <form
      role="search"
      className={cx(
        'relative mx-auto h-12 w-full max-w-xl overflow-hidden rounded-full border border-border-strong bg-surface shadow-card transition-[border-color,box-shadow] focus-within:border-brand focus-within:shadow-card-hover',
        className,
      )}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className={cx(
          'pointer-events-none absolute inset-y-0 left-0 h-full w-full',
          isVanishing ? 'opacity-100' : 'opacity-0',
        )}
      />

      <label htmlFor="vanish-input" className="sr-only">
        {label}
      </label>
      <input
        id="vanish-input"
        ref={inputRef}
        type="text"
        value={value}
        enterKeyHint="search"
        autoComplete="off"
        onChange={(event) => {
          if (isVanishing) return;
          setValue(event.target.value);
          onChange?.(event.target.value);
        }}
        className={cx(
          'relative z-10 h-full w-full rounded-full bg-transparent pl-5 pr-14 text-sm text-ink outline-none sm:text-base',
          isVanishing && 'text-transparent',
        )}
      />

      {value.length === 0 && (
        <CyclingPlaceholder
          placeholders={placeholders}
          index={index}
          className="py-3 pl-5 pr-14 text-sm text-ink-subtle sm:text-base"
        />
      )}

      <button
        type="submit"
        disabled={value.length === 0}
        aria-label={submitLabel}
        className="absolute right-2 top-1/2 z-10 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-brand-fill text-white transition-colors hover:bg-brand-fill-hover disabled:cursor-not-allowed disabled:bg-ink-subtle"
      >
        <SendIcon className="h-4 w-4" />
      </button>
    </form>
  );
}

