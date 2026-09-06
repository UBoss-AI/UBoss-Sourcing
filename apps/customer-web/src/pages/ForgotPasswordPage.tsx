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
import { useI18n } from '@/i18n/i18n-context';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import { ApiError, NetworkError, api } from '@/lib/api';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

/** Rebuilt per render so its messages follow the chosen language. */
function buildSchema(t: ReturnType<typeof useI18n>['t']) {
  return z.object({
    email: z
      .string()
      .trim()
      .min(1, t('validation.emailRequired'))
      .pipe(z.email(t('validation.emailInvalid'))),
  });
}

type FormValues = z.output<ReturnType<typeof buildSchema>>;

export function ForgotPasswordPage(): React.JSX.Element {
  const { business } = useStorefront();
  const { t } = useI18n();
  const [isSent, setIsSent] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useDocumentMeta({ title: t('auth.forgot.pageTitle'), noIndex: true }, business.displayName);

  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(buildSchema(t)),
    defaultValues: { email: '' },
  });

  useEffect(() => {
    setFocus('email');
  }, [setFocus]);

  if (isSent) {
    return (
      <div className="mx-auto w-full max-w-md py-8">
        <div className="rounded-lg border border-border bg-surface p-6 text-center shadow-card">
          <h1 className="text-lg font-semibold text-ink">{t('auth.forgot.sentHeading')}</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm text-ink-muted">
            {t('auth.forgot.sentBody')}
          </p>
          <p className="mt-2 text-xs text-ink-subtle">{t('auth.forgot.sentSpam')}</p>
          <Link
            to="/login"
            className="mt-6 inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-hover"
          >
            {t('auth.forgot.backToSignIn')}
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
        setFormError(t('auth.forgot.rateLimited'));
        return;
      }

      setIsSent(true);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md py-8">
      <LanguageSwitcher placement="auth" />

      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          {t('auth.forgot.heading')}
        </h1>
        <p className="mt-1.5 text-sm text-ink-muted">{t('auth.forgot.intro')}</p>
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

        <Field label={t('common.emailAddress')} error={errors.email?.message} required>
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
          {t('auth.forgot.submit')}
        </Button>

        <p className="text-center text-sm">
          <Link to="/login" className="font-medium text-brand hover:underline">
            {t('auth.forgot.backToSignIn')}
          </Link>
        </p>
      </form>
    </div>
  );
}
