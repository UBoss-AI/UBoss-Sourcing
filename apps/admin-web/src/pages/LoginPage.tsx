/**
 * Sign in.
 *
 * The one rule specific to this screen: a failed sign-in never says *which*
 * half was wrong. The backend returns one message for an unknown email and a
 * wrong password alike, because distinguishing them turns the form into a
 * way to enumerate who has an account. This page shows what the server said
 * and adds nothing.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { Button, Field, Input, Spinner } from '@/components/ui';
import { ApiError, NetworkError } from '@/lib/api';

const schema = z.object({
  email: z.string().trim().min(1, 'Enter your email address.').pipe(z.email('Enter a valid email address.')),
  password: z.string().min(1, 'Enter your password.'),
});

type FormValues = z.infer<typeof schema>;

interface LocationState {
  from?: string;
}

export function LoginPage(): React.JSX.Element {
  const { user, isLoading, login } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const [formError, setFormError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  useEffect(() => { setFocus('email'); }, [setFocus]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-6 w-6 text-ink-subtle" />
      </div>
    );
  }

  if (user !== null) {
    const from = (location.state as LocationState | null)?.from;
    return <Navigate to={from ?? '/'} replace />;
  }

  const onSubmit = async (values: FormValues): Promise<void> => {
    setFormError(null);
    setRetryAfter(null);

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

        // Rate limiting is the one case worth expanding on: without it the
        // message reads as a password problem and people keep trying.
        if (error.status === 429) {
          setRetryAfter('Too many attempts. Wait a few minutes before trying again.');
        }
        return;
      }

      setFormError('Sign-in failed. Try again.');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center">
          <span
            aria-hidden="true"
            className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white"
          >
            U
          </span>
          <h1 className="text-lg font-semibold tracking-tight text-ink">Sign in to UBOSS Admin</h1>
          <p className="mt-1 text-sm text-ink-muted">Staff accounts only.</p>
        </div>

        <form
          onSubmit={(event) => void handleSubmit(onSubmit)(event)}
          noValidate
          className="space-y-4 rounded-lg border border-border bg-surface p-6 shadow-card"
        >
          {formError !== null && (
            <div
              role="alert"
              className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
            >
              <p>{formError}</p>
              {retryAfter !== null && <p className="mt-1 text-xs">{retryAfter}</p>}
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

          <Button type="submit" variant="primary" className="w-full" isLoading={isSubmitting}>
            Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}
