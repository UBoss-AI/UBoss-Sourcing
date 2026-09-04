/**
 * Invitation activation.
 *
 * The customer arrives from an emailed link the backend built:
 * `/activate?token=…`. Everything about this screen is shaped by the fact that
 * the token might be expired, already used, or simply wrong — and a customer
 * who cannot tell which is stuck.
 *
 * Two decisions worth keeping:
 *
 *   - **The token is never validated by a separate "check" call first.** There
 *     is no such endpoint, and adding a client-side guess would create a second
 *     source of truth. The form submits, and the server's own error code
 *     decides what the customer is told and what they can do about it.
 *   - **Nobody but the account holder sets the password.** There is no path
 *     here that accepts a password chosen by anyone else — that is the whole
 *     point of the invitation flow.
 *
 * The password rules mirror the backend's `passwordSchema`. They are shown
 * *before* the customer types, not as a rejection afterwards.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { Button, ButtonLink, Field, Input } from '@/components/ui';
import { ApiError, NetworkError, api } from '@/lib/api';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

/**
 * Mirrors the backend's password policy.
 *
 * Duplicated deliberately, and it is the *only* rule duplicated in this app:
 * a customer setting a password should be told the requirement as they type,
 * not have their submission rejected. The server enforces the same policy, so
 * a drift here costs a confusing message, never a weak password.
 */
const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters.')
  .max(128, 'Use at most 128 characters.');

const schema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
    acceptedTerms: z.literal(true, {
      message: 'You need to accept the terms to activate your account.',
    }),
  })
  .refine((values) => values.password === values.confirmPassword, {
    path: ['confirmPassword'],
    message: 'The two passwords do not match.',
  });

type FormValues = z.output<typeof schema>;

/** Failures no amount of retyping can fix — the link itself is the problem. */
const TERMINAL_CODES = new Set([
  'TOKEN_EXPIRED',
  'TOKEN_ALREADY_USED',
  'INVITATION_ALREADY_ACCEPTED',
  'TOKEN_INVALID',
  'ACCOUNT_DEACTIVATED',
]);

/** What the customer should do next, per failure the server can report. */
function recoveryFor(code: string): { title: string; body: string; canRetry: boolean } {
  switch (code) {
    case 'TOKEN_EXPIRED':
      return {
        title: 'This invitation has expired',
        body: 'Invitation links are time-limited for security. Ask us to send a new one and it will arrive within a few minutes.',
        canRetry: false,
      };
    case 'TOKEN_ALREADY_USED':
    case 'INVITATION_ALREADY_ACCEPTED':
      return {
        title: 'This invitation has already been used',
        body: 'Your account is set up. Sign in with the password you chose — or reset it if you cannot remember.',
        canRetry: false,
      };
    case 'TOKEN_INVALID':
      return {
        title: 'This activation link is not valid',
        body: 'The link may have been copied incompletely. Try opening it straight from the email rather than pasting it.',
        canRetry: false,
      };
    case 'ACCOUNT_DEACTIVATED':
      return {
        title: 'This account is no longer active',
        body: 'Please contact us and we will sort it out.',
        canRetry: false,
      };
    default:
      return {
        title: 'We could not activate your account',
        body: 'Something went wrong at our end. Please try again in a moment.',
        canRetry: true,
      };
  }
}

function Failure({
  code,
  message,
  onRetry,
}: {
  code: string;
  message: string;
  onRetry: () => void;
}): React.JSX.Element {
  const { business } = useStorefront();
  const recovery = recoveryFor(code);

  return (
    <div
      role="alert"
      className="rounded-lg border border-border bg-surface p-6 text-center shadow-card"
    >
      <h1 className="text-lg font-semibold text-ink">{recovery.title}</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm text-ink-muted">{recovery.body}</p>
      {/* The server's own wording, kept alongside ours rather than replacing
          it — it sometimes carries a detail the generic copy cannot. */}
      <p className="mt-2 text-xs text-ink-subtle">{message}</p>

      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {recovery.canRetry && (
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        )}
        <Link
          to="/login"
          className="inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-hover"
        >
          Go to sign in
        </Link>
        {business.supportEmail !== null && (
          <a
            href={`mailto:${business.supportEmail}?subject=Account%20activation`}
            className="inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-hover"
          >
            Contact support
          </a>
        )}
      </div>
    </div>
  );
}

export function ActivatePage(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const navigate = useNavigate();
  const { login } = useSession();
  const { business } = useStorefront();

  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);

  /**
   * null      still on the form
   * activated the account works, but the automatic sign-in did not
   * signed-in  activated and signed in — the ordinary path
   */
  const [outcome, setOutcome] = useState<'activated' | 'signed-in' | null>(null);

  useDocumentMeta({ title: 'Activate your account', noIndex: true }, business.displayName);

  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirmPassword: '', acceptedTerms: false as never },
  });

  useEffect(() => {
    if (token !== '') setFocus('password');
  }, [token, setFocus]);

  // A link with no token at all never reaches the server — there is nothing to
  // send, and a round trip would only produce the same answer more slowly.
  if (token === '') {
    return (
      <div className="mx-auto w-full max-w-md py-8">
        <Failure
          code="TOKEN_INVALID"
          message="No activation token was found in the link."
          onRetry={() => {
            void navigate('/login');
          }}
        />
      </div>
    );
  }

  if (outcome !== null) {
    return (
      <div className="mx-auto w-full max-w-md py-8">
        <div className="rounded-lg border border-success/30 bg-success-soft p-6 text-center">
          <h1 className="text-lg font-semibold text-success">Your account is ready</h1>
          <p className="mt-2 text-sm text-ink">
            {outcome === 'signed-in'
              ? 'You are signed in and can start ordering right away.'
              : 'Sign in with the password you just chose to start ordering.'}
          </p>
          <div className="mt-6 flex justify-center gap-2">
            {outcome === 'signed-in' ? (
              <ButtonLink to="/products" variant="primary">
                Browse products
              </ButtonLink>
            ) : (
              <Link
                to="/login"
                className="inline-flex h-10 items-center rounded-md bg-brand px-5 text-sm font-medium text-white hover:bg-brand-hover"
              >
                Go to sign in
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  const onSubmit = async (values: FormValues): Promise<void> => {
    setFailure(null);

    try {
      const result = await api.post<{ activated: boolean; email: string }>(
        '/auth/invitations/accept',
        {
          token,
          password: values.password,
          acceptedTerms: values.acceptedTerms,
        },
      );

      // Activation deliberately issues no session — the endpoint's own message
      // is "you can now sign in". Rather than sending the customer to a form to
      // retype the password they chose one second ago, sign them in here.
      try {
        await login(result.email, values.password);
        setOutcome('signed-in');
      } catch {
        // The account is genuinely active; only the convenience sign-in failed.
        // Saying so is honest, and the sign-in page still works.
        setOutcome('activated');
      }
    } catch (error) {
      if (error instanceof NetworkError) {
        setFailure({ code: 'NETWORK', message: error.message });
        return;
      }

      if (error instanceof ApiError) {
        setFailure({ code: error.code, message: error.message });
        return;
      }

      setFailure({ code: 'UNKNOWN', message: 'Activation failed.' });
    }
  };

  // A token problem is terminal for this page — there is nothing useful to
  // type, so the form is replaced by a recovery panel. A validation problem is
  // not terminal, so the form stays and the message sits above it.
  const isTerminal = failure !== null && TERMINAL_CODES.has(failure.code);

  if (failure !== null && isTerminal) {
    return (
      <div className="mx-auto w-full max-w-md py-8">
        <Failure
          code={failure.code}
          message={failure.message}
          onRetry={() => {
            setFailure(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md py-8">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Activate your account</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          Choose a password. Only you will know it — nobody at {business.displayName} can see or
          set it.
        </p>
      </div>

      <form
        onSubmit={(event) => {
          void handleSubmit(onSubmit)(event);
        }}
        noValidate
        className="space-y-4 rounded-lg border border-border bg-surface p-6 shadow-card"
      >
        {failure !== null && !isTerminal && (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
          >
            {failure.message}
          </div>
        )}

        <Field
          label="Choose a password"
          hint="At least 12 characters. A short phrase you will remember beats a short jumble you will not."
          error={errors.password?.message}
          required
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              invalid={errors.password !== undefined}
              {...register('password')}
            />
          )}
        </Field>

        <Field label="Confirm your password" error={errors.confirmPassword?.message} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              invalid={errors.confirmPassword !== undefined}
              {...register('confirmPassword')}
            />
          )}
        </Field>

        <div>
          <label className="flex items-start gap-2.5 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand"
              aria-describedby={errors.acceptedTerms === undefined ? undefined : 'terms-error'}
              {...register('acceptedTerms')}
            />
            <span>
              I accept the terms of business
              {business.policyLinks !== null && Object.keys(business.policyLinks).length > 0 && (
                <>
                  {' '}
                  (
                  {Object.entries(business.policyLinks).map(([label, href], index) => (
                    <span key={label}>
                      {index > 0 && ', '}
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-medium text-brand hover:underline"
                      >
                        {label}
                      </a>
                    </span>
                  ))}
                  )
                </>
              )}
            </span>
          </label>

          {errors.acceptedTerms?.message !== undefined && (
            <p id="terms-error" role="alert" className="mt-1.5 text-xs font-medium text-danger">
              {errors.acceptedTerms.message}
            </p>
          )}
        </div>

        <Button type="submit" variant="primary" size="lg" fullWidth isLoading={isSubmitting}>
          Activate my account
        </Button>
      </form>
    </div>
  );
}
