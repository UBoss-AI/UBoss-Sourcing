/**
 * Shared UI primitives — storefront.
 *
 * The same set as apps/admin-web/src/components/ui.tsx, and deliberately so:
 * one brand system, two densities. Where the two files differ it is because
 * the storefront is the more spacious app — a larger heading step, roomier
 * card padding, a touch-sized `lg` button — never because the colour, the
 * focus behaviour or the state model diverged. Anything in this file that is
 * not about density should be changed in both.
 *
 * Accessibility rules that hold throughout this storefront:
 *   - A control that navigates is a link; a control that acts is a button.
 *     Never a `<div onClick>` — no keyboard and no screen reader can use one.
 *   - Every input has a real `<label for>`. A placeholder is not a label; it
 *     disappears the moment someone types, taking the question with it.
 *   - Errors are tied to their field with `aria-describedby` and announced
 *     with `role="alert"`, so the problem is not only a colour change.
 *   - Colour is never the only signal. Every badge carries its own text.
 */
import { forwardRef, useId } from 'react';
import { Link } from 'react-router-dom';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import type { LinkProps } from 'react-router-dom';
import { cx } from '@/lib/cx';

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant =
  | 'action'
  | 'primary'
  | 'operational'
  | 'secondary'
  | 'ghost'
  | 'danger'
  | 'inverse'
  | 'inverse-outline';
type ButtonSize = 'sm' | 'md' | 'lg';

/*
 * The hierarchy, loudest first:
 *
 *   action       The buy path. Orange. One per screen, at most.
 *   primary      The main action of a panel or form. Blue.
 *   operational  A commitment to a schedule. Teal.
 *   danger       Destructive. Red, and always paired with a quiet Cancel.
 *   secondary    The default. Bordered, on the page ground.
 *   ghost        Tertiary. No border until hovered.
 *
 * Every filled variant now names its own `focus-visible:ring-*`. The global
 * ring is brand blue, which on a red Delete button read as a blue halo around
 * a red control — the ring should belong to the thing it is on.
 *
 * Hovers go *darker*, never `brightness-110`. Lightening a filled button
 * walks its white label toward failing AA at the exact moment the pointer is
 * on it, which is the worst possible moment for it to become hard to read.
 */
const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // `action` is the buy path — deliberately a different hue from `primary`, so
  // Add to Cart never reads as just another link.
  //
  // The fill is `action-strong` (#C2410C) rather than `action` (#EA580C):
  // white on #EA580C is 3.56:1 and fails AA for a label, white on #C2410C is
  // 5.14:1 and passes. #EA580C stays the accent — see the token comment in
  // index.css.
  action:
    'bg-action-strong text-white shadow-card hover:bg-action-strong-hover ' +
    'focus-visible:ring-action-strong disabled:bg-ink-subtle disabled:shadow-none',
  primary:
    'bg-brand text-white shadow-card hover:bg-brand-hover ' +
    'focus-visible:ring-brand disabled:bg-ink-subtle disabled:shadow-none',
  // Repeat purchases. Teal, so committing to a schedule is visibly neither a
  // navigation action nor a one-off purchase.
  operational:
    'bg-operational text-white shadow-card hover:bg-operational-hover ' +
    'focus-visible:ring-operational disabled:bg-ink-subtle disabled:shadow-none',
  secondary:
    'bg-surface text-ink border border-border-strong shadow-card ' +
    'hover:border-border-hover hover:bg-surface-hover ' +
    'disabled:border-border disabled:bg-surface disabled:text-ink-subtle disabled:shadow-none',
  ghost:
    'text-ink-muted hover:bg-surface-hover hover:text-ink ' +
    'disabled:bg-transparent disabled:text-ink-subtle',
  danger:
    'bg-danger text-white shadow-card hover:bg-danger-hover ' +
    'focus-visible:ring-danger disabled:bg-ink-subtle disabled:shadow-none',
  // For the navy hero and header, where `primary` blue on navy is 1.57:1 and
  // simply vanishes. White carries navy text at 14.6:1.
  inverse:
    'bg-surface text-surface-inverse shadow-card hover:bg-ink-inverse ' +
    'disabled:text-ink-subtle disabled:shadow-none',
  // The paired quiet option on a dark surface. `white/40`, not the `white/25`
  // this replaced: a control boundary needs 3:1 to be perceivable at all
  // (WCAG 1.4.11), and /25 sat at 2.6:1 against the navy.
  'inverse-outline':
    'border border-white/40 text-ink-inverse hover:border-white/60 hover:bg-white/10',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 gap-1.5 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  // Large enough to be a comfortable touch target on a phone.
  lg: 'h-12 px-6 text-base',
};

/*
 * `active:translate-y-px` is the whole of the press feedback: one pixel, so a
 * tap registers as having landed on something. The reduced-motion block in
 * index.css strips the transition, and the displacement is then instant rather
 * than absent — which is the correct behaviour, since it is feedback and not
 * decoration.
 */
const BUTTON_BASE =
  'inline-flex select-none items-center justify-center gap-2 rounded-md font-medium ' +
  'transition-[background-color,border-color,color,box-shadow,transform] ' +
  'active:translate-y-px disabled:active:translate-y-0';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', isLoading = false, fullWidth, disabled, children, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      disabled={disabled === true || isLoading}
      // aria-busy, not just a spinner: a screen reader is told the control is
      // working rather than watching an animation it cannot see.
      aria-busy={isLoading}
      className={cx(
        BUTTON_BASE,
        'disabled:cursor-not-allowed',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        fullWidth === true && 'w-full',
        className,
      )}
      {...rest}
    >
      {isLoading && <Spinner className="h-4 w-4" />}
      {children}
    </button>
  );
});

/**
 * A link that looks like a button.
 *
 * "Browse the catalogue", "Go to checkout" and "Start a repeat purchase" all
 * *navigate*, so they stay anchors: middle-click, Ctrl+click and "copy link
 * address" keep working, and a screen reader announces them as links rather
 * than buttons. Before this each one was a hand-written `inline-flex h-12 …`
 * anchor, which is how a CTA fill colour ends up corrected in six places and
 * missed in the seventh.
 */
export interface ButtonLinkProps extends Omit<LinkProps, 'className'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
}

export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  fullWidth,
  className,
  ...rest
}: ButtonLinkProps): React.JSX.Element {
  return (
    <Link
      className={cx(
        BUTTON_BASE,
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        fullWidth === true && 'w-full',
        className,
      )}
      {...rest}
    />
  );
}

export function Spinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      className={cx('animate-spin', className ?? 'h-4 w-4')}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

interface FieldProps {
  label: string;
  hint?: string;
  error?: string | undefined;
  required?: boolean;
  children: (ids: { inputId: string; describedBy: string | undefined }) => ReactNode;
}

export function Field({ label, hint, error, required, children }: FieldProps): React.JSX.Element {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;

  const describedBy = [hint !== undefined ? hintId : null, error !== undefined ? errorId : null]
    .filter((id): id is string => id !== null)
    .join(' ');

  return (
    <div className="space-y-1.5">
      <label htmlFor={inputId} className="block text-sm font-medium text-ink">
        {label}
        {required === true && (
          <span className="ml-1 text-danger" aria-hidden="true">
            *
          </span>
        )}
        {/* The asterisk is decoration; this is what a screen reader hears. */}
        {required === true && <span className="sr-only"> (required)</span>}
      </label>

      {children({ inputId, describedBy: describedBy.length > 0 ? describedBy : undefined })}

      {hint !== undefined && (
        <p id={hintId} className="text-xs leading-relaxed text-ink-muted">
          {hint}
        </p>
      )}

      {error !== undefined && (
        <p id={errorId} role="alert" className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/*
 * The shared skin for every text control.
 *
 * Four states, all of them visible:
 *   idle      A 3:1 border, so the control's edge is perceivable (WCAG 1.4.11).
 *   hover     One step darker. Felt, not announced.
 *   focus     The global ring from index.css.
 *   disabled  Sunken ground, no shadow, not-allowed cursor, and the hover
 *             suppressed — a disabled field that still reacts to the pointer
 *             reads as broken rather than as unavailable.
 */
const CONTROL_BASE =
  'block w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-ink shadow-card ' +
  'transition-[background-color,border-color,box-shadow] ' +
  'placeholder:text-ink-subtle hover:border-border-hover ' +
  'disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-sunken ' +
  'disabled:text-ink-muted disabled:shadow-none disabled:hover:border-border';

/*
 * Invalid is a border *and* a matching focus ring. Leaving the ring brand-blue
 * meant the moment you focused the field you were trying to fix, the only
 * remaining signal that it was wrong was the message underneath.
 */
const CONTROL_INVALID = 'border-danger hover:border-danger focus-visible:ring-danger';

/**
 * 40px — the same height as a `md` Button.
 *
 * A filter row is an input, a select and a button side by side. Three
 * slightly different heights there is the most common way a tidy layout comes
 * out looking accidental, and it stays invisible until you line them up.
 */
const CONTROL_HEIGHT = 'h-10 py-0';

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function Input({ className, invalid, ...rest }, ref) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid === true ? true : undefined}
      className={cx(CONTROL_BASE, CONTROL_HEIGHT, invalid === true && CONTROL_INVALID, className)}
      {...rest}
    />
  );
});

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function Textarea({ className, invalid, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid === true ? true : undefined}
      className={cx(
        CONTROL_BASE,
        'min-h-24 py-2 leading-relaxed',
        invalid === true && CONTROL_INVALID,
        className,
      )}
      {...rest}
    />
  );
});

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }
>(function Select({ className, invalid, children, ...rest }, ref) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid === true ? true : undefined}
      // `select-chevron` (index.css) replaces the platform arrow with our own.
      // Left native, a select is a different width, weight and colour on every
      // OS, which is what makes one filter row look hand-assembled next to the
      // input beside it.
      className={cx(
        CONTROL_BASE,
        CONTROL_HEIGHT,
        'select-chevron pr-9',
        invalid === true && CONTROL_INVALID,
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});

/**
 * A form-level error summary.
 *
 * Focused when it appears, so a keyboard or screen-reader user is taken to the
 * problem rather than left at the submit button wondering why nothing
 * happened. Each entry links to its field.
 */
export function ErrorSummary({
  title = 'There is a problem',
  errors,
}: {
  title?: string;
  errors: { field?: string; message: string }[];
}): React.JSX.Element | null {
  if (errors.length === 0) return null;

  return (
    <div
      role="alert"
      tabIndex={-1}
      ref={(node) => {
        node?.focus();
      }}
      className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 outline-none"
    >
      <h2 className="text-title-xs text-danger">{title}</h2>
      <ul className="mt-1.5 list-inside list-disc space-y-1 text-sm text-ink">
        {errors.map((error, index) => (
          <li key={`${error.field ?? ''}:${String(index)}`}>{error.message}</li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/**
 * A grouped panel.
 *
 * Three deliberate choices keep a page of these from reading as a stack of
 * boxes, which is the failure mode of every card in every admin-shaped UI:
 *
 *   - The internal header rule is `border-subtle`, one step lighter than the
 *     card's own edge. When the two match, the header looks like a separate
 *     box sitting on top of another box.
 *   - `rounded-lg` and a 1px shadow, not a heavy one. The card should rest on
 *     the page, not hover above it; grouping is the job, not elevation.
 *   - Generous padding (`px-6 py-5`). The storefront is the spacious half of
 *     the pair — the admin panel's Card is the same component at `px-5 py-4`.
 */
export function Card({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <section className={cx('rounded-lg border border-border bg-surface shadow-card', className)}>
      {(title !== undefined || actions !== undefined) && (
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border-subtle px-6 py-5">
          <div className="min-w-0">
            {title !== undefined && <h2 className="text-title-sm text-ink">{title}</h2>}
            {description !== undefined && (
              <p className="mt-1 max-w-prose text-sm text-ink-muted">{description}</p>
            )}
          </div>
          {actions !== undefined && <div className="flex shrink-0 gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/*
 * Badge tones.
 *
 * A soft ground, its own hue in the text, and a tinted hairline. `ring-inset`
 * rather than `border`, so the badge is the same size in every tone and a row
 * of them sits on one baseline.
 *
 * The ring went from /20 to /25 and the text from `medium` to `semibold`:
 * these are 11px, and 11px at medium weight in a mid-tone hue was the one
 * piece of type in the app that people were squinting at.
 */
const BADGE_TONES = {
  neutral: 'bg-surface-sunken text-ink-muted ring-border',
  brand: 'bg-brand-soft text-brand ring-brand/25',
  // The buy path. Rare on a badge — a price cut, a conversion cue.
  action: 'bg-action-soft text-action-strong ring-action/25',
  // Repeat purchases and positive process cues. Its own hue, so "Repeat
  // purchase" stops looking like a link and starts looking like a capability.
  operational: 'bg-operational-soft text-operational ring-operational/25',
  success: 'bg-success-soft text-success ring-success/25',
  warning: 'bg-warning-soft text-warning ring-warning/25',
  danger: 'bg-danger-soft text-danger ring-danger/25',
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 ' +
          'text-xxs font-semibold ring-1 ring-inset',
        BADGE_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// States
//
// All three share one silhouette — centred, same vertical rhythm, same width
// limit on the explanatory line — so a panel that is empty, loading or broken
// occupies the same shape and the page does not jump between them.
// ---------------------------------------------------------------------------

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <p className="text-title-sm text-ink">{title}</p>
      {description !== undefined && (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-ink-muted">{description}</p>
      )}
      {action !== undefined && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = 'Loading' }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2.5 px-6 py-16 text-sm text-ink-muted">
      <Spinner className="h-4 w-4" />
      {/* Polite, so a screen reader says it once rather than interrupting. */}
      <span role="status">{label}…</span>
    </div>
  );
}

/**
 * A failed panel.
 *
 * Shows the server's own message rather than "Something went wrong" — the
 * backend writes messages a customer can act on, and replacing them with a
 * generic apology throws that away.
 */
export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}): React.JSX.Element {
  const message =
    error instanceof Error && error.message.length > 0 ? error.message : 'The request failed.';

  const correlationId =
    typeof error === 'object' && error !== null && 'correlationId' in error
      ? (error as { correlationId: string | null }).correlationId
      : null;

  return (
    <div role="alert" className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <p className="max-w-sm text-sm font-medium leading-relaxed text-danger">{message}</p>
      {correlationId !== null && (
        // A chip, not a line of grey text: this is the one string a customer
        // will be asked to read back, so it needs to look selectable.
        <p className="mt-2.5 rounded bg-surface-sunken px-2 py-1 font-mono text-xxs text-ink-subtle">
          Quote this if you contact support: {correlationId}
        </p>
      )}
      {onRetry !== undefined && (
        <Button className="mt-6" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

/**
 * The top of a page.
 *
 * `items-start` rather than `items-end`: when the description wraps to two
 * lines, bottom-aligning pushed the action buttons down past the title they
 * belong to. Starting them together keeps the button on the title's line at
 * every width, and the column stack below `sm` keeps a long title from
 * squeezing the actions into a two-line wrap.
 *
 * The description is capped at `max-w-2xl`. Explanatory prose running the full
 * width of a 1600px monitor is not a paragraph, it is a line.
 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}): React.JSX.Element {
  return (
    <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-title-xl text-ink">{title}</h1>
        {description !== undefined && (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">{description}</p>
        )}
      </div>
      {actions !== undefined && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
