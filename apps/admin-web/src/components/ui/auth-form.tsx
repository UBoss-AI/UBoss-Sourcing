/**
 * The sign-in / sign-up skin.
 *
 * Three pieces, used only by the signed-out screens:
 *
 *   - `AuthCard`      the panel the form sits on — square-cornered and edge to
 *                     edge on a phone, a rounded card from `md` up.
 *   - `GlowInput`     a text field that lights a blue halo around itself under
 *                     the pointer, brightest where the cursor actually is.
 *   - `GradientCta`   the submit button: a gradient fill, two inset hairlines
 *                     that give it a lit top edge and a shadowed bottom one,
 *                     and a pair of coloured lines that fade in along its foot
 *                     on hover.
 *
 * `AuthDivider` is the hairline that fades out at both ends, between the form
 * and whatever follows it.
 *
 * **One file, three apps.** `components/ui.tsx` is duplicated across the
 * storefront, the admin panel and the logistics portal on purpose — one brand
 * system, three densities — and this sits beside it under the same rule. The
 * three copies are byte-identical; a change to one is a change to all three,
 * or the sign-in screens start drifting apart while claiming to be one
 * product.
 *
 * ---
 *
 * WHERE THIS CAME FROM, AND WHAT HAD TO CHANGE
 *
 * The shape of this is Aceternity's `signup-form-demo`, and the same rules
 * that `apps/customer-web/src/components/ui/background-gradient.tsx` and
 * `3d-globe.tsx` keep apply here. Four more are specific to a *form*, and each
 * one is a thing this repository has already decided:
 *
 *   - **`cn` is `cx`.** `lib/cx.ts` is this project's class joiner. There is
 *     no `clsx`/`tailwind-merge` pair here and adding one for one function is
 *     two dependencies too many.
 *   - **No `dark:` variants.** Nothing in these apps carries them. A colour is
 *     a token — `bg-surface`, `text-ink` — and `index.css` gives every token a
 *     second value under the dark palette. The original's `bg-white
 *     dark:bg-black` pair is `bg-surface`, and it then follows the theme
 *     toggle as well as the operating system, which a `dark:` class does not.
 *   - **The field keeps its border.** The original's input is borderless and
 *     leans on `bg-gray-50` against a white card to show its edge — about
 *     1.05:1, where WCAG 1.4.11 asks 3:1 for the boundary of a control. So the
 *     project's own `Input` is used unchanged underneath, with its audited
 *     border and focus ring, and the halo is added *around* it. The look
 *     survives; the edge stays perceivable with the pointer nowhere near it.
 *   - **No social buttons.** The original's three are decoration — none of
 *     these three surfaces has federated sign-in, and a GitHub button that
 *     does nothing is worse than no button.
 *   - **The gradient is brand blue, not black.** `from-brand-fill` is the hue
 *     the contrast audit measures white labels against. A hard-coded black
 *     would read as a second primary colour, and would be invisible against
 *     the dark palette's own near-black page.
 *   - **The halo stops for reduced motion.** It tracks a pointer on every
 *     mousemove; somebody who has asked for less movement gets the static
 *     ring instead, and loses nothing, because the halo says only "the pointer
 *     is here".
 */
import { forwardRef, useState } from 'react';
import type { InputHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { motion, useMotionTemplate, useMotionValue, useReducedMotion } from 'motion/react';
import { Input } from '@/components/ui';
import { cx } from '@/lib/cx';

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/**
 * Square on a phone, rounded from `md` up — the original's own call, and the
 * right one: a card with rounded corners and a 16px margin either side wastes
 * the two scarcest columns on the narrowest screen, so below `md` the panel is
 * simply the page.
 */
export function AuthCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cx(
        'w-full rounded-none border border-border bg-surface p-4 shadow-lift md:rounded-2xl md:p-8',
        className,
      )}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The field
// ---------------------------------------------------------------------------

/** Where the halo fades out, in pixels from the cursor. */
const HALO_RADIUS = 100;

/**
 * A text field with a halo that follows the pointer.
 *
 * The wrapper is 2px of padding behind the input, painted with a radial
 * gradient centred on the cursor. Nothing moves and nothing is animated per
 * frame by React: the two motion values are written on `mousemove` and read
 * straight into a `background` string, so the work is one style write, off the
 * React render path entirely.
 *
 * Everything else about the control — height, focus ring, invalid state,
 * disabled state — is the shared `Input`, so a field on this page and a field
 * anywhere else in the app still behave identically.
 */
export const GlowInput = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function GlowInput({ className, ...rest }, ref) {
  const reducedMotion = useReducedMotion();

  const mouseX = useMotionValue(0);
  const mouseY = useMotionValue(0);
  const [visible, setVisible] = useState(false);

  // `rgb(var(--brand))` rather than a literal blue: the halo is the same hue
  // as the focus ring in both themes, and it moves when the palette does.
  const background = useMotionTemplate`radial-gradient(${
    visible ? `${String(HALO_RADIUS)}px` : '0px'
  } circle at ${mouseX}px ${mouseY}px, rgb(var(--brand)), transparent 80%)`;

  const handleMouseMove = (event: MouseEvent<HTMLDivElement>): void => {
    const { left, top } = event.currentTarget.getBoundingClientRect();
    mouseX.set(event.clientX - left);
    mouseY.set(event.clientY - top);
  };

  // No halo, no listeners at all — not a hidden one that still runs.
  if (reducedMotion === true) {
    return <Input ref={ref} className={className} {...rest} />;
  }

  return (
    <motion.div
      style={{ background }}
      onMouseMove={handleMouseMove}
      onMouseEnter={() => {
        setVisible(true);
      }}
      onMouseLeave={() => {
        setVisible(false);
      }}
      className="rounded-lg p-[2px] transition duration-300"
    >
      <Input ref={ref} className={className} {...rest} />
    </motion.div>
  );
});

// ---------------------------------------------------------------------------
// The submit button
// ---------------------------------------------------------------------------

/**
 * The two lines that fade in along the foot of a button on hover: a sharp cyan
 * one and a blurred indigo one half its width, which together read as light
 * spilling out from under the control.
 *
 * `group-hover/btn` rather than `group-hover`, because these sit inside a
 * button that is itself inside the form's other groups.
 */
export function BottomGradient(): React.JSX.Element {
  return (
    <>
      <span className="absolute inset-x-0 -bottom-px block h-px w-full bg-gradient-to-r from-transparent via-cyan-500 to-transparent opacity-0 transition duration-500 group-hover/btn:opacity-100" />
      <span className="absolute inset-x-10 -bottom-px mx-auto block h-px w-1/2 bg-gradient-to-r from-transparent via-indigo-500 to-transparent opacity-0 blur-sm transition duration-500 group-hover/btn:opacity-100" />
    </>
  );
}

/**
 * The classes that turn a `primary` Button into the gradient CTA.
 *
 * Applied as a `className` on the shared `Button` rather than as a new variant:
 * this treatment belongs to the signed-out screens, and a variant in `ui.tsx`
 * is a promise that it belongs to the whole app.
 *
 * The two inset hairlines are the whole trick — one white line along the top
 * edge and one along the bottom, at 25% opacity, which is what makes a flat
 * fill read as a physical key rather than a coloured rectangle.
 */
export const GRADIENT_CTA =
  'group/btn relative bg-gradient-to-br from-brand-fill to-brand-fill-hover ' +
  'shadow-[0px_1px_0px_0px_rgb(255_255_255/0.25)_inset,0px_-1px_0px_0px_rgb(0_0_0/0.15)_inset] ' +
  'hover:from-brand-fill-hover hover:to-brand-fill-hover';

// ---------------------------------------------------------------------------
// The divider
// ---------------------------------------------------------------------------

/** A hairline that fades out at both ends rather than stopping dead. */
export function AuthDivider({ className }: { className?: string }): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cx(
        'h-px w-full bg-gradient-to-r from-transparent via-border-strong to-transparent',
        className,
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// The consent tick
// ---------------------------------------------------------------------------

/**
 * "I accept the terms", with the operator's own policy links beside it.
 *
 * Here rather than in each app because all three signed-out screens ask for
 * the same consent and it has to read identically on every one of them. Two
 * copies of this markup is how one surface ends up linking to a privacy policy
 * another does not — which was the state before this existed: the storefront
 * had its own component, the admin panel had the same markup inlined with
 * `text-accent` instead of `text-brand`, and the logistics portal had no tick
 * at all.
 *
 * It takes the policies as DATA rather than reading them, which is what keeps
 * this file byte-identical in three apps that get them from three different
 * places: the storefront from `useStorefront()`, the admin panel from its own
 * `/config` query, and the logistics portal from its own. A deployment that
 * has set none renders the sentence alone rather than a link to a page that
 * does not exist.
 *
 * The box is never ticked for the reader. A pre-ticked consent is not consent,
 * and every call site's `defaultValues` says `false`.
 */
export interface AuthTermsCheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  /** The sentence beside the box, already translated. */
  label: string;
  /** `[text, href]` pairs, in the order the operator set them. */
  policies?: readonly (readonly [string, string])[];
  /** The validation message, when the form has one to show. */
  error?: string | undefined;
  /**
   * Only needed where two of these could share a page. The id ties the message
   * to the box for a screen reader, so it has to be unique in the document.
   */
  errorId?: string | undefined;
}

export const AuthTermsCheckbox = forwardRef<HTMLInputElement, AuthTermsCheckboxProps>(
  function AuthTermsCheckbox(
    { label, policies = [], error, errorId = 'accept-terms-error', ...rest },
    ref,
  ) {
    return (
      <div>
        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink">
          <input
            ref={ref}
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand"
            aria-describedby={error === undefined ? undefined : errorId}
            {...rest}
          />
          <span>
            {label}
            {policies.length > 0 && (
              <>
                {' ('}
                {policies.map(([text, href], index) => (
                  <span key={text}>
                    {index > 0 && ', '}
                    {/* A new tab, deliberately: somebody reading the terms
                        halfway through a form should not lose what they have
                        typed to do it. */}
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-brand hover:underline"
                    >
                      {text}
                    </a>
                  </span>
                ))}
                {')'}
              </>
            )}
          </span>
        </label>

        {error !== undefined && (
          <p id={errorId} role="alert" className="mt-1.5 text-xs font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    );
  },
);
