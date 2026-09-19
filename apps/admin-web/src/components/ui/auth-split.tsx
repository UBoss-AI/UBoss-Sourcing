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
  /** The height the frame should fill. Each app's chrome differs. */
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
    <div className={cx('grid w-full lg:min-h-[40rem] lg:grid-cols-2', className)}>
      {/*
        The picture, and it does NOT stretch with the form beside it.

        A grid item fills its row by default, which on the create-account page
        made the panel as tall as a nine-field form — around 1250px — and the
        globe fits itself to the canvas it is given, so it came out 860px
        across inside a 630px column and was cropped on both sides. Pinned to
        the top of the window at exactly the window's height instead, it is
        always a shape the earth fits in, and it stays in view while a long
        form scrolls past it rather than scrolling away at the first field.

        `self-start` is what makes `sticky` mean anything here: without it the
        item is stretched to the row, there is no free space to travel
        through, and `top-0` does nothing at all.

        A right border rather than a shadow: the two columns meet on a hairline
        in both themes, and a shadow cast from a panel that is sometimes absent
        is a shadow that sometimes appears from nowhere.
      */}
      <AuthGlobe className="hidden border-r border-border bg-surface-sunken lg:sticky lg:top-0 lg:block lg:h-[100dvh] lg:self-start" />

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
      */}
      <div className="flex min-w-0 items-center justify-center px-4 py-8 sm:px-6 lg:px-10 lg:py-12">
        <div className={cx('w-full', contentClassName)}>{children}</div>
      </div>
    </div>
  );
}
