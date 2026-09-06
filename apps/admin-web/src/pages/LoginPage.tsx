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
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { Button, Field, Input, Spinner } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { LanguageSwitcher, TranslationQualityNotice } from '@/i18n/LanguageSwitcher';
import { ApiError, NetworkError } from '@/lib/api';

/**
 * Built per render rather than once at module scope, because the messages
 * inside it are translated and the module is evaluated long before a language
 * has been resolved. A schema frozen at import time would report every
 * validation failure in whatever language happened to load first.
 */
function buildSchema(t: ReturnType<typeof useI18n>['t']) {
  return z.object({
    email: z
      .string()
      .trim()
      .min(1, t('validation.emailRequired'))
      .pipe(z.email(t('validation.emailInvalid'))),
    password: z.string().min(1, t('validation.passwordRequired')),
  });
}

type FormValues = z.infer<ReturnType<typeof buildSchema>>;

interface LocationState {
  from?: string;
}

export function LoginPage(): React.JSX.Element {
  const { user, isLoading, login } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useI18n();
  const [formError, setFormError] = useState<string | null>(null);

  // A flag, not a rendered sentence: somebody who has just failed to sign in
  // and reached for the language picker needs this line re-rendered in the
  // language they picked, not left in the one they could not read.
  const [isRateLimited, setIsRateLimited] = useState(false);

  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(buildSchema(t)),
    defaultValues: { email: '', password: '' },
  });

  useEffect(() => {
    setFocus('email');
  }, [setFocus]);

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
    setIsRateLimited(false);

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
          setIsRateLimited(true);
        }
        return;
      }

      setFormError(t('auth.login.failed'));
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4">
      <div className="w-full max-w-sm">
        {/* On the first screen, not buried in a settings page inside the
            panel. A warehouse or finance user who cannot read English cannot
            navigate to a setting written in it, and this is the one screen
            they are guaranteed to reach. The choice carries into the session
            on sign-in. */}
        <LanguageSwitcher placement="auth" />

        <div className="mb-6 flex flex-col items-center">
          <span
            aria-hidden="true"
            className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white"
          >
            U
          </span>
          <h1 className="text-lg font-semibold tracking-tight text-ink">
            {t('auth.login.heading')}
          </h1>
          <p className="mt-1 text-sm text-ink-muted">{t('auth.login.subheading')}</p>
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
              {isRateLimited && <p className="mt-1 text-xs">{t('auth.login.rateLimited')}</p>}
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

          <Field label={t('common.password')} error={errors.password?.message} required>
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
            {t('auth.login.submit')}
          </Button>

          <p className="text-center text-sm">
            <Link to="/forgot-password" className="font-medium text-accent hover:underline">
              {t('auth.login.forgotPassword')}
            </Link>
          </p>
        </form>

        {/* Renders nothing in English. */}
        <TranslationQualityNotice className="mt-5 text-center" />
      </div>
    </div>
  );
}
