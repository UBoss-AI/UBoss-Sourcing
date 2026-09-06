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
import { useI18n } from '@/i18n/i18n-context';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import { ApiError, NetworkError, api } from '@/lib/api';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

type Translate = ReturnType<typeof useI18n>['t'];

/** Rebuilt per render so its messages follow the chosen language. */
function buildSchema(t: Translate) {
  return z
    .object({
      newPassword: z
        .string()
        .min(12, t('validation.passwordTooShort'))
        .max(128, t('validation.passwordTooLong')),
      confirmPassword: z.string(),
    })
    .refine((values) => values.newPassword === values.confirmPassword, {
      path: ['confirmPassword'],
      message: t('validation.passwordsDoNotMatch'),
    });
}

type FormValues = z.output<ReturnType<typeof buildSchema>>;

/**
 * Expired, used and invalid are three different situations with three
 * different next actions, so they stay three separate messages rather than
 * collapsing into "that did not work".
 */
function tokenFailureMessage(t: Translate, code: string): string {
  switch (code) {
    case 'TOKEN_EXPIRED':
      return t('auth.reset.tokenExpired');
    case 'TOKEN_ALREADY_USED':
      return t('auth.reset.tokenUsed');
    case 'TOKEN_INVALID':
      return t('auth.reset.tokenInvalid');
    default:
      return t('auth.reset.tokenUnknown');
  }
}

export function ResetPasswordPage(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const navigate = useNavigate();
  const { business } = useStorefront();
  const { t } = useI18n();

  // The failure *code* is held, not the rendered sentence. A message
  // translated once and parked in state would stay in the old language after
  // somebody used the picker — and on this screen that message is the entire
  // content of the page, so it is exactly the thing they switched language to
  // be able to read.
  const [tokenErrorCode, setTokenErrorCode] = useState<string | null>(
    token === '' ? 'TOKEN_INVALID' : null,
  );
  const [formError, setFormError] = useState<string | null>(null);

  const tokenError = tokenErrorCode === null ? null : tokenFailureMessage(t, tokenErrorCode);

  useDocumentMeta({ title: t('auth.reset.pageTitle'), noIndex: true }, business.displayName);

  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(buildSchema(t)),
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
          <h1 className="text-lg font-semibold text-ink">{t('auth.reset.badLinkHeading')}</h1>
          <p className="mx-auto mt-2 max-w-sm text-sm text-ink-muted">{tokenError}</p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link
              to="/forgot-password"
              className="inline-flex h-10 items-center rounded-md bg-brand px-4 text-sm font-medium text-white hover:bg-brand-hover"
            >
              {t('auth.reset.requestNewLink')}
            </Link>
            <Link
              to="/login"
              className="inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-hover"
            >
              {t('auth.forgot.backToSignIn')}
            </Link>
          </div>
        </div>

        {/* The picker stays reachable on the dead-end screen too: this is a
            plausible place for somebody to arrive first, straight from an
            email, having never seen the sign-in page. */}
        <LanguageSwitcher placement="auth" className="mt-6" />
      </div>
    );
  }

  const onSubmit = async (values: FormValues): Promise<void> => {
    setFormError(null);

    try {
      await api.post('/auth/password/reset', {
        token,
        newPassword: values.newPassword,
      });

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
          setTokenErrorCode(error.code);
          return;
        }
        setFormError(error.message);
        return;
      }

      setFormError(t('auth.reset.failed'));
    }
  };

  return (
    <div className="mx-auto w-full max-w-md py-8">
      <LanguageSwitcher placement="auth" />

      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          {t('auth.reset.heading')}
        </h1>
        <p className="mt-1.5 text-sm text-ink-muted">{t('auth.reset.intro')}</p>
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
          label={t('auth.reset.newPassword')}
          hint={t('auth.reset.newPasswordHint')}
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

        <Field
          label={t('auth.reset.confirmPassword')}
          error={errors.confirmPassword?.message}
          required
        >
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
          {t('auth.reset.submit')}
        </Button>
      </form>
    </div>
  );
}
