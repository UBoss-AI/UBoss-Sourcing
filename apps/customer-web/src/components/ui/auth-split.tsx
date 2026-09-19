/**
 * The frame the signed-out screens share: a picture on the left, the form on
 * the right.
 *
 * **One file, three apps.** It sits beside `auth-form.tsx` under the same rule
 * that file states: the three copies are byte-identical, and a change to one
 * is a change to all three, or the sign-in screens start drifting apart while
 * claiming to be one product.
 *
 * ## The two columns are not equal, and neither is optional in the way the
 * other is
 *
 * The right column is the page. It holds the heading, the fields, the errors
 * and the way out to the other screens, and it is centred on its own half at
 * the same measure it had when it was the whole page — so the form somebody
 * signs in with is the form they signed in with yesterday, at the same width,
 * with the same tab order. Nothing about it depends on the left column
 * existing.
 *
 * The left column is `AuthGlobe`: an earth turning behind a brand wash, with a
 * pin standing on each sourcing hub. It is `aria-hidden`, carries no text and
 * no control, and is the first thing to go when there is not room for it.
 *
 * ## Why it disappears below `lg` rather than shrinking
 *
 * Under 1024px the two columns become one, and the picture is not drawn at
 * all. Three reasons, and any one of them would be enough:
 *
 *   - A phone's screen is scarce, and the half of it above the fold belongs to
 *     the email field, not to a decoration.
 *   - A phone is also the device least able to afford a WebGL scene, and the
 *     one most likely to be running on a battery somebody needs later.
 *   - At a third of the width the pins overlap into a smudge, so the thing the
 *     picture is *for* stops being legible before the picture does.
 *
 * `hidden` rather than `opacity-0` or a zero height: a hidden element is not
 * laid out, the lazy chunk behind it is never asked for, and no WebGL context
 * is ever created. A panel faded to nothing would still cost all three.
 *
 * ## Why the earth stays put, and why `sticky` alone could never do it
 *
 * The complaint was that the globe scrolled away with the page, and `sticky
 * top-0` was already on it. It was not a typo — `sticky` was doing exactly what
 * `sticky` does, and the arithmetic simply had nowhere to go.
 *
 * A sticky item can hold its position for as long as its CONTAINER has room
 * left underneath it, and no longer: the travel it gets is the container's
 * height minus its own. The globe was `h-[100dvh]` inside a grid whose height
 * was also, in the common case, one viewport — so the travel was zero, and the
 * first pixel of scroll moved it. What made the page scroll at all was the
 * chrome around the split: a header above, a footer below. The earth slid up by
 * exactly their height, which is precisely what somebody on the sign-in screen
 * reported seeing.
 *
 * So the fix is not a better `position`. It is to stop the frame scrolling:
 *
 *   - **The host gives this frame a definite height** — one viewport minus its
 *     own chrome — and stops the document scrolling. Each of the three apps
 *     does that for its signed-out routes, because each one's chrome differs
 *     and only the host knows its own.
 *   - **The right column scrolls inside itself** instead. A nine-field
 *     create-account form still scrolls; what it no longer does is take the
 *     picture with it.
 *   - **The globe simply fills the frame.** Nothing to travel, nothing to
 *     stick, nothing that can slide.
 *
 * And there is a fourth thing, which is invisible and was the last to be
 * found: **the form column has to be `relative`.** `overflow` only clips a
 * descendant whose containing block is inside the clipper, and every `.sr-only`
 * span on these forms is `position: absolute` with no positioned ancestor — so
 * each one was laid out against the document, sailed through every clip
 * between, and stretched the page to reach it. Nine invisible one-pixel spans
 * were putting the scrollbar back on a frame that measured exactly right. The
 * note beside that column has the detail.
 */
import type { ReactNode } from 'react';
import { AuthGlobe } from '@/components/ui/auth-globe';
import { cx } from '@/lib/cx';

export function AuthSplit({
  children,
  className,
  contentClassName = 'max-w-md',
}: {
  children: ReactNode;
  /**
   * The height the frame should fill. Each app's chrome differs.
   *
   * Pass a DEFINITE height at `lg` — `lg:h-[100dvh]`, or that minus whatever
   * sits above the frame — and the earth stops moving, because the frame stops
   * scrolling and the form column takes the scrolling on instead. Pass
   * `lg:overflow-hidden` with it: the split caps itself at one viewport, so
   * nothing reachable is ever clipped, and a single stray pixel of overflow
   * anywhere in the subtree is otherwise enough to put the document's
   * scrollbar back.
   *
   * Pass nothing and the frame is content-height, capped at a viewport. That
   * still works; the picture simply moves with a page that scrolls.
   */
  className?: string;
  /**
   * The measure of the right column, and it **replaces** the default rather
   * than adding to it.
   *
   * Appending would not work: there is no `tailwind-merge` in these apps, so
   * `max-w-md max-w-2xl` is decided by the order the two rules happen to sit
   * in the generated stylesheet rather than by the order they are written
   * here. A caller that needs a different width says so and gets exactly that
   * — the logistics portal's second-factor wizard, which has to fit a QR code
   * and ten recovery codes, is the one that needs it.
   */
  contentClassName?: string;
}): React.JSX.Element {
  return (
    /*
     * THE FRAME IS WHAT IS BOUNDED, not the picture inside it. That swap is
     * the whole fix, and it took two goes to get right.
     *
     * The first attempt bounded the picture: `h-[100dvh]` with `max-h-full` to
     * cap it inside a host that had given the frame a height. It does not
     * work. A percentage `max-height` on a grid item resolves against the grid
     * AREA, and a browser is entitled to treat that as indefinite — Chrome
     * does — so the cap is dropped and a 100dvh panel sits inside a frame that
     * is one viewport minus a header. It overflows by exactly the header's
     * height, the document scrolls by that much, and the earth moves by that
     * much. Which was the original complaint, smaller.
     *
     * So the two lengths swap places:
     *
     *   - `lg:h-full` takes the height the host gave this frame — one window
     *     minus that app's chrome — and hands it to both columns.
     *   - `lg:max-h-[100dvh]` is a LENGTH, not a percentage, so it always
     *     applies. In a host that has given no definite height, `h-full`
     *     computes to `auto` and this is what stops a nine-field
     *     create-account form making the panel 1,250px tall — which is the
     *     crop the old `h-[100dvh]` was there to prevent, still prevented.
     *
     * Both columns then simply fill the row. No `self-start`, because there is
     * no longer a tall row to avoid being stretched to; no `sticky`, because a
     * frame that does not scroll has nothing to stick to, and leaving it there
     * would only suggest the mechanism is something it is not.
     *
     * There is no `min-h` either. There used to be a `lg:min-h-[40rem]` floor
     * from when the panel had no height of its own, and on a wide but SHORT
     * window — 1280x600, a projector, a split screen — that floor overrode
     * `h-full`, pushed the split past the frame and put the scrollbar back.
     */
    <div className={cx('grid w-full lg:h-full lg:max-h-[100dvh] lg:grid-cols-2', className)}>
      {/*
        The picture, filling its half of the frame.

        A right border rather than a shadow: the two columns meet on a hairline
        in both themes, and a shadow cast from a panel that is sometimes absent
        is a shadow that sometimes appears from nowhere.
      */}
      <AuthGlobe className="hidden border-r border-border bg-surface-sunken lg:block lg:h-full" />

      {/*
        The form, centred on its own half and held at the measure it has always
        had.

        **No background of its own**, deliberately. Each of the three apps
        already decides what a signed-out page is painted on — the storefront's
        body, the admin panel's sunken grey, the logistics portal's wash — and
        this frame was added to those screens to put a picture beside the form,
        not to restyle the form. Naming a colour here would quietly change all
        three.

        `min-w-0` is the load-bearing half: without it a grid column refuses to
        shrink below its content, and one long unbroken error message would
        push the whole split wider than the window.

        `lg:h-full lg:overflow-y-auto` is what takes the scrolling off the
        document and puts it here, so a long form still reaches its last field
        with the earth beside it holding still. Both are percentage-derived and
        therefore inert in a frame with no definite height — which is exactly
        what makes this safe to change in one file for three apps.

        `lg:items-start` rather than centred once the column scrolls: a form
        taller than the window that is also vertically centred has its heading
        cut off above the scroll origin, and no amount of scrolling up reaches
        it. Short forms are still centred, because `justify-center` on the
        inner wrapper's own margin does that job — see `my-auto`.

        `relative` IS THE ONE THAT TOOK LONGEST TO FIND, and without it none of
        the rest works.

        `overflow` only clips a descendant whose CONTAINING BLOCK is inside the
        clipper. An absolutely positioned element with no positioned ancestor
        is laid out against the initial containing block — the document — so it
        sails straight through every `overflow: hidden` and `overflow: auto`
        between it and the page, and extends the document's scroll height from
        wherever it happens to sit.

        This form is full of them. `.sr-only` is the standard clip pattern, and
        it is `position: absolute`: every "(required)" a `Field` renders for a
        screen reader is one. On the create-account form the last of them sat
        988px down a 529px window, the document grew to match, and the page
        scrolled 427px — taking the earth with it — while every box on screen
        measured exactly right. Nine `<span>`s of one pixel each, invisible,
        unreadable in a screenshot, and the entire remaining cause.

        One word makes this column their containing block, and the
        `overflow-y: auto` above finally means what it says.
      */}
      <div className="relative flex min-w-0 items-center justify-center px-4 py-8 sm:px-6 lg:h-full lg:items-start lg:overflow-y-auto lg:px-10 lg:py-12">
        {/* `lg:my-auto` is what keeps a short sign-in form centred on its half
            now that the column is `items-start`. Auto margins on a flex item
            absorb the free space when there is any, and collapse to nothing
            when the form is taller than the column — the one behaviour that is
            right for both, and the one `items-center` gets wrong for the
            second. */}
        <div className={cx('w-full lg:my-auto', contentClassName)}>{children}</div>
      </div>
    </div>
  );
}
