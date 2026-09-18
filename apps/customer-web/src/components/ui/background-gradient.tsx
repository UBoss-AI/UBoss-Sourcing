/**
 * The glare.
 *
 * A four-cornered gradient that sits behind whatever is passed to it: one copy
 * blurred into a coloured halo that spills past the edges, and one sharp copy
 * showing through the few pixels of padding as a rim. The gradient drifts, so
 * the colours move slowly around the shape while a pointer is on it.
 *
 * It is on the product card, which is the one component in this storefront a
 * buyer spends real time hovering over.
 *
 * ---
 *
 * WHERE THIS CAME FROM, AND WHAT HAD TO CHANGE
 *
 * The shape of this is the Aceternity `background-gradient` component. Four
 * things about it could not survive contact with this repository, and each one
 * is a rule this project has already paid to learn — the same list
 * `ui/3d-globe.tsx` keeps, for the same reason.
 *
 *   - **`cn` is `cx`.** This project's class joiner is `lib/cx.ts`. There is no
 *     `clsx`/`tailwind-merge` pair here, and adding one to satisfy an import
 *     would be two dependencies for one function.
 *   - **No `motion`.** The original drives the drift with a `motion.div` and a
 *     five-second `backgroundPosition` keyframe. That is a React component
 *     animating a paint property on every frame, per card, forever — on a rail
 *     of a dozen product cards it runs a dozen of them at once, all of them
 *     off screen half the time. Here the drift is a CSS `@keyframes` that only
 *     runs while the card is actually hovered, so at most one is ever running.
 *     `index.css` has the whole story under "The glare".
 *   - **It only glows on hover.** The original glows at 60% at rest and 100%
 *     on hover, which is right for one showcase card on a landing page. Twelve
 *     of them in a grid, each permanently ringed in four colours, is not a
 *     catalogue anybody can scan. At rest the grid is quiet; the card under
 *     the pointer is the one that lights up.
 *   - **The colours are the original's.** #00ccb1, #7b61ff, #ffc414 and
 *     #1ca0fb over #141316, kept deliberately rather than mapped onto the
 *     UBOSS palette — this is the one piece of the storefront allowed to be
 *     louder than the brand, and half of it (the violet, the yellow) is hues
 *     the palette does not contain at all. They are literal in `index.css`
 *     and not tokens, so nothing else can pick them up by accident.
 *
 * Everything about how it looks lives in `.glare*` in `index.css`, next to
 * `.tilt`, because the two are halves of one hover.
 */
import { cx } from '@/lib/cx';

interface BackgroundGradientProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'children'> {
  children?: React.ReactNode;
  /** On the box that holds the children, above the gradient. */
  className?: string;
  /** On the outer box, which is what the gradient is drawn around. */
  containerClassName?: string;
  /**
   * Whether the colours drift. `false` leaves the glare in its resting
   * position and still fades it in on hover, which is what a caller wants when
   * several of these are on screen at once.
   */
  animate?: boolean;
  /**
   * The outer box, for a caller that needs to measure it or lean it — the
   * product card gives this to `useTilt`, so the halo leans with the card
   * instead of staying flat behind a card that is tipping away from it.
   */
  ref?: React.Ref<HTMLDivElement>;
}

export function BackgroundGradient({
  children,
  className,
  containerClassName,
  animate = true,
  ref,
  ...rest
}: BackgroundGradientProps): React.JSX.Element {
  return (
    <div ref={ref} className={cx('glare', containerClassName)} {...rest}>
      {/* Two copies of one gradient. The blurred one is the halo that spills
          past the edges; the sharp one is what shows through the padding as a
          rim. Decorative, and inert: a layer that ate the press meant for the
          card's stretched link would break the card. */}
      <span aria-hidden="true" className={cx('glare-layer glare-halo', !animate && 'glare-still')} />
      <span aria-hidden="true" className={cx('glare-layer glare-rim', !animate && 'glare-still')} />

      <div className={cx('glare-content', className)}>{children}</div>
    </div>
  );
}
