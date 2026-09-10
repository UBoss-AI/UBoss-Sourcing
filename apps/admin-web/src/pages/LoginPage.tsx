/**
 * Sign in.
 *
 * The one rule specific to this screen: a failed sign-in never says *which*
 * half was wrong. The backend returns one message for an unknown email and a
 * wrong password alike, because distinguishing them turns the form into a
 * way to enumerate who has an account. This page shows what the server said
 * and adds nothing.
 *
 * The terms are accepted on every sign-in, not remembered from the last one.
 * Nothing is stored to say "this browser already agreed": a console is shared
 * by several staff accounts behind nothing but a password, so a tick carried
 * forward would be one person's acceptance shown to the next.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { Button, Checkbox, Field, Input, Spinner } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { LanguageSwitcher, TranslationQualityNotice } from '@/i18n/LanguageSwitcher';
import { ApiError, NetworkError, api } from '@/lib/api';

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
    // `literal(true)` rather than a boolean with a refinement: an unticked box
    // is not a value the form may submit at all, so the type says so.
    acceptedTerms: z.literal(true, { message: t('validation.acceptTermsToSignIn') }),
  });
}

type FormValues = z.infer<ReturnType<typeof buildSchema>>;

interface LocationState {
  from?: string;
}

/**
 * The part of the public config this screen reads.
 *
 * `policyLinks` is whatever the operator has put in the business profile — a
 * label and a URL each, named by them. This panel holds no opinion about what
 * a policy is called or where it lives, which is the whole point: the deployed
 * product is somebody else's business, and its terms are its own.
 */
interface PolicyConfigResponse {
  business: {
    policyLinks: Record<string, string> | null;
  };
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

  // The same query key the rest of the panel uses, so the config document is
  // fetched once. Unauthenticated on purpose — this screen needs it before a
  // session exists, which is why `/config` is public.
  const config = useQuery({
    queryKey: ['storefront-config'],
    queryFn: () => api.get<PolicyConfigResponse>('/config'),
    staleTime: 5 * 60_000,
    // A config read must never take the sign-in screen down with it. Without
    // it the tick still works; it simply has no links beside it, which is the
    // state a deployment that has set no policies is in anyway.
    retry: false,
  });

  const policies = Object.entries(config.data?.business.policyLinks ?? {});

  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(buildSchema(t)),
    // Never pre-ticked. `false` is not assignable to the `true` the schema
    // demands, which is the point: the form starts in a state it refuses to
    // submit until somebody acts.
    defaultValues: { email: '', password: '', acceptedTerms: false as never },
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
      // `acceptedTerms` gates the submit and is not sent: `/auth/login` takes
      // an email and a password, and adding a field the endpoint does not
      // declare would be rejected by its schema.
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
            className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-fill text-sm font-bold text-white"
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

          {/* Above the button, not below it. The tick is a condition of
              signing in, so it has to be read before the thing it gates. */}
          <div>
            <label className="flex cursor-pointer items-start gap-2.5 text-sm text-ink">
              <Checkbox
                className="mt-0.5"
                aria-describedby={errors.acceptedTerms === undefined ? undefined : 'terms-error'}
                {...register('acceptedTerms')}
              />
              <span>
                {t('auth.login.acceptTerms')}
                {policies.length > 0 && (
                  <>
                    {' ('}
                    {policies.map(([label, href], index) => (
                      <span key={label}>
                        {index > 0 && ', '}
                        {/* A new tab, deliberately: somebody reading the terms
                            should not lose the email they have already
                            typed to do it. */}
                        <a
                          href={href}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="font-medium text-accent hover:underline"
                        >
                          {label}
                        </a>
                      </span>
                    ))}
                    {')'}
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
