/**
 * Shared UI primitives.
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
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import { cx } from '@/lib/cx';

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'action' | 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // `action` is the buy path — deliberately a different hue from `primary`, so
  // Add to Cart never reads as just another link.
  action: 'bg-action text-white hover:bg-action-hover disabled:bg-ink-subtle',
  primary: 'bg-brand text-white hover:bg-brand-hover disabled:bg-ink-subtle',
  secondary:
    'bg-surface text-ink border border-border-strong hover:bg-surface-sunken disabled:text-ink-subtle',
  ghost: 'text-ink-muted hover:bg-surface-sunken hover:text-ink disabled:text-ink-subtle',
  danger: 'bg-danger text-white hover:brightness-110 disabled:bg-ink-subtle',
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  // Large enough to be a comfortable touch target on a phone.
  lg: 'h-12 px-6 text-base',
};

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
        'inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors',
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
        <p id={hintId} className="text-xs text-ink-muted">
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

const CONTROL_CLASSES =
  'block w-full rounded-md border border-border-strong bg-surface px-3 py-2.5 text-sm text-ink ' +
  'placeholder:text-ink-subtle disabled:bg-surface-sunken disabled:text-ink-muted';

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
>(function Input({ className, invalid, ...rest }, ref) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid === true ? true : undefined}
      className={cx(CONTROL_CLASSES, invalid === true && 'border-danger', className)}
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
      className={cx(CONTROL_CLASSES, 'min-h-24', invalid === true && 'border-danger', className)}
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
      className={cx(CONTROL_CLASSES, 'pr-8', invalid === true && 'border-danger', className)}
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
      className="rounded-md border border-danger/30 bg-danger-soft px-4 py-3 outline-none"
    >
      <h2 className="text-sm font-semibold text-danger">{title}</h2>
      <ul className="mt-1.5 space-y-1 text-sm text-ink">
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
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            {title !== undefined && <h2 className="text-base font-semibold text-ink">{title}</h2>}
            {description !== undefined && (
              <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
            )}
          </div>
          {actions !== undefined && <div className="flex shrink-0 gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

const BADGE_TONES = {
  neutral: 'bg-surface-sunken text-ink-muted border-border',
  brand: 'bg-brand-soft text-brand border-brand/20',
  success: 'bg-success-soft text-success border-success/20',
  warning: 'bg-warning-soft text-warning border-warning/20',
  danger: 'bg-danger-soft text-danger border-danger/20',
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
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xxs font-medium',
        BADGE_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// States
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
      <p className="text-base font-medium text-ink">{title}</p>
      {description !== undefined && (
        <p className="mt-1.5 max-w-md text-sm text-ink-muted">{description}</p>
      )}
      {action !== undefined && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function LoadingState({ label = 'Loading' }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-ink-muted">
      <Spinner />
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
      <p className="text-sm font-medium text-danger">{message}</p>
      {correlationId !== null && (
        <p className="mt-1 font-mono text-xxs text-ink-subtle">
          Quote this if you contact support: {correlationId}
        </p>
      )}
      {onRetry !== undefined && (
        <Button className="mt-5" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

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
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description !== undefined && <p className="mt-1.5 text-sm text-ink-muted">{description}</p>}
      </div>
      {actions !== undefined && <div className="flex gap-2">{actions}</div>}
    </header>
  );
}
