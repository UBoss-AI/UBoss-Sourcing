/**
 * Shared UI primitives — admin panel.
 *
 * The same set as apps/customer-web/src/components/ui.tsx, and deliberately
 * so: one brand system, two densities. Where the two files differ it is
 * because the panel is the denser app — a smaller heading step, tighter card
 * padding, a 32px row action — never because the colour, the focus behaviour
 * or the state model diverged. Anything in this file that is not about density
 * should be changed in both.
 *
 * Deliberately small and unstyled-by-default rather than a component library:
 * every screen in this panel is a table, a form or a detail page, and the
 * variation between them is data, not chrome.
 *
 * Accessibility rules that hold throughout:
 *   - A control that is a link navigates; a control that is a button acts.
 *     Never a `<div onClick>`, which no keyboard and no screen reader can use.
 *   - Every input has a real `<label for>`, not a placeholder standing in for
 *     one. A placeholder disappears the moment someone types.
 *   - An error is tied to its field with `aria-describedby` and announced with
 *     `role="alert"`, so it is not only a colour change.
 */
import { forwardRef, useId } from 'react';
import { Link } from 'react-router-dom';
import { cx } from '@/lib/cx';
import { BUTTON_BASE, BUTTON_SIZES, BUTTON_VARIANTS, buttonClassName } from './button-styles';
import type { ButtonSize, ButtonVariant } from './button-styles';
import type { LinkProps } from 'react-router-dom';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { useI18n } from '@/i18n/i18n-context';

// ---------------------------------------------------------------------------
// Button
//
// The variant and size tables live in ./button-styles so `LinkButton` below
// can wear exactly the same skin. See that file for the hierarchy.
// ---------------------------------------------------------------------------

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', isLoading = false, disabled, children, className, ...rest },
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
        className,
      )}
      {...rest}
    >
      {isLoading && <Spinner className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
});

/**
 * A link that looks like a button.
 *
 * "Back to orders", "New product", "Bulk import" are navigations, so they must
 * be `<a href>` — middle-clickable, openable in a new tab, announced as links.
 * They also sit in a row of buttons and have to match one. Six pages used to
 * hand-roll `inline-flex h-9 items-center rounded-md …` for this, which put a
 * 36px control next to a 40px button on every page header in the panel.
 */
export function LinkButton({
  variant = 'secondary',
  size = 'md',
  className,
  children,
  ...rest
}: LinkProps & { variant?: ButtonVariant; size?: ButtonSize }): React.JSX.Element {
  return (
    <Link className={buttonClassName(variant, size, className)} {...rest}>
      {children}
    </Link>
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

interface FieldShellProps {
  label: string;
  hint?: string;
  error?: string | undefined;
  required?: boolean;
  children: (ids: { inputId: string; describedBy: string | undefined }) => ReactNode;
}

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: FieldShellProps): React.JSX.Element {
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

/**
 * A group of related fields, with its own heading.
 *
 * Progressive disclosure for long forms: the product editor and the coupon
 * dialog are twenty-odd inputs, and twenty inputs in one column is a wall.
 * A named group with a one-line explanation turns it into four decisions.
 */
export function FieldGroup({
  legend,
  hint,
  children,
  className,
}: {
  legend: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <fieldset className={cx('min-w-0', className)}>
      <legend className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
        {legend}
      </legend>
      {hint !== undefined && (
        <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">{hint}</p>
      )}
      <div className="mt-3">{children}</div>
    </fieldset>
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
 * Invalid is a border *and* a matching focus ring. Leaving the ring accent-blue
 * meant that the moment you focused the field you were trying to fix, the only
 * remaining signal that it was wrong was the message underneath.
 */
const CONTROL_INVALID = 'border-danger hover:border-danger focus-visible:ring-danger';

/**
 * 40px - the same as a `md` Button.
 *
 * A filter bar in this panel is an input, two selects and a button in a row.
 * Four slightly different heights there is the most common way a dense
 * toolbar comes out looking accidental, and it stays invisible right up until
 * you line them up.
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
      // OS, which is what makes one filter bar look hand-assembled next to the
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
 * A multi-select list box.
 *
 * The same skin as every other control, minus the fixed height — a list box
 * is sized by its rows. It exists because a bare `<select multiple>` inherits
 * none of the control styling, and the one on the coupon dialog was the only
 * input in the panel with a different border, radius and text size.
 */
export const MultiSelect = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }
>(function MultiSelect({ className, invalid, children, ...rest }, ref) {
  return (
    <select
      ref={ref}
      multiple
      aria-invalid={invalid === true ? true : undefined}
      className={cx(
        CONTROL_BASE,
        'py-1.5 [&>option]:rounded [&>option]:px-1.5 [&>option]:py-1',
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
 * A checkbox.
 *
 * `accent-accent`, not `text-accent`. This project does not use
 * @tailwindcss/forms, so `text-*` on a native checkbox styles nothing and
 * every tick in the panel was rendering in the browser's own blue — close
 * enough to the brand blue to look like a mistake rather than a choice.
 * `accent-color` is the property that actually paints a native control.
 */
export const Checkbox = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Checkbox({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        type="checkbox"
        className={cx(
          'h-4 w-4 shrink-0 cursor-pointer rounded border-border-strong accent-accent',
          'disabled:cursor-not-allowed disabled:opacity-60',
          className,
        )}
        {...rest}
      />
    );
  },
);

/**
 * A checkbox with its label, and optionally the sentence that says what
 * ticking it will do.
 *
 * `boxed` puts it in a card that tints when checked — for the places where the
 * checkbox *is* the decision (which roles an account gets, whether to skip
 * invalid import rows) rather than one line of a longer form.
 */
export const CheckboxField = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & {
    label: ReactNode;
    description?: ReactNode;
    boxed?: boolean;
    tone?: 'neutral' | 'warning';
  }
>(function CheckboxField(
  { label, description, boxed = false, tone = 'neutral', className, disabled, ...rest },
  ref,
) {
  return (
    <label
      className={cx(
        'flex items-start gap-2.5 text-sm',
        boxed && 'rounded-md border px-3 py-2.5 transition-[background-color,border-color]',
        boxed && tone === 'warning'
          ? 'border-warning/30 bg-warning-soft'
          : boxed &&
              'border-border hover:border-border-hover has-[:checked]:border-accent/40 has-[:checked]:bg-accent-soft',
        disabled === true ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        className,
      )}
    >
      <Checkbox ref={ref} className="mt-0.5" disabled={disabled} {...rest} />
      <span className="min-w-0">
        <span className="font-medium text-ink">{label}</span>
        {description !== undefined && (
          <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{description}</span>
        )}
      </span>
    </label>
  );
});

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
 *   - Tight padding (`px-5 py-4`). The panel is the dense half of the pair —
 *     the storefront's Card is the same component at `px-6 py-5`.
 *
 * `tone="danger"` is for a panel whose contents cannot be undone. It tints the
 * edge and the header only — never the buttons inside it, because a screen
 * where everything looks alarming is a screen where nothing does.
 */
export function Card({
  title,
  description,
  actions,
  tone = 'default',
  children,
  className,
  bodyClassName,
}: {
  // `| undefined` on the optional props, because `exactOptionalPropertyTypes`
  // is on and half the call sites pass a value that is legitimately absent —
  // `description={order.shippingMethodName ?? undefined}`. Without it every
  // one of those has to be a conditional spread, which is a lot of noise to
  // express "there may not be a subtitle".
  title?: string | undefined;
  description?: string | undefined;
  actions?: ReactNode;
  tone?: 'default' | 'danger';
  children: ReactNode;
  className?: string | undefined;
  /** Convenience for the common `px-5 py-4` body. Omit for a flush table. */
  bodyClassName?: string | undefined;
}): React.JSX.Element {
  return (
    <section
      className={cx(
        'rounded-lg border bg-surface shadow-card',
        tone === 'danger' ? 'border-danger/30' : 'border-border',
        className,
      )}
    >
      {(title !== undefined || actions !== undefined) && (
        <header
          className={cx(
            'flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b px-5 py-4',
            tone === 'danger' ? 'border-danger/20 bg-danger-soft' : 'border-border-subtle',
          )}
        >
          <div className="min-w-0">
            {title !== undefined && (
              <h2 className={cx('text-title-xs', tone === 'danger' ? 'text-danger' : 'text-ink')}>
                {title}
              </h2>
            )}
            {description !== undefined && (
              <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-ink-muted">
                {description}
              </p>
            )}
          </div>
          {actions !== undefined && (
            <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
          )}
        </header>
      )}
      {bodyClassName === undefined ? children : <div className={bodyClassName}>{children}</div>}
    </section>
  );
}

/*
 * Badge tones.
 *
 * A soft ground, its own hue in the text, and a tinted hairline. `ring-inset`
 * rather than `border`, so the badge is the same size in every tone and a
 * column of them in a table sits on one edge.
 *
 * The ring went from /20 to /25 and the text from `medium` to `semibold`:
 * these are 11px, and 11px at medium weight in a mid-tone hue was the one
 * piece of type in the panel that people were squinting at — and it is the
 * piece that carries order and payment status.
 */
const BADGE_TONES = {
  neutral: 'bg-surface-sunken text-ink-muted ring-border',
  // `accent` is this panel's original name for the primary blue; `brand` is
  // the shared one. Both are here so a badge can be lifted between the apps.
  accent: 'bg-accent-soft text-accent ring-accent/25',
  brand: 'bg-brand-soft text-brand ring-brand/25',
  action: 'bg-action-soft text-action-strong ring-action/25',
  // Recurring schedules and positive process cues. Its own hue, so a standing
  // arrangement stops looking like either a link or a completed job.
  operational: 'bg-operational-soft text-operational ring-operational/25',
  success: 'bg-success-soft text-success ring-success/25',
  warning: 'bg-warning-soft text-warning ring-warning/25',
  danger: 'bg-danger-soft text-danger ring-danger/25',
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

/*
 * The dot that can precede a badge's label.
 *
 * Colour is never the only signal — the badge always carries its text — but a
 * column of eight statuses is scanned by shape before it is read, and a filled
 * dot at the leading edge gives the eye something to sort on before the words
 * arrive.
 */
const DOT_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-ink-subtle',
  accent: 'bg-accent',
  brand: 'bg-brand',
  action: 'bg-action',
  operational: 'bg-operational',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

export function Badge({
  tone = 'neutral',
  dot = false,
  children,
}: {
  tone?: BadgeTone;
  /** Leading status dot. For the status column of an operational table. */
  dot?: boolean;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 ' +
          'text-xxs font-semibold ring-1 ring-inset',
        BADGE_TONES[tone],
      )}
    >
      {dot && (
        <span
          aria-hidden="true"
          className={cx('h-1.5 w-1.5 shrink-0 rounded-full', DOT_TONES[tone])}
        />
      )}
      {children}
    </span>
  );
}

/**
 * A short, coloured explanation.
 *
 * Replaces the `rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5
 * text-sm text-danger` that appeared, in five slightly different spellings,
 * on twenty-odd screens: form errors, live-mode warnings, webhook failures,
 * import results. One spelling means one visual weight for "read this".
 *
 * `role` is opt-in rather than automatic. A message that appears in response
 * to something the user just did should be `alert`; a standing explanation
 * that is simply part of the page should be neither, or a screen reader
 * interrupts itself on every render.
 */
const CALLOUT_TONES: Record<'info' | 'success' | 'warning' | 'danger' | 'neutral', string> = {
  info: 'border-accent/30 bg-accent-soft',
  success: 'border-success/30 bg-success-soft',
  warning: 'border-warning/30 bg-warning-soft',
  danger: 'border-danger/30 bg-danger-soft',
  neutral: 'border-border bg-surface-sunken',
};

const CALLOUT_TITLE_TONES: Record<'info' | 'success' | 'warning' | 'danger' | 'neutral', string> = {
  info: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  neutral: 'text-ink',
};

export function Callout({
  tone = 'neutral',
  title,
  role,
  children,
  className,
}: {
  tone?: 'info' | 'success' | 'warning' | 'danger' | 'neutral';
  title?: ReactNode;
  role?: 'alert' | 'status';
  children?: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      {...(role === undefined ? {} : { role })}
      className={cx('rounded-md border px-3 py-2.5 text-sm', CALLOUT_TONES[tone], className)}
    >
      {title !== undefined && (
        <p className={cx('font-semibold', CALLOUT_TITLE_TONES[tone])}>{title}</p>
      )}
      {children !== undefined && (
        <div
          className={cx(
            'leading-relaxed',
            title === undefined ? CALLOUT_TITLE_TONES[tone] : 'mt-0.5 text-ink',
          )}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

/**
 * A headline figure.
 *
 * Two emphases, and the difference is real rather than decorative: `primary`
 * is what someone opens this page to read, `secondary` is what they check
 * once they have. Same card, one type step apart.
 */
export function Metric({
  label,
  value,
  emphasis = 'secondary',
  sub,
  className,
  children,
}: {
  label: string;
  value: string;
  emphasis?: 'primary' | 'secondary';
  sub?: string | undefined;
  className?: string | undefined;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <div
      className={cx(
        'flex flex-col rounded-lg border border-border bg-surface shadow-card',
        emphasis === 'primary' ? 'p-5' : 'p-4',
        className,
      )}
    >
      <p className="text-xxs font-semibold uppercase tracking-[0.12em] text-ink-subtle">{label}</p>
      <p
        className={cx(
          'mt-2 tabular text-ink',
          emphasis === 'primary' ? 'text-title-lg' : 'text-title',
        )}
      >
        {value}
      </p>
      {sub !== undefined && <p className="mt-1 text-xs leading-relaxed text-ink-muted">{sub}</p>}
      {children}
    </div>
  );
}

/**
 * Two to four figures that have to be read against each other.
 *
 * On hand / reserved / available. Captured / already refunded / refundable.
 * Rows read / will create / will update / errors. In each case the numbers
 * only mean anything as a set, so they are one hairline-divided block rather
 * than separate cards with a gap between them.
 */
export function SummaryTiles({
  items,
  className,
}: {
  items: { label: string; value: ReactNode; tone?: 'default' | 'success' | 'warning' | 'danger' }[];
  className?: string;
}): React.JSX.Element {
  const toneClass = {
    default: 'text-ink',
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-danger',
  } as const;

  return (
    <dl
      className={cx(
        'grid gap-px overflow-hidden rounded-md border border-border bg-border text-center',
        items.length >= 4 ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-3',
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.label} className="bg-surface px-3 py-2.5">
          <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
            {item.label}
          </dt>
          <dd
            className={cx(
              'mt-0.5 text-sm font-semibold tabular',
              toneClass[item.tone ?? 'default'],
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Label-and-value pairs on a detail page.
 *
 * A real `<dl>`, so the pairing survives a screen reader. The label is the
 * same 11px uppercase caption used for table column headers — a detail page
 * and the table it came from should not look like two products.
 */
export function DescriptionList({
  items,
  columns = 2,
  className,
}: {
  items: { label: string; value: ReactNode }[];
  columns?: 1 | 2 | 3;
  className?: string;
}): React.JSX.Element {
  return (
    <dl
      className={cx(
        'grid gap-x-6 gap-y-3 text-sm',
        columns === 1 ? '' : columns === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3',
        className,
      )}
    >
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
            {item.label}
          </dt>
          <dd className="mt-0.5 break-words text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// States
//
// All four share one silhouette — centred, same vertical rhythm, same width
// limit on the explanatory line — so a table that is empty, loading, broken or
// forbidden occupies the same shape and the page does not jump between them.
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
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <p className="text-title-xs text-ink">{title}</p>
      {description !== undefined && (
        <p className="mt-1 max-w-sm text-sm leading-relaxed text-ink-muted">{description}</p>
      )}
      {action !== undefined && <div className="mt-6">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = 'Loading' }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2.5 px-6 py-14 text-sm text-ink-muted">
      <Spinner className="h-4 w-4" />
      {/* Announced politely so a screen reader says "Loading" once rather than
          interrupting whatever the user was reading. */}
      <span role="status">{label}…</span>
    </div>
  );
}

/**
 * A failed panel.
 *
 * Shows the server's own message rather than "Something went wrong" - the
 * backend writes messages an administrator can act on, and replacing them with
 * a generic apology throws that away. The correlation id is shown because it
 * is the one thing that makes a support request answerable.
 */
export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();

  const message =
    error instanceof Error && error.message.length > 0 ? error.message : 'The request failed.';

  const correlationId =
    typeof error === 'object' && error !== null && 'correlationId' in error
      ? (error as { correlationId: string | null }).correlationId
      : null;

  return (
    <div role="alert" className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <p className="max-w-md text-sm font-medium leading-relaxed text-danger">{message}</p>
      {correlationId !== null && (
        // A chip, not a line of grey text: this is the one string that will be
        // pasted into a support ticket, so it needs to look selectable.
        <p className="mt-2.5 rounded bg-surface-sunken px-2 py-1 font-mono text-xxs text-ink-subtle">
          Reference: {correlationId}
        </p>
      )}
      {onRetry !== undefined && (
        <Button className="mt-6" size="sm" onClick={onRetry}>
          {t('ui.tryAgain')}
        </Button>
      )}
    </div>
  );
}

/**
 * A panel this account may not see.
 *
 * The same silhouette as empty and error, on purpose: "you cannot see this" is
 * a state of the panel, not a failure of it, and it should not look like
 * something broke. Says where the fix comes from, because the person reading
 * it cannot grant themselves the permission.
 */
export function NoAccessState({
  title = 'You do not have access to this',
  description = 'Your account does not include the permission this panel needs. A Business Owner can change that from Staff.',
}: {
  title?: string;
  description?: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <p className="text-title-xs text-ink">{title}</p>
      <p className="mt-1 max-w-sm text-sm leading-relaxed text-ink-muted">{description}</p>
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
 * The heading is `title-lg` (24px) against the storefront's `title-xl` (30px).
 * Same scale, one step down: this is the dense app, and a panel page is read
 * from its table, not from its title.
 *
 * `back` is a detail page's way home. It sits *above* the title rather than in
 * the action row, because "Back to orders" is not an action on this order and
 * putting it beside "Save changes" gave the two the same weight.
 */
export function PageHeader({
  title,
  description,
  back,
  meta,
  actions,
}: {
  title: string;
  description?: string | undefined;
  back?: { to: string; label: string } | undefined;
  /** Badges and short facts that qualify the title. */
  meta?: ReactNode;
  actions?: ReactNode;
}): React.JSX.Element {
  return (
    <header className="mb-6">
      {back !== undefined && (
        <Link
          to={back.to}
          className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-ink-muted transition-colors hover:text-accent"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-3.5 w-3.5"
          >
            <path d="M12 15 7 10l5-5" />
          </svg>
          {back.label}
        </Link>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="text-title-lg text-ink">{title}</h1>
            {meta}
          </div>
          {description !== undefined && (
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-muted">{description}</p>
          )}
        </div>
        {actions !== undefined && (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Toolbar
//
// The search / filter / action row that sits between a Card's header and its
// table. Seven pages hand-rolled this, each with its own caption size, gap and
// vertical alignment, which is why no two filter bars in the panel were the
// same height.
// ---------------------------------------------------------------------------

/**
 * The bar itself.
 *
 * `items-end`, so a field's control lines up with a bare button beside it
 * whether or not the field has a caption above it. The sunken ground separates
 * the controls from the table below without needing a second rule.
 */
export function Toolbar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={cx(
        'flex flex-wrap items-end gap-x-3 gap-y-3 border-b border-border bg-surface-sunken px-4 py-3',
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * One labelled control in the bar.
 *
 * A real `<label>` wrapping its control, so the caption labels it without
 * needing an id threaded through. `grow` is for the search box — the one field
 * that should take whatever width is left.
 */
export function ToolbarField({
  label,
  grow = false,
  className,
  children,
}: {
  label: string;
  grow?: boolean;
  className?: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <label className={cx('flex min-w-0 flex-col gap-1', grow && 'min-w-56 flex-1', className)}>
      <span className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
        {label}
      </span>
      {children}
    </label>
  );
}

/**
 * A filter that is on or off.
 *
 * Rendered as a 40px chip rather than a bare checkbox, for two reasons: it
 * lines up with the selects beside it, and when it is on it *looks* on. "Low
 * stock only" left ticked from a previous visit, as an unstyled checkbox in a
 * row of dropdowns, is the single easiest way to conclude that stock has
 * vanished from the system.
 */
export function ToolbarToggle({
  label,
  checked,
  onChange,
  className,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
}): React.JSX.Element {
  return (
    <label
      className={cx(
        'flex h-10 shrink-0 cursor-pointer select-none items-center gap-2 rounded-md border px-3 text-sm shadow-card',
        'transition-[background-color,border-color,color]',
        checked
          ? 'border-accent bg-accent-soft font-medium text-accent'
          : 'border-border-strong bg-surface text-ink hover:border-border-hover hover:bg-surface-hover',
        className,
      )}
    >
      <Checkbox
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      {label}
    </label>
  );
}

/** Trailing controls — "Clear filters", a refresh, an export. Pushed right. */
export function ToolbarActions({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap items-center gap-2 sm:ml-auto">{children}</div>;
}
