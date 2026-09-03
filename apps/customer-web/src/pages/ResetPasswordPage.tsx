/**
 * Choose a new password from a reset link.
 *
 * Same token-failure handling as activation: expired, used and invalid are
 * three different situations with three different next actions, and a customer
 * told only "that did not work" is stuck.
 *
 * Unlike activation, a successful reset does *not* sign the customer in — the
 * backend issues no session here. They are sent to sign-in with the password
 * they just chose, which is also the moment it gets confirmed to work.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { useStorefront } from '@/app/storefront-context';
import { Button, Field, Input } from '@/components/ui';
import { ApiError, NetworkError, api } from '@/lib/api';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

const schema = z
  .object({
    newPassword: z
      .string()
      .min(12, 'Use at least 12 characters.')
      .max(128, 'Use at most 128 characters.'),
    confirmPassword: z.string(),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    path: ['confirmPassword'],
    message: 'The two passwords do not match.',
  });

type FormValues = z.output<typeof schema>;

function tokenFailureMessage(code: string): string {
  switch (code) {
    case 'TOKEN_EXPIRED':
      return 'This reset link has expired. Reset links are short-lived for security — request a new one.';
    case 'TOKEN_ALREADY_USED':
      return 'This reset link has already been used. If it was not you, request a new one and sign in straight away.';
    case 'TOKEN_INVALID':
      return 'This reset link is not valid. Try opening it directly from the email rather than pasting it.';
    default:
      return 'We could not reset your password. Please request a new link.';
  }
}

export function ResetPasswordPage(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const navigate = useNavigate();
  const { business } = useStorefront();

  const [tokenError, setTokenError] = useState<string | null>(
    token === '' ? tokenFailureMessage('TOKEN_INVALID') : null,
  );
  const [formError, setFormError] = useState<string | null>(null);

  useDocumentMeta({ title: 'Choose a new password', noIndex: true }, business.displayName);

  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { newPassword: '', confirmPassword: '' },
  });

  useEffect(() => {
    if (token !== '') setFocus('newPassword');
  }, [token, setFocus]);

  if (tokenError !== null) {
    return (
      <div className="mx-auto w-full max-w-md py-8">
        <div
          role="alert"
          className="rounded-lg border border-border bg-surface p-6 text-center shadow-card"
        >
          <h1 className="text-lg font-semibold text-ink">This link will not work</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm text-ink-muted">{tokenError}</p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link
              to="/forgot-password"
              className="inline-flex h-10 items-center rounded-md bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover"
            >
              Request a new link
            </Link>
            <Link
              to="/login"
              className="inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-sunken"
            >
              Back to sign in
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const onSubmit = async (values: FormValues): Promise<void> => {
    setFormError(null);

    try {
      await api.post('/auth/password/reset', { token, newPassword: values.newPassword });

      // No session is issued here on purpose, so signing in is the step that
      // confirms the new password actually works.
      void navigate('/login', {
        replace: true,
        state: { justReset: true },
      });
    } catch (error) {
      if (error instanceof NetworkError) {
        setFormError(error.message);
        return;
      }

      if (error instanceof ApiError) {
        if (error.code.startsWith('TOKEN_')) {
          setTokenError(tokenFailureMessage(error.code));
          return;
        }
        setFormError(error.message);
        return;
      }

      setFormError('The password could not be reset.');
    }
  };

  return (
    <div className="mx-auto w-full max-w-md py-8">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Choose a new password</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          You will sign in with this straight afterwards.
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

        <Field
          label="New password"
          hint="At least 12 characters."
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
              {...register('newPassword')}
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

        <Button type="submit" variant="primary" size="lg" fullWidth isLoading={isSubmitting}>
          Save my new password
        </Button>
      </form>
    </div>
  );
}
