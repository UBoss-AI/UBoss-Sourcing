/**
 * Request a password reset.
 *
 * The confirmation is deliberately identical whether or not the address has an
 * account. The backend answers the same for both, because a form that says "no
 * such staff account" is a way to find out who works here. This page shows one
 * message and never branches on the answer — so there is no "sent" versus "not
 * sent" state to leak.
 *
 * Validation uses react-hook-form's own rules rather than `zodResolver`, for
 * the reason set out in ChangePasswordPage: `@hookform/resolvers@3` cannot read
 * a `zod@4` error, so a failed validation throws instead of showing a message.
 * A recovery screen somebody reaches because they are already locked out must
 * not be the one that breaks.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { Button, Field, Input } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import { ApiError, NetworkError, api } from '@/lib/api';

interface FormValues {
  email: string;
}

function Shell({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-10">
      <div className="w-full max-w-sm">
        {/* In the shell rather than on each state, so the picker is there
            whether the form is showing or the "check your email" panel is.
            Somebody who cannot read the confirmation still needs the way out. */}
        <LanguageSwitcher placement="auth" />

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

export function ForgotPasswordPage(): React.JSX.Element {
  const { t } = useI18n();
  const [isSent, setIsSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ defaultValues: { email: '' } });

  useEffect(() => {
    if (!isSent) setFocus('email');
  }, [isSent, setFocus]);

  if (isSent) {
    return (
      <Shell>
        <div className="rounded-lg border border-border bg-surface p-6 text-center shadow-card">
          <h1 className="text-lg font-semibold text-ink">{t('auth.forgot.sentHeading')}</h1>
          <p className="mt-2 text-sm text-ink-muted">{t('auth.forgot.sentBodyAdmin')}</p>
          <p className="mt-2 text-xs text-ink-subtle">{t('auth.forgot.sentSpamAdmin')}</p>

          <Link
            to="/login"
            className="mt-6 inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-hover"
          >
            {t('auth.forgot.backToSignIn')}
          </Link>
        </div>
      </Shell>
    );
  }

  const onSubmit = async (values: FormValues): Promise<void> => {
    setFormError(null);

    try {
      await api.post('/admin/auth/password/forgot', { email: values.email.trim() });
      setIsSent(true);
    } catch (error) {
      // Only a transport or rate-limit failure lands here. A missing account is
      // not an error at all - that is the whole point of the uniform response.
      if (error instanceof NetworkError) {
        setFormError(error.message);
        return;
      }
      if (error instanceof ApiError) {
        setFormError(error.status === 429 ? t('auth.forgot.rateLimited') : error.message);
        return;
      }
      setFormError(t('auth.forgot.sendFailed'));
    }
  };

  return (
    <Shell>
      <div className="mb-6 text-center">
        <h1 className="text-lg font-semibold tracking-tight text-ink">
          {t('auth.forgot.heading')}
        </h1>
        <p className="mt-1 text-sm text-ink-muted">{t('auth.forgot.enterAddress')}</p>
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
            {formError}
          </div>
        )}

        <Field label={t('common.emailAddress')} error={errors.email?.message} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="email"
              autoComplete="username"
              aria-describedby={describedBy}
              invalid={errors.email !== undefined}
              {...register('email', {
                required: t('validation.emailRequired'),
                pattern: {
                  value: /^\S+@\S+\.\S+$/,
                  message: t('validation.emailInvalid'),
                },
              })}
            />
          )}
        </Field>

        <Button type="submit" variant="primary" className="w-full" isLoading={isSubmitting}>
          {t('auth.forgot.emailMeALink')}
        </Button>

        <p className="text-center text-sm">
          <Link to="/login" className="font-medium text-accent hover:underline">
            {t('auth.forgot.backToSignIn')}
          </Link>
        </p>
      </form>
    </Shell>
  );
}
