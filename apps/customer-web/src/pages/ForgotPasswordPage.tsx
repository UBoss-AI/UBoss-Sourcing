/**
 * Request a password reset.
 *
 * The confirmation is deliberately the same whether or not the address exists.
 * The backend answers identically for both, because a form that says "no
 * account with that email" is a way to find out who is a customer. This page
 * shows one message and never branches on the answer.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router-dom';
import { z } from 'zod';
import { useStorefront } from '@/app/storefront-context';
import { Button, Field, Input } from '@/components/ui';
import { ApiError, NetworkError, api } from '@/lib/api';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

const schema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter your email address.')
    .pipe(z.email('Enter a valid email address.')),
});

type FormValues = z.output<typeof schema>;

export function ForgotPasswordPage(): React.JSX.Element {
  const { business } = useStorefront();
  const [isSent, setIsSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useDocumentMeta({ title: 'Reset your password', noIndex: true }, business.displayName);

  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  });

  useEffect(() => {
    setFocus('email');
  }, [setFocus]);

  if (isSent) {
    return (
      <div className="mx-auto w-full max-w-md py-8">
        <div className="rounded-lg border border-border bg-surface p-6 text-center shadow-card">
          <h1 className="text-lg font-semibold text-ink">Check your email</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm text-ink-muted">
            If that address belongs to an account, a reset link is on its way. It is valid for a
            limited time, so use it soon.
          </p>
          <p className="mt-2 text-xs text-ink-subtle">
            Nothing arrived? Check your spam folder before asking for another.
          </p>
          <Link
            to="/login"
            className="mt-6 inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-sunken"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  const onSubmit = async (values: FormValues): Promise<void> => {
    setFormError(null);

    try {
      await api.post('/auth/password/forgot', { email: values.email });
      setIsSent(true);
    } catch (error) {
      if (error instanceof NetworkError) {
        setFormError(error.message);
        return;
      }

      // Rate limiting is the one failure worth reporting here. Anything else
      // would let the caller distinguish a real address from an unknown one,
      // which is exactly what the uniform response prevents.
      if (error instanceof ApiError && error.isRateLimited) {
        setFormError('Too many requests. Please wait a few minutes and try again.');
        return;
      }

      setIsSent(true);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md py-8">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Reset your password</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          We will email you a link to choose a new one.
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
            {formError}
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

        <Button type="submit" variant="primary" size="lg" fullWidth isLoading={isSubmitting}>
          Send the reset link
        </Button>

        <p className="text-center text-sm">
          <Link to="/login" className="font-medium text-brand hover:underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
