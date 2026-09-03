/**
 * Sign in.
 *
 * The rule specific to this screen: a failed sign-in never says *which* half
 * was wrong. The backend returns one message for an unknown email and a wrong
 * password alike, because distinguishing them turns the form into a way to
 * discover who has an account. This page shows what the server said and adds
 * nothing.
 *
 * Self-registration is offered only when the backend's flag says so. A "Create
 * an account" link that leads to a 403 is worse than no link.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { Button, Field, Input, Spinner } from '@/components/ui';
import { ApiError, NetworkError } from '@/lib/api';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

const schema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter your email address.')
    .pipe(z.email('Enter a valid email address.')),
  password: z.string().min(1, 'Enter your password.'),
});

type FormValues = z.output<typeof schema>;

interface LocationState {
  from?: string;
}

export function LoginPage(): React.JSX.Element {
  const { user, isCustomer, isLoading, login } = useSession();
  const { business, features } = useStorefront();
  const navigate = useNavigate();
  const location = useLocation();

  const [formError, setFormError] = useState<string | null>(null);
  const [extraHelp, setExtraHelp] = useState<string | null>(null);

  useDocumentMeta({ title: 'Sign in', noIndex: true }, business.displayName);

  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  useEffect(() => {
    setFocus('email');
  }, [setFocus]);

  if (isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-ink-subtle" />
        <span className="sr-only" role="status">
          Checking your session
        </span>
      </div>
    );
  }

  if (isCustomer) {
    const from = (location.state as LocationState | null)?.from;
    return <Navigate to={from ?? '/'} replace />;
  }

  const onSubmit = async (values: FormValues): Promise<void> => {
    setFormError(null);
    setExtraHelp(null);

    try {
      await login(values.email, values.password);
      const from = (location.state as LocationState | null)?.from;
      void navigate(from ?? '/', { replace: true });
    } catch (error) {
      if (error instanceof NetworkError) {
        setFormError(error.message);
        return;
      }

      if (error instanceof ApiError) {
        setFormError(error.message);

        // Each of these has a different next action, and leaving a customer to
        // guess which one applies is how a support call starts.
        if (error.isRateLimited) {
          setExtraHelp(
            error.retryAfterSeconds === null
              ? 'Too many attempts. Wait a few minutes before trying again.'
              : `Too many attempts. Try again in about ${String(Math.ceil(error.retryAfterSeconds / 60))} minute(s).`,
          );
        } else if (error.code === 'ACCOUNT_NOT_ACTIVATED') {
          setExtraHelp(
            'This account has not been activated yet. Use the link in your invitation email, or ask us to send a new one.',
          );
        } else if (error.code === 'ACCOUNT_LOCKED') {
          setExtraHelp('For your security this account is temporarily locked. Try again shortly.');
        } else if (error.code === 'ACCOUNT_DEACTIVATED') {
          setExtraHelp(
            business.supportEmail === null
              ? 'This account is no longer active. Please contact us.'
              : `This account is no longer active. Contact ${business.supportEmail} to restore it.`,
          );
        }
        return;
      }

      setFormError('Sign-in failed. Please try again.');
    }
  };

  return (
    <div className="mx-auto w-full max-w-md py-8">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Sign in</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          {/* Reaching here means not signed in as a customer. A user object
              that still exists is therefore a staff session, which cannot
              shop — saying so beats an unexplained sign-in form. */}
          {user === null
            ? 'Sign in to place orders and manage repeat purchases.'
            : 'You are signed in with a staff account. Sign in with your customer account to order.'}
        </p>
      </div>

      <form
        onSubmit={(event) => {
          void handleSubmit(onSubmit)(event);
        }}
        noValidate
        className="space-y-4 rounded-lg border border-border bg-surface p-6 shadow-card"
      >
        {formError !== null && (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
          >
            <p>{formError}</p>
            {extraHelp !== null && <p className="mt-1.5 text-ink">{extraHelp}</p>}
          </div>
        )}

        <Field label="Email address" error={errors.email?.message} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="email"
              autoComplete="username"
              aria-describedby={describedBy}
              invalid={errors.email !== undefined}
              {...register('email')}
            />
          )}
        </Field>

        <Field label="Password" error={errors.password?.message} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="password"
              autoComplete="current-password"
              aria-describedby={describedBy}
              invalid={errors.password !== undefined}
              {...register('password')}
            />
          )}
        </Field>

        <Button type="submit" variant="primary" size="lg" fullWidth isLoading={isSubmitting}>
          Sign in
        </Button>

        <p className="text-center text-sm">
          <Link to="/forgot-password" className="font-medium text-brand hover:underline">
            Forgot your password?
          </Link>
        </p>
      </form>

      <div className="mt-5 rounded-lg border border-border bg-surface p-5 text-sm">
        <h2 className="font-medium text-ink">Do not have an account?</h2>

        {features.selfRegistration ? (
          <p className="mt-1.5 text-ink-muted">
            <Link to="/register" className="font-medium text-brand hover:underline">
              Create one now
            </Link>{' '}
            — it only takes a minute.
          </p>
        ) : (
          <p className="mt-1.5 text-ink-muted">
            Accounts are set up by our team. If you have been invited, use the activation link in
            your email.
            {business.supportEmail !== null && (
              <>
                {' '}
                Not received one?{' '}
                <a
                  href={`mailto:${business.supportEmail}`}
                  className="font-medium text-brand hover:underline"
                >
                  Get in touch
                </a>
                .
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
