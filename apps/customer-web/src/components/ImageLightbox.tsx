/**
 * A product photograph, full screen, with a zoom somebody can actually read.
 *
 * ## What this is for
 *
 * The product page already magnifies on hover — `usePointerZoom` and
 * `.zoom-layer` — and that is the right tool for glancing at a bit of a
 * photograph while the rest of the page stays where it is. It is the wrong
 * tool for the thing a trade buyer actually does, which is to take a
 * photograph of a fitting, make it as large as the screen allows, and read a
 * thread size or a moulded part number off it. That needs the whole window,
 * a zoom that stays where it is put, and somewhere to drag to.
 *
 * So: a native `<dialog>`, the picture at whatever size fits, and a scale the
 * viewer controls. Nothing else on screen but the controls and a counter.
 *
 * ## "Without breaking the quality of the image"
 *
 * Two decisions, and neither is a filter:
 *
 *   - **The source is the original file**, the same URL the page shows. There
 *     is no smaller derivative being blown up — whatever resolution the
 *     catalogue holds is the resolution on screen, and at 1x in a full-screen
 *     dialog that is already considerably more pixels than the 800px frame on
 *     the page behind it.
 *   - **The zoom is a `transform: scale()` on the element**, not a redraw into
 *     a canvas and not a width/height change. A composited transform is
 *     resampled by the GPU at the layer's own resolution, stays smooth while
 *     it is being dragged, and — the part that matters here — never resamples
 *     the file twice. Scaling by changing `width` would rasterise at each new
 *     size and soften the edges a little more every step.
 *
 * Past the file's own pixel count no technique invents detail, and this one
 * does not pretend to: `MAX_SCALE` stops at 6x, which is far enough to read a
 * part number off a decent photograph and short of the point where somebody
 * concludes the picture is broken.
 *
 * ## Why not a library
 *
 * The behaviour is a scale, a translation and four event handlers. A lightbox
 * dependency is upwards of 30 KB of someone else's focus management layered
 * over the focus management `<dialog>` already gives for free, and it would
 * need its own styling pass to match the rest of the app anyway.
 *
 * ## The accessibility of it
 *
 * `<dialog>` with `showModal()` gives the focus trap, the top layer, the inert
 * page behind and Escape, and those are the four everybody hand-rolling a
 * lightbox gets wrong. On top of that:
 *
 *   - Every control is a real button with a real label, including the ones
 *     that are also gestures.
 *   - The keyboard alone is enough: `+` and `-` zoom, `0` resets, the arrow
 *     keys pan while zoomed and step between photographs while not, `Escape`
 *     closes.
 *   - The zoom level is announced through a live region, because a scale
 *     nobody can see changing is a control with no feedback.
 *   - The image keeps its alt text. The magnifier on the page behind is
 *     `aria-hidden` because it duplicates an image already described; this one
 *     replaces the page, so it has to describe itself.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { cx } from '@/lib/cx';
import { useI18n } from '@/i18n/i18n-context';

/** What the lightbox shows. Deliberately the same shape as `ProductImage`. */
export interface LightboxImage {
  url: string;
  altText: string | null;
}

/** Fit-to-window. Never smaller — a picture below its own frame is a mistake. */
const MIN_SCALE = 1;

/**
 * Six times the fitted size.
 *
 * Chosen against the catalogue rather than as a round number: the product
 * photography here is commonly 1200-2000px on its longest edge, shown fitted
 * into roughly a 900px square, so 6x is around three times the file's own
 * pixel density. That is the point where a moulded marking is legible and
 * just before the point where the softening reads as a broken image.
 */
const MAX_SCALE = 6;

/** One press of a zoom button, and one notch of a wheel. */
const SCALE_STEP = 0.5;

/** How far one arrow key pans, in screen pixels before the scale is applied. */
const PAN_STEP = 60;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function ImageLightbox({
  images,
  startIndex = 0,
  isOpen,
  onClose,
  /** Named in the title bar, so a dialog opened from a grid says what it is of. */
  title,
}: {
  images: readonly LightboxImage[];
  startIndex?: number;
  isOpen: boolean;
  onClose: () => void;
  title: string;
}): React.JSX.Element | null {
  const { t } = useI18n();

  const dialogRef = useRef<HTMLDialogElement>(null);

  const [index, setIndex] = useState(startIndex);
  const [scale, setScale] = useState(MIN_SCALE);
  /** Where the picture has been dragged to, in CSS pixels at scale 1. */
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  /**
   * The drag in progress, held in a ref rather than in state.
   *
   * A pointer drag fires on every move, and putting the start point in state
   * would re-render the dialog — and with it the `<img>` — on each one. The
   * offset it produces IS state, because the transform has to survive the
   * pointer being lifted; where the finger started is not.
   */
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  const image = images[index] ?? null;
  const isZoomed = scale > MIN_SCALE;

  /** Back to fitted and centred. The state the dialog opens in. */
  const reset = useCallback((): void => {
    setScale(MIN_SCALE);
    setOffset({ x: 0, y: 0 });
  }, []);

  const zoomBy = useCallback((delta: number): void => {
    setScale((previous) => {
      const next = clamp(previous + delta, MIN_SCALE, MAX_SCALE);
      // Sliding back to fitted re-centres. A picture that is exactly its frame
      // and also dragged 200px to the left is a picture with a gap beside it.
      if (next === MIN_SCALE) setOffset({ x: 0, y: 0 });
      return next;
    });
  }, []);

  const step = useCallback(
    (by: number): void => {
      if (images.length < 2) return;
      setIndex((previous) => (previous + by + images.length) % images.length);
      // A new photograph starts fitted. Carrying a 4x zoom across a change of
      // picture lands the viewer on a detail of something they have not seen.
      reset();
    },
    [images.length, reset],
  );

  // Open and close the real dialog to follow the prop. `showModal` is what
  // buys the focus trap and the inert page; `open` alone would give neither.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;

    if (isOpen && !dialog.open) dialog.showModal();
    if (!isOpen && dialog.open) dialog.close();
  }, [isOpen]);

  // Opening on the thumbnail that was clicked, and fitted.
  useEffect(() => {
    if (!isOpen) return;
    setIndex(startIndex);
    reset();
  }, [isOpen, startIndex, reset]);

  // Escape closes the dialog through the browser, which does not tell React.
  // Intercepting `cancel` keeps the component's state and the DOM in step.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return undefined;

    const onCancel = (event: Event): void => {
      event.preventDefault();
      onClose();
    };

    dialog.addEventListener('cancel', onCancel);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
    };
  }, [onClose]);

  /*
   * The keyboard, on the dialog rather than on the window.
   *
   * On the window it would still be firing after the dialog closed, and a page
   * where `+` zooms an invisible image is a page with a haunted keyboard.
   * `<dialog>` holds focus inside itself while it is open, so a listener here
   * sees every key the viewer presses and none of the ones they press
   * afterwards.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDialogElement>): void => {
    // Never swallow the keys that operate the buttons themselves.
    if (event.key === 'Tab' || event.key === 'Enter' || event.key === ' ') return;

    const pan = (dx: number, dy: number): void => {
      setOffset((previous) => ({ x: previous.x + dx, y: previous.y + dy }));
    };

    switch (event.key) {
      case '+':
      case '=':
        event.preventDefault();
        zoomBy(SCALE_STEP);
        break;
      case '-':
      case '_':
        event.preventDefault();
        zoomBy(-SCALE_STEP);
        break;
      case '0':
        event.preventDefault();
        reset();
        break;
      case 'ArrowLeft':
        event.preventDefault();
        // Zoomed in, the arrows are how the picture is moved around; fitted,
        // there is nothing to move and they are how the gallery is stepped
        // through. One key, and which job it has is never ambiguous on screen.
        if (isZoomed) pan(PAN_STEP, 0);
        else step(-1);
        break;
      case 'ArrowRight':
        event.preventDefault();
        if (isZoomed) pan(-PAN_STEP, 0);
        else step(1);
        break;
      case 'ArrowUp':
        if (!isZoomed) return;
        event.preventDefault();
        pan(0, PAN_STEP);
        break;
      case 'ArrowDown':
        if (!isZoomed) return;
        event.preventDefault();
        pan(0, -PAN_STEP);
        break;
      default:
        break;
    }
  };

  if (image === null) return null;

  return (
    <dialog
      ref={dialogRef}
      aria-label={title}
      onKeyDown={onKeyDown}
      className={cx(
        // The whole window, and none of the dialog chrome the rest of the app
        // uses. A lightbox that is a card with a border is a lightbox with the
        // page showing around the thing it was opened to look at.
        'h-[100dvh] max-h-none w-screen max-w-none border-0 bg-transparent p-0',
        // See `Modal`: `flex` silently overrides the user-agent's
        // `dialog:not([open]) { display: none }`, and the result renders in the
        // page flow. `:not([open])` out-specifies `.flex`, so this wins until
        // `showModal()` adds the attribute.
        'flex flex-col [&:not([open])]:hidden',
        'text-ink',
        /*
         * A LIGHT, translucent grey — not the navy the card dialogs use.
         *
         * Most of this catalogue is product photography shot on white, and a
         * white subject on a near-black backdrop is a silhouette with a halo:
         * the eye reads the edge of the photograph rather than the thing in
         * it, and judging a finish or a shade against it is impossible. A pale
         * ground is what a product is actually looked at on.
         *
         * The token `surface-sunken` rather than a literal grey, so it is the
         * page's own quiet ground in both themes — light grey in the light one
         * and the dark equivalent in the dark one, which is the only way this
         * is right on both. Everything drawn on top of it is `ink` for the same
         * reason: white chrome on a pale backdrop is chrome nobody can read.
         *
         * The blur keeps the catalogue behind legible-as-shapes and
         * unreadable-as-text, so it reads as set aside rather than as clutter.
         */
        'backdrop:bg-surface-sunken/85 backdrop:backdrop-blur-md backdrop:animate-fade-in',
      )}
    >
      {/* The whole surface closes, which is what a lightbox backdrop does.

          A `<div>` with a click handler rather than a `<button>` wrapping the
          picture: a button containing an image and two other buttons is
          invalid, and the keyboard already has Escape for this. It is
          `aria-hidden` and not reachable, so it adds no tab stop and announces
          nothing — it is a convenience for a pointer, and every pointer
          convenience here has a keyboard equivalent that is announced. */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        onClick={onClose}
      />

      {/* --- The bar ------------------------------------------------------ */}
      <div className="relative z-10 flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface/80 px-3 py-2.5 backdrop-blur-sm sm:px-4">
        <p className="min-w-0 truncate text-sm font-medium">{title}</p>

        <div className="flex shrink-0 items-center gap-1">
          {/*
            The zoom level, announced.

            `aria-live="polite"` because a control whose only feedback is the
            size of a picture gives a screen-reader user no feedback at all.
            Rounded to whole percent — "150%" and not "150.00000000000003%",
            which is what repeated addition of 0.5 produces.
          */}
          <span
            aria-live="polite"
            className="mr-1 min-w-[3.5rem] text-center text-xs tabular text-ink-muted"
          >
            {t('lightbox.zoomLevel', { percent: Math.round(scale * 100) })}
          </span>

          <LightboxButton
            label={t('lightbox.zoomOut')}
            onClick={() => {
              zoomBy(-SCALE_STEP);
            }}
            disabled={scale <= MIN_SCALE}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="M8 11h6M20 20l-4.3-4.3" strokeLinecap="round" />
            </svg>
          </LightboxButton>

          <LightboxButton
            label={t('lightbox.zoomIn')}
            onClick={() => {
              zoomBy(SCALE_STEP);
            }}
            disabled={scale >= MAX_SCALE}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="M8 11h6M11 8v6M20 20l-4.3-4.3" strokeLinecap="round" />
            </svg>
          </LightboxButton>

          <LightboxButton label={t('lightbox.resetZoom')} onClick={reset} disabled={!isZoomed}>
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path
                d="M4 9V5h4M20 15v4h-4M20 9V5h-4M4 15v4h4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </LightboxButton>

          <LightboxButton label={t('lightbox.close')} onClick={onClose}>
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
            </svg>
          </LightboxButton>
        </div>
      </div>

      {/* --- The picture --------------------------------------------------- */}
      <div
        className="relative z-10 flex min-h-0 flex-1 items-center justify-center overflow-hidden"
        /*
         * The wheel zooms rather than scrolls.
         *
         * `onWheel` on this element and not on the window: inside a modal
         * dialog there is nothing else to scroll, and a wheel that scrolled
         * the catalogue behind the picture is the single most disorienting
         * thing a lightbox can do. React attaches wheel listeners passively,
         * so `preventDefault` here would be ignored with a console warning —
         * `overscroll-behavior: contain` on the dialog is what actually stops
         * the page behind moving, and it is in `index.css` beside the other
         * dialog rules.
         */
        onWheel={(event) => {
          zoomBy(event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP);
        }}
      >
        {/*
          `<img>` and not a background: an image is content, it has alt text,
          it is what a "save image as" lands on, and it is what a print
          stylesheet can reach.

          `draggable={false}` because the browser's own image drag starts the
          moment a pointer moves across it, which cancels the pan and leaves a
          ghost picture following the cursor out of the window.
        */}
        <img
          src={image.url}
          alt={image.altText ?? title}
          draggable={false}
          // Not lazy: the dialog is open because somebody asked for this file.
          decoding="async"
          onPointerDown={(event) => {
            if (!isZoomed) return;
            // Capture, so a pointer dragged off the picture — or off the
            // window — still reports its moves here rather than stopping the
            // drag wherever it happened to leave.
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (current === null || current.pointerId !== event.pointerId) return;

            const dx = event.clientX - current.x;
            const dy = event.clientY - current.y;
            drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };

            setOffset((previous) => ({ x: previous.x + dx, y: previous.y + dy }));
          }}
          onPointerUp={(event) => {
            if (drag.current?.pointerId === event.pointerId) drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onDoubleClick={() => {
            // The gesture everybody tries first. Straight to a useful
            // magnification rather than one step of it, and straight back.
            if (isZoomed) reset();
            else setScale(2.5);
          }}
          className={cx(
            'max-h-full max-w-full select-none object-contain',
            isZoomed ? 'cursor-grab active:cursor-grabbing' : 'cursor-zoom-in',
            // No transition while dragging — see the class in index.css. A
            // 150ms ease on `transform` turns a drag into a lag.
            'lightbox-image',
          )}
          style={{
            transform: `translate(${String(offset.x)}px, ${String(offset.y)}px) scale(${String(scale)})`,
          }}
        />

        {/* Previous and next, only where there is more than one. Over the
            picture rather than under it, because on a phone in landscape
            there is no "under it". */}
        {images.length > 1 && (
          <>
            <div className="absolute inset-y-0 left-2 flex items-center sm:left-4">
              <LightboxButton
                label={t('lightbox.previousImage')}
                onClick={() => {
                  step(-1);
                }}
              >
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m15 18-6-6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </LightboxButton>
            </div>

            <div className="absolute inset-y-0 right-2 flex items-center sm:right-4">
              <LightboxButton
                label={t('lightbox.nextImage')}
                onClick={() => {
                  step(1);
                }}
              >
                <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </LightboxButton>
            </div>
          </>
        )}
      </div>

      {/* --- The footer ---------------------------------------------------- */}
      <div className="relative z-10 shrink-0 border-t border-border bg-surface/80 px-3 py-2.5 text-center backdrop-blur-sm sm:px-4">
        {images.length > 1 && (
          <p className="text-xs tabular text-ink-muted">
            {t('lightbox.counter', { index: index + 1, total: images.length })}
          </p>
        )}
        {/* The gestures, said once rather than discovered. Hidden from a
            screen reader: every one of them names a pointer action, and the
            keyboard equivalents are already on the buttons above. */}
        <p aria-hidden="true" className="mt-0.5 text-xxs text-ink-subtle">
          {t('lightbox.hint')}
        </p>
      </div>
    </dialog>
  );
}

/**
 * One control in the bar.
 *
 * Icon-only, so the label is the accessible name and also the tooltip. Both,
 * not either: a `title` alone is not an accessible name in every combination
 * of browser and screen reader, and an `aria-label` alone leaves a sighted
 * mouse user guessing at a glyph.
 */
function LightboxButton({
  label,
  onClick,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex h-10 w-10 items-center justify-center rounded-lg text-ink-muted transition-colors
                 hover:bg-surface-hover hover:text-ink focus-visible:outline focus-visible:outline-2
                 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed
                 disabled:text-ink-subtle/40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
