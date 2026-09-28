/**
 * A star rating: an input when a buyer is scoring, a display everywhere else.
 *
 * Adapted from Spectrum UI's StarRating. Hovering previews a score with a
 * spring fill and a small scale wave around the pointer, clicking commits it
 * with a pop and a short sparkle burst, and an optional rolling "4/5" label
 * follows the preview. Read-only mode draws fractional values (4.3) by
 * clipping the filled star, which stays crisp at any size.
 *
 * What changed on the way in, and why:
 *
 *   - **Colours are tokens.** `text-rating` for a filled star and
 *     `text-border-strong` for an empty one, both audited at 3:1 against the
 *     surfaces in `scripts/contrast-audit.cjs`. The original's `amber-400`
 *     sits at 1.7:1 on white, which makes "filled or not" invisible to a
 *     low-vision buyer - and filled-or-not is the whole information.
 *   - **Every word is translated.** The group's name comes in as `label`; the
 *     per-star names and the read-only sentence come from the catalogue.
 *   - **Reduced motion is answered by not animating**, through the same
 *     `usePrefersReducedMotion` the rest of the storefront uses.
 *   - **`disabled`** stops input while a save is in flight, so a second click
 *     cannot race the first.
 *
 * Semantics: a `radiogroup` of `radio` buttons with a roving tab stop, so the
 * group is one Tab stop and the arrow keys move the score. Read-only is a
 * single `img` with a sentence for a name ("Rated 4.3 out of 5").
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, type Transition } from 'motion/react';
import { cx } from '@/lib/cx';
import { formatRating } from '@/lib/ratings';
import { usePrefersReducedMotion } from '@/lib/reduced-motion';
import { useI18n } from '@/i18n/i18n-context';

export interface StarRatingProps {
  /** Controlled value. Leave undefined for uncontrolled use. */
  value?: number;
  /** Starting value when uncontrolled. */
  defaultValue?: number;
  /** Called with the new score on every commit. */
  onValueChange?: (value: number) => void;
  /** Number of stars. */
  max?: number;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  /** Clicking the chosen star again clears the score to 0. */
  allowClear?: boolean;
  /** Display only. Takes fractional values. */
  readOnly?: boolean;
  /** Ignore input without changing how the stars look. */
  disabled?: boolean;
  /** Show a rolling "4/5" beside the stars. */
  showValue?: boolean;
  /** The group's accessible name, e.g. "Quality". */
  label: string;
  /** Points at an error message, for a form that requires a score. */
  describedBy?: string;
  invalid?: boolean;
  className?: string;
}

const SPARKLE_COUNT = 5;
const BURST_DURATION = 0.5;

const FILL_SPRING: Transition = { type: 'spring', stiffness: 500, damping: 30 };
/** A tween for un-filling, so a star never overshoots below zero scale. */
const UNFILL_TWEEN: Transition = { duration: 0.15, ease: 'easeOut' };
const VALUE_SPRING: Transition = { type: 'spring', stiffness: 400, damping: 30 };
const INSTANT: Transition = { duration: 0 };
/** Squash and stretch on commit. */
const POP_KEYFRAMES = [1, 0.7, 1.3, 1];
const POP_TRANSITION: Transition = { duration: 0.45, times: [0, 0.25, 0.6, 1], ease: 'easeOut' };
const WAVE_PRIMARY_SCALE = 1.2;
const WAVE_NEIGHBOR_SCALE = 1.08;

/** `pad` keeps each interactive star's hit area at least 24px square. */
const SIZES = {
  xs: { icon: 12, pad: 'p-0', text: 'text-xxs', gap: 'ml-1' },
  sm: { icon: 16, pad: 'p-1', text: 'text-xs', gap: 'ml-1.5' },
  md: { icon: 22, pad: 'p-0.5', text: 'text-sm', gap: 'ml-2' },
  lg: { icon: 28, pad: 'p-0.5', text: 'text-sm', gap: 'ml-2.5' },
} as const;

const STAR_PATH =
  'M12 2L14.65 8.36L21.51 8.91L16.28 13.39L17.88 20.09L12 16.5L6.12 20.09L7.72 13.39L2.49 8.91L9.35 8.36Z';

const valueVariants = {
  enter: (direction: number) => ({ y: direction * 12, opacity: 0 }),
  center: { y: 0, opacity: 1 },
  exit: (direction: number) => ({ y: direction * -12, opacity: 0 }),
};

function Star({
  size,
  filled = false,
  className,
}: {
  size: number;
  filled?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cx('block', className)}
    >
      <path d={STAR_PATH} />
    </svg>
  );
}

export function StarRating({
  value: valueProp,
  defaultValue = 0,
  onValueChange,
  max = 5,
  size = 'md',
  allowClear = false,
  readOnly = false,
  disabled = false,
  showValue = false,
  label,
  describedBy,
  invalid = false,
  className,
}: StarRatingProps): React.JSX.Element {
  const { t } = useI18n();
  const reduceMotion = usePrefersReducedMotion();
  const [internalValue, setInternalValue] = useState(defaultValue);
  const [hovered, setHovered] = useState<number | null>(null);
  const [burst, setBurst] = useState<{ key: number; index: number } | null>(null);
  const starRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const value = valueProp ?? internalValue;
  const { icon, pad, text, gap } = SIZES[size];
  const interactive = !readOnly && !disabled;
  // Hovering previews; leaving falls back to the committed score.
  const previewValue = interactive && hovered !== null ? hovered : value;
  // Reserve the widest rendering so "/5" never shifts as the digits roll.
  const valueWidthCh = Math.max(String(max).length, formatRating(previewValue).length);

  // Digits roll up as the preview rises and down as it falls.
  const previousPreviewRef = useRef(previewValue);
  const direction = previewValue >= previousPreviewRef.current ? 1 : -1;
  useEffect(() => {
    previousPreviewRef.current = previewValue;
  }, [previewValue]);

  const commitValue = useCallback(
    (next: number) => {
      if (valueProp === undefined) setInternalValue(next);
      onValueChange?.(next);
    },
    [valueProp, onValueChange],
  );

  const handleSelect = useCallback(
    (starValue: number) => {
      if (!interactive) return;
      const next = allowClear && starValue === value ? 0 : starValue;
      commitValue(next);
      if (next > 0 && !reduceMotion) {
        setBurst((previous) => ({ key: (previous?.key ?? 0) + 1, index: starValue - 1 }));
      }
    },
    [interactive, allowClear, value, commitValue, reduceMotion],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (!interactive) return;
      let next: number;
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowUp':
          next = Math.min(value + 1, max);
          break;
        case 'ArrowLeft':
        case 'ArrowDown':
          next = Math.max(value - 1, 1);
          break;
        case 'Home':
          next = 1;
          break;
        case 'End':
          next = max;
          break;
        default:
          return;
      }
      event.preventDefault();
      if (next !== value) commitValue(next);
      starRefs.current[next - 1]?.focus();
    },
    [interactive, value, max, commitValue],
  );

  // The hovered star grows and its neighbours follow at a falloff: a wave.
  const scaleFor = (index: number): number => {
    if (reduceMotion || !interactive || hovered === null) return 1;
    const distance = Math.abs(index + 1 - hovered);
    if (distance === 0) return WAVE_PRIMARY_SCALE;
    if (distance === 1) return WAVE_NEIGHBOR_SCALE;
    return 1;
  };

  // Roving tab stop: the chosen star, or the first when nothing is chosen.
  const focusIndex = value >= 1 && value <= max ? Math.round(value) - 1 : 0;

  if (readOnly) {
    return (
      <div
        role="img"
        aria-label={t('rating.readOnly', { label, value: formatRating(value), max })}
        className={cx('inline-flex select-none items-center', className)}
      >
        <span className="flex items-center gap-px">
          {Array.from({ length: max }).map((_, index) => {
            const fillPercent = Math.max(0, Math.min(1, value - index)) * 100;
            return (
              <span key={index} className="relative block" style={{ width: icon, height: icon }}>
                <Star size={icon} className="text-border-strong" />
                {fillPercent > 0 && (
                  <span
                    className="absolute inset-0 text-rating"
                    style={{ clipPath: `inset(0 ${String(100 - fillPercent)}% 0 0)` }}
                  >
                    <Star size={icon} filled />
                  </span>
                )}
              </span>
            );
          })}
        </span>
        {showValue && (
          <span aria-hidden="true" className={cx('font-medium tabular-nums text-ink-muted', text, gap)}>
            {formatRating(value)}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      aria-disabled={disabled || undefined}
      onPointerLeave={() => {
        setHovered(null);
      }}
      className={cx('inline-flex select-none items-center', className)}
    >
      <div className="flex items-center">
        {Array.from({ length: max }).map((_, index) => {
          const starValue = index + 1;
          const filled = starValue <= previewValue;
          const isBursting = burst?.index === index;

          return (
            <button
              key={index}
              ref={(node) => {
                starRefs.current[index] = node;
              }}
              type="button"
              role="radio"
              aria-checked={starValue === value}
              aria-label={t('rating.starOption', { count: starValue })}
              tabIndex={index === focusIndex ? 0 : -1}
              disabled={disabled}
              onKeyDown={handleKeyDown}
              onClick={() => {
                handleSelect(starValue);
              }}
              onPointerEnter={(event) => {
                // A touch tap emulates hover but never sends the matching
                // leave, which would strand the preview - mouse only.
                if (event.pointerType === 'mouse' && interactive) setHovered(starValue);
              }}
              className={cx(
                'relative touch-manipulation rounded-md outline-none',
                'transition-transform duration-150 ease-out active:scale-90',
                'motion-reduce:transition-none motion-reduce:active:scale-100',
                'focus-visible:ring-2 focus-visible:ring-ring',
                'disabled:cursor-not-allowed',
                pad,
              )}
            >
              <motion.span
                className="relative block"
                style={{ width: icon, height: icon }}
                initial={false}
                animate={isBursting ? { scale: POP_KEYFRAMES } : { scale: scaleFor(index) }}
                transition={isBursting ? POP_TRANSITION : reduceMotion ? INSTANT : FILL_SPRING}
              >
                <Star
                  size={icon}
                  className={invalid ? 'text-danger' : 'text-border-strong'}
                />
                <motion.span
                  className="absolute inset-0 text-rating"
                  initial={false}
                  animate={{ scale: filled ? 1 : 0, opacity: filled ? 1 : 0 }}
                  transition={reduceMotion ? INSTANT : filled ? FILL_SPRING : UNFILL_TWEEN}
                >
                  <Star size={icon} filled />
                </motion.span>
              </motion.span>

              {isBursting && (
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 flex items-center justify-center"
                >
                  {Array.from({ length: SPARKLE_COUNT }).map((__, sparkleIndex) => {
                    const angle = (sparkleIndex / SPARKLE_COUNT) * Math.PI * 2 - Math.PI / 2;
                    const distance = icon * 1.2;
                    const dotSize = Math.max(2, Math.round(icon * 0.16));
                    const burstKey = burst.key;
                    return (
                      <motion.span
                        key={`sparkle-${String(burstKey)}-${String(sparkleIndex)}`}
                        className="absolute rounded-full bg-rating"
                        style={{ width: dotSize, height: dotSize }}
                        initial={{ x: 0, y: 0, scale: 0, opacity: 1 }}
                        animate={{
                          x: Math.cos(angle) * distance,
                          y: Math.sin(angle) * distance,
                          scale: [0, 1, 0.3],
                          opacity: [1, 1, 0],
                        }}
                        transition={{ duration: BURST_DURATION, ease: 'easeOut' }}
                        // Clear only if a newer burst has not replaced this one.
                        {...(sparkleIndex === 0
                          ? {
                              onAnimationComplete: () => {
                                setBurst((current) => (current?.key === burstKey ? null : current));
                              },
                            }
                          : {})}
                      />
                    );
                  })}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {showValue && (
        <span
          aria-hidden="true"
          className={cx('inline-flex font-medium tabular-nums text-ink-muted', text, gap)}
        >
          <span
            className="relative inline-flex justify-end overflow-hidden"
            style={{ minWidth: `${String(valueWidthCh)}ch` }}
          >
            <AnimatePresence mode="popLayout" initial={false} custom={direction}>
              <motion.span
                key={formatRating(previewValue)}
                className="inline-block"
                custom={direction}
                variants={valueVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={reduceMotion ? INSTANT : VALUE_SPRING}
              >
                {formatRating(previewValue)}
              </motion.span>
            </AnimatePresence>
          </span>
          <span>/{max}</span>
        </span>
      )}
    </div>
  );
}
