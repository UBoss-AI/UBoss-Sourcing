/**
 * Set a new password from an emailed reset link.
 *
 * Reached at `/reset-password?token=…`, the URL the backend built. Everything
 * here is shaped by the token being single-use and short-lived: it may be
 * expired, already spent, or simply wrong, and somebody locked out of their
 * account cannot be left guessing which.
 *
 * Two decisions worth keeping:
 *
 *   - **The token is never checked by a separate call first.** No such endpoint
 *     exists, and adding a client-side guess would create a second source of
 *     truth about a one-shot token. The form submits, and the server's own
 *     error code decides what is shown and whether retrying could help.
 *   - **A dead link is not a dead end.** Every terminal failure offers the one
 *     action that recovers it — ask for a fresh link.
 *
 * Validation uses react-hook-form's own rules rather than `zodResolver`, for
 * the reason set out in ChangePasswordPage: `@hookform/resolvers@3` cannot read
 * a `zod@4` error, so a failed validation throws instead of showing a message.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, Field, Input } from '@/components/ui';
import { ApiError, NetworkError, api } from '@/lib/api';

interface FormValues {
  newPassword: string;
  confirmPassword: string;
}

const MIN_LENGTH = 12;
const MAX_LENGTH = 128;

/** Failures no amount of retyping can fix — the link itself is the problem. */
const TERMINAL_CODES = new Set([
  'TOKEN_EXPIRED',
  'TOKEN_ALREADY_USED',
  'TOKEN_INVALID',
  'ACCOUNT_DEACTIVATED',
]);

function recoveryFor(code: string): { title: string; body: string } {
  switch (code) {
    case 'TOKEN_EXPIRED':
      return {
        title: 'This link has expired',
        body: 'Reset links last an hour, because a live one sitting in an inbox is a key to the account. Ask for a fresh one and it will arrive within a few minutes.',
      };
    case 'TOKEN_ALREADY_USED':
      return {
        title: 'This link has already been used',
        body: 'Your password is already set. Sign in with it — or ask for another link if you cannot remember what you chose.',
      };
    case 'TOKEN_INVALID':
      return {
        title: 'This reset link is not valid',
        body: 'The link may have been copied incompletely. Try opening it straight from the email rather than pasting it.',
      };
    case 'ACCOUNT_DEACTIVATED':
      return {
        title: 'This account is no longer active',
        body: 'Ask a Business Owner to reactivate it from Staff before resetting the password.',
      };
    default:
      return {
        title: 'We could not set your password',
        body: 'Something went wrong at our end. Asking for a new link is usually the quickest way through.',
      };
  }
}

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center">
          <span
            aria-hidden="true"
            className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white"
          >
            U
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

function Failure({ code, message }: { code: string; message: string }): React.JSX.Element {
  const recovery = recoveryFor(code);

  return (
    <Shell>
      <div
        role="alert"
        className="rounded-lg border border-border bg-surface p-6 text-center shadow-card"
      >
        <h1 className="text-lg font-semibold text-ink">{recovery.title}</h1>
        <p className="mt-2 text-sm text-ink-muted">{recovery.body}</p>
        {/* The server's own wording, kept alongside ours rather than replacing
            it — it sometimes carries a detail the generic copy cannot. */}
        <p className="mt-2 text-xs text-ink-subtle">{message}</p>

        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <Link
            to="/forgot-password"
            className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-medium text-white hover:bg-accent-hover"
          >
            Email me a new link
          </Link>
          <Link
            to="/login"
            className="inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-hover"
          >
            Go to sign in
          </Link>
        </div>
      </div>
    </Shell>
  );
}

export function ResetPasswordPage(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [isDone, setIsDone] = useState(false);
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);

  const {
    register,
    handleSubmit,
    getValues,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ defaultValues: { newPassword: '', confirmPassword: '' } });

  useEffect(() => {
    if (token !== '' && !isDone) setFocus('newPassword');
  }, [token, isDone, setFocus]);

  // A link with no token never reaches the server: there is nothing to send,
  // and a round trip would only produce the same answer more slowly.
  if (token === '') {
    return <Failure code="TOKEN_INVALID" message="No reset token was found in the link." />;
  }

  const isTerminal = failure !== null && TERMINAL_CODES.has(failure.code);
  if (isTerminal) {
    return <Failure code={failure.code} message={failure.message} />;
  }

  if (isDone) {
    return (
      <Shell>
        <div className="rounded-lg border border-success/30 bg-success-soft p-6 text-center">
          <h1 className="text-lg font-semibold text-success">Your password is set</h1>
          <p className="mt-2 text-sm text-ink">
            Sign in with it. Any other session you had open has been signed out.
          </p>
          <div className="mt-6 flex justify-center">
            <Link
              to="/login"
              className="inline-flex h-10 items-center rounded-md bg-accent px-5 text-sm font-medium text-white"
            >
              Go to sign in
            </Link>
          </div>
        </div>
      </Shell>
    );
  }

  const onSubmit = async (values: FormValues): Promise<void> => {
    setFailure(null);

    try {
      await api.post('/admin/auth/password/reset', {
        token,
        newPassword: values.newPassword,
      });
      setIsDone(true);
    } catch (error) {
      if (error instanceof NetworkError) {
        setFailure({ code: 'NETWORK', message: error.message });
        return;
      }
      if (error instanceof ApiError) {
        setFailure({ code: error.code, message: error.message });
        return;
      }
      setFailure({ code: 'UNKNOWN', message: 'The password could not be set.' });
    }
  };

  return (
    <Shell>
      <div className="mb-6 text-center">
        <h1 className="text-lg font-semibold tracking-tight text-ink">Choose a new password</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Only you will know it — nobody at UBOSS can see or set it.
        </p>
      </div>

      <form
        onSubmit={(event) => void handleSubmit(onSubmit)(event)}
        noValidate
        className="space-y-4 rounded-lg border border-border bg-surface p-6 shadow-card"
      >
        {/* A non-terminal failure - a rate limit, a network blip - leaves the
            form in place, because retrying is the right next move. */}
        {failure !== null && (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
          >
            {failure.message}
          </div>
        )}

        <Field
          label="New password"
          hint="At least 12 characters. A short phrase you will remember beats a short jumble you will not."
          error={errors.newPassword?.message}
          required
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              invalid={errors.newPassword !== undefined}
              {...register('newPassword', {
                required: 'Choose a password.',
                minLength: { value: MIN_LENGTH, message: 'Use at least 12 characters.' },
                maxLength: { value: MAX_LENGTH, message: 'Use at most 128 characters.' },
              })}
            />
          )}
        </Field>

        <Field label="Confirm your new password" error={errors.confirmPassword?.message} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              invalid={errors.confirmPassword !== undefined}
              {...register('confirmPassword', {
                required: 'Type the password again.',
                validate: (value) =>
                  value === getValues('newPassword') || 'The two passwords do not match.',
              })}
            />
          )}
        </Field>

        <Button type="submit" variant="primary" className="w-full" isLoading={isSubmitting}>
          Set my password
        </Button>
      </form>
    </Shell>
  );
}
