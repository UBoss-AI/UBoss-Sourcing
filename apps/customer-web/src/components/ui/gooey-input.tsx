/**
 * The gooey search control, and the filter that makes it gooey.
 *
 * Two round shapes that move apart look like two round shapes moving apart.
 * Put the same two behind a blur and an alpha threshold and they stop being
 * two things: they stretch, neck and pinch, the way a bead of water leaves a
 * tap. That is the whole trick, and it is why this module exports the filter
 * separately from the control — the greeting page's search module in
 * `components/hero-search/HeroSearch.tsx` wants the pinch without wanting this
 * particular input.
 *
 * ---
 *
 * WHERE THIS CAME FROM, AND WHAT HAD TO CHANGE
 *
 * The shape of this is a shadcn-style `gooey-input`. The list of things that
 * could not survive contact with this repository is longer than usual, and
 * three of them are defects rather than house style — `ui/flip-words.tsx`,
 * `ui/background-gradient.tsx` and `ui/3d-globe.tsx` each keep the same kind
 * of list, for the same reason.
 *
 *   - **`cn` is `cx`.** This project's class joiner is `lib/cx.ts`. There is no
 *     `clsx`/`tailwind-merge` pair here, and adding one to satisfy an import
 *     would be two dependencies for one function.
 *   - **There is no `"use client"`.** This is a Vite single-page application,
 *     not a React Server Components tree. The directive is inert here and
 *     reads as a promise that the file is doing something it is not.
 *   - **The input is no longer inside the button.** The original nests
 *     `<input>` inside `<button>`, which is invalid HTML — a button may not
 *     contain interactive content — and browsers act on that: a press lands on
 *     the button rather than the field, so on Firefox the expanded box cannot
 *     be clicked into at all and the caret cannot be placed by pointer
 *     anywhere. The trigger here is a sibling that covers the field while it is
 *     collapsed, and is removed from the tree once it is not.
 *   - **Only one element holds the shared `layoutId` at a time.** The original
 *     renders the magnifier inside the button while collapsed *and* renders a
 *     second one in the bubble at all times, both under the same `layoutId`.
 *     Two live nodes sharing one layout id is a state motion does not define:
 *     it warns, and it animates between whichever two it happened to see. Here
 *     the bubble's copy is mounted only once expanded, so the icon has exactly
 *     one home at every moment and genuinely flies from the one to the other.
 *   - **The `<svg>` holding the filter is not `display: none`.** Tailwind's
 *     `hidden` is `display: none`, and WebKit has long dropped `filter:
 *     url(#id)` references into a subtree it has been told not to render — the
 *     control then renders correctly everywhere except Safari, which is the
 *     worst way for this to fail. It is sized to nothing and clipped instead.
 *   - **The filter interpolates in sRGB.** The SVG default is linearRGB, which
 *     converts every colour on the way in and back on the way out; the blurred
 *     halo that forms the neck comes back visibly lighter than the shapes it
 *     joins, so the bridge reads as a grey smear rather than as the same
 *     material. The alpha threshold this effect depends on is untouched by the
 *     change.
 *   - **`type` is `text`, not `search`.** `type=search` gives WebKit its own
 *     clear button, and this control already has one. Two crosses in one field
 *     is one too many — `hero-search/HeroSearch.tsx` carries the same note.
 *   - **`prefers-reduced-motion` gets no goo.** A control that stretches and
 *     snaps is exactly what that preference is asking to be spared. Under it
 *     the width still changes, because the box genuinely is a different size
 *     and pretending otherwise would hide the field, but there is no spring,
 *     no travelling icon and no filter.
 *   - **The filter is only mounted while something is moving.** An SVG filter
 *     over a live text field is not free: it re-runs on every keystroke, and it
 *     costs the text its subpixel antialiasing for as long as it is applied, so
 *     a permanently filtered input reads as slightly soft next to every other
 *     field on the page. It is applied when the state changes and taken off
 *     once the spring has settled.
 *   - **Clearing on collapse is the caller's to choose.** The original wipes
 *     the value whenever the control closes, with no way to ask it not to. That
 *     is right for a front door and wrong for a filter, where it silently
 *     discards what somebody typed the moment they reach for the control beside
 *     it. `clearOnCollapse` defaults to the original's behaviour and can be
 *     turned off.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react';
import { motion } from 'motion/react';
import { SearchIcon } from '@/components/icons';
import { GOOEY_SPRING, useGooeyFilterId } from '@/components/ui/gooey';
import { cx } from '@/lib/cx';
import { usePrefersReducedMotion } from '@/lib/reduced-motion';

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------

/**
 * Blur, threshold the alpha, put the sharp original back on top.
 *
 * The middle step is the effect. `feGaussianBlur` turns each shape into a soft
 * cloud whose edges overlap its neighbour's; the alpha row of the colour matrix
 * (`0 0 0 20 -10`) multiplies that gradient by 20 and shifts it down by 10, so
 * everything above roughly half opacity snaps to solid and everything below
 * snaps to nothing. Two clouds that overlap at all therefore become one shape
 * with a neck between them, and as they separate the neck thins and breaks.
 *
 * `feComposite … operator="atop"` then draws the unblurred source over the
 * result, which is what keeps text and icons sharp: the goo supplies the
 * silhouette, the original supplies the detail.
 */
export function GooeyFilter({ filterId, blur = 5 }: { filterId: string; blur?: number }): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none absolute h-0 w-0 overflow-hidden"
    >
      <defs>
        <filter
          id={filterId}
          x="-50%"
          y="-50%"
          width="200%"
          height="200%"
          colorInterpolationFilters="sRGB"
        >
          <feGaussianBlur in="SourceGraphic" stdDeviation={blur} result="blur" />
          <feColorMatrix
            in="blur"
            type="matrix"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -10"
            result="goo"
          />
          <feComposite in="SourceGraphic" in2="goo" operator="atop" />
        </filter>
      </defs>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The control
// ---------------------------------------------------------------------------

export interface GooeyInputClassNames {
  root?: string;
  filterWrap?: string;
  buttonRow?: string;
  trigger?: string;
  input?: string;
  bubble?: string;
  bubbleSurface?: string;
}

export interface GooeyInputProps {
  /** Shown in the field once it is open, and on the pill before it is. */
  label: string;
  placeholder?: string;
  className?: string;
  classNames?: GooeyInputClassNames;
  /** Collapsed control width, in pixels. */
  collapsedWidth?: number;
  /** Expanded control width, in pixels. */
  expandedWidth?: number;
  /** How far the box slides right as it opens, leaving room for the bubble. */
  expandedOffset?: number;
  /** Blur radius of the gooey filter. Larger necks stretch further. */
  gooeyBlur?: number;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  onOpenChange?: (open: boolean) => void;
  /** Called on Enter, with the current value. */
  onSubmit?: (value: string) => void;
  /** Wipe the value when the control closes. See the note in the header. */
  clearOnCollapse?: boolean;
  disabled?: boolean;
}

export function GooeyInput({
  label,
  placeholder,
  className,
  classNames,
  collapsedWidth = 115,
  expandedWidth = 200,
  expandedOffset = 50,
  gooeyBlur = 5,
  value: valueProp,
  defaultValue = '',
  onValueChange,
  onOpenChange,
  onSubmit,
  clearOnCollapse = true,
  disabled = false,
}: GooeyInputProps): React.JSX.Element {
  const reduced = usePrefersReducedMotion();

  const filterId = useGooeyFilterId('gooey-filter');
  const iconLayoutId = `${filterId}-icon`;
  const fieldId = `${filterId}-field`;

  const inputRef = useRef<HTMLInputElement>(null);
  const wasExpanded = useRef(false);

  const [isExpanded, setIsExpanded] = useState(false);
  // True from the moment the state changes until the spring has settled. The
  // filter is mounted for exactly that window — see the header.
  const [isMorphing, setIsMorphing] = useState(false);
  const [uncontrolled, setUncontrolled] = useState(defaultValue);

  const isControlled = valueProp !== undefined;
  const text = isControlled ? valueProp : uncontrolled;

  const setText = useCallback(
    (next: string) => {
      if (!isControlled) setUncontrolled(next);
      onValueChange?.(next);
    },
    [isControlled, onValueChange],
  );

  const setExpanded = useCallback(
    (next: boolean) => {
      setIsExpanded((current) => {
        if (current !== next && !reduced) setIsMorphing(true);
        return next;
      });
      onOpenChange?.(next);
    },
    [onOpenChange, reduced],
  );

  /*
   * Focus on the way open, and — if the caller wants it — clear on the way
   * shut. Guarded on having been open before, so a control that has never been
   * touched does not clear a `defaultValue` out from under itself on mount.
   */
  useEffect(() => {
    if (isExpanded) {
      inputRef.current?.focus();
    } else if (wasExpanded.current && clearOnCollapse) {
      setText('');
    }
    wasExpanded.current = isExpanded;
  }, [isExpanded, clearOnCollapse, setText]);

  const boxVariants = useMemo(
    () => ({
      collapsed: { width: collapsedWidth, marginLeft: 0 },
      expanded: { width: expandedWidth, marginLeft: expandedOffset },
    }),
    [collapsedWidth, expandedWidth, expandedOffset],
  );

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setText(event.target.value);
    },
    [setText],
  );

  const handleBlur = useCallback(() => {
    if (text.length === 0) setExpanded(false);
  }, [text, setExpanded]);

  const surface = 'bg-ink text-white shadow-card ring-1 ring-border/60';

  return (
    <div
      className={cx('relative flex items-center justify-center', className, classNames?.root)}
    >
      {isMorphing && <GooeyFilter filterId={filterId} blur={gooeyBlur} />}

      <div
        className={cx('relative flex h-10 items-center justify-center', classNames?.filterWrap)}
        // Only while something is moving. A filter left on a live text field
        // re-runs on every keystroke and costs the text its subpixel
        // antialiasing for as long as it is applied.
        style={isMorphing ? { filter: `url(#${filterId})` } : undefined}
      >
        <motion.div
          className={cx('flex h-10 items-center justify-center', classNames?.buttonRow)}
          variants={boxVariants}
          initial="collapsed"
          animate={isExpanded ? 'expanded' : 'collapsed'}
          transition={reduced ? { duration: 0 } : GOOEY_SPRING}
          onAnimationComplete={() => {
            setIsMorphing(false);
          }}
        >
          <div
            className={cx(
              'relative flex h-10 w-full items-center gap-2 rounded-full px-4',
              surface,
              classNames?.trigger,
            )}
          >
            {/* The magnifier lives here while the control is shut, and in the
                bubble once it is open. Never in both at once. */}
            {!isExpanded && (
              <motion.span {...(reduced ? {} : { layoutId: iconLayoutId })} className="flex shrink-0">
                <SearchIcon className="h-4 w-4" />
              </motion.span>
            )}

            <label htmlFor={fieldId} className="sr-only">
              {label}
            </label>
            <input
              id={fieldId}
              ref={inputRef}
              // `text`, not `search`: see the note in the header.
              type="text"
              enterKeyHint="search"
              autoComplete="off"
              value={text}
              onChange={handleChange}
              onBlur={handleBlur}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onSubmit?.(text);
                }
                if (event.key === 'Escape') setExpanded(false);
              }}
              disabled={disabled}
              placeholder={isExpanded ? placeholder : label}
              className={cx(
                'h-full min-w-0 flex-1 bg-transparent text-sm text-white outline-none',
                isExpanded ? 'placeholder:text-white/50' : 'placeholder:text-white/80',
                classNames?.input,
              )}
            />

            {/*
             * The trigger, over the field rather than around it.
             *
             * While the control is shut the field is not the thing being
             * offered — the pill is — so a transparent button covers it and
             * takes the press. It is unmounted once open, which is what lets
             * the caret be placed by pointer.
             */}
            {!isExpanded && (
              <button
                type="button"
                disabled={disabled}
                aria-expanded={false}
                aria-controls={fieldId}
                onClick={() => {
                  setExpanded(true);
                }}
                className="absolute inset-0 cursor-pointer rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-surface disabled:pointer-events-none disabled:opacity-50"
              >
                <span className="sr-only">{label}</span>
              </button>
            )}
          </div>
        </motion.div>

        {/* The bubble that pinches off. Mounted only once expanded, so the
            magnifier has exactly one home at every moment. */}
        {isExpanded && (
          <motion.div
            className={cx(
              'pointer-events-none absolute left-0 top-1/2 flex size-10 items-center justify-center',
              classNames?.bubble,
            )}
            initial={reduced ? false : { scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={reduced ? { duration: 0 } : GOOEY_SPRING}
            /*
             * The half-height shift is motion's, not Tailwind's.
             *
             * A `-translate-y-1/2` class on an element motion is animating
             * loses: motion writes the whole `transform` inline from the values
             * it is tracking, and a class it does not know about is simply
             * overwritten. The bubble then hangs half its own height below the
             * field.
             */
            style={{ y: '-50%' }}
          >
            <div
              className={cx(
                'flex size-10 items-center justify-center rounded-full',
                surface,
                classNames?.bubbleSurface,
              )}
            >
              <motion.span {...(reduced ? {} : { layoutId: iconLayoutId })} className="flex">
                <SearchIcon className="h-4 w-4" />
              </motion.span>
            </div>
          </motion.div>
        )}
      </div>
    </div>
  );
}
