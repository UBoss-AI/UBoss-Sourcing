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
 *
 * The frame is `AuthSplit`, the same one the storefront and the logistics
 * portal sign in through: from `lg` up the form takes the right half and a
 * turning earth takes the left. The panel is decoration and `aria-hidden` —
 * every word and control on this screen is in the column beside it, and the
 * page is finished on a narrow window and on a machine with no WebGL.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { Button, Field, Spinner } from '@/components/ui';
import { DemoLoginPanel } from '@/components/DemoLoginPanel';
import {
  AuthCard,
  AuthDivider,
  AuthTermsCheckbox,
  BottomGradient,
  GRADIENT_CTA,
  GlowInput,
} from '@/components/ui/auth-form';
import { AuthSplit } from '@/components/ui/auth-split';
import { useI18n } from '@/i18n/i18n-context';
import { LanguageSwitcher, TranslationQualityNotice } from '@/i18n/LanguageSwitcher';
import { ApiError, NetworkError, api } from '@/lib/api';
import { PARENT_ATTRIBUTION } from '@/lib/brand';

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
    /*
     * `min-h-screen` below `lg`, an exact window height from `lg` up.
     *
     * The exact height is what stops the turning earth on the left scrolling
     * away with the form: a frame that is precisely the window has nothing
     * below it to scroll to, and the form column inside takes the scrolling on
     * instead. This page is the whole document when it renders — there is no
     * admin chrome around a signed-out screen — so the window's height is the
     * frame's height with nothing to subtract.
     */
    <AuthSplit className="min-h-screen lg:h-[100dvh] lg:overflow-hidden">
      {/* On the first screen, not buried in a settings page inside the panel.
          A warehouse or finance user who cannot read English cannot navigate
          to a setting written in it, and this is the one screen they are
          guaranteed to reach. The choice carries into the session on
          sign-in. */}
      <LanguageSwitcher placement="auth" />

      {/* Title, form and the way to an account are one card, not three
          stacked panels: everything somebody who cannot get in needs to read
          is inside one boundary.

          NO MARK ABOVE THE TITLE. There used to be a "U" badge here and the
          storefront's sign-in has never had one, which made the two screens
          different at the first thing a reader looks at. The panel is already
          named by its heading and by the browser tab; a badge on one of three
          otherwise identical screens is a difference that says nothing. */}
      <AuthCard className="mt-2">
        <h1 className="text-xl font-bold text-ink">{t('auth.login.heading')}</h1>
        <p className="mt-2 max-w-sm text-sm text-ink-muted">{t('auth.login.subheading')}</p>

        <form
          onSubmit={(event) => void handleSubmit(onSubmit)(event)}
          noValidate
          className="my-8 space-y-4"
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
              <GlowInput
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
              <GlowInput
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
              signing in, so it has to be read before the thing it gates.

              The shared control from `auth-form.tsx`, which is where the same
              markup the storefront uses now lives. This screen had its own
              copy of it, identical but for `text-accent` where the storefront
              had `text-brand` — the exact drift a shared component exists to
              stop. The policies still come from this app's own `/config`
              query; only the markup is shared. */}
          <AuthTermsCheckbox
            label={t('auth.login.acceptTerms')}
            policies={policies}
            error={errors.acceptedTerms?.message}
            errorId="login-terms-error"
            {...register('acceptedTerms')}
          />

          {/* `size="lg"`, matching the storefront: its submit is the large
              one, and a button a step smaller on an otherwise identical card
              is the kind of difference nobody can name and everybody notices.

              Full width comes from a class rather than the storefront's
              `fullWidth` prop, which this app's `Button` does not carry. The
              rendered button is the same. The three `ui.tsx` copies are one
              brand system at three densities, not one API, and widening that
              component for a single call site would be a change to something
              sixty screens use. */}
          <Button
            type="submit"
            variant="primary"
            size="lg"
            isLoading={isSubmitting}
            className={`w-full ${GRADIENT_CTA}`}
          >
            {t('auth.login.submit')}
            {/* Decoration, and hidden as such. In the accessible name this
                  button is "Sign in", not "Sign in right arrow". */}
            <span aria-hidden="true">&rarr;</span>
            <BottomGradient />
          </Button>

          {/* Inside the form and under the button, where the storefront puts
              it. It belongs to the password field above it, not to the
              "who can have an account" block below the divider. */}
          <p className="text-center text-sm">
            <Link to="/forgot-password" className="font-medium text-brand hover:underline">
              {t('auth.login.forgotPassword')}
            </Link>
          </p>
        </form>

        <AuthDivider className="my-8" />

        {/* The same block the storefront closes with, answering the same
            question — "what if I have no account?" — with this surface's own
            answer. A staff account is created by an administrator; there has
            never been a way to sign yourself up for one, and a screen that
            simply omits the question leaves somebody hunting for a button that
            does not exist. */}
        <div className="text-sm">
          <h2 className="font-medium text-ink">{t('auth.login.noAccountHeading')}</h2>
          <p className="mt-1.5 text-ink-muted">{t('auth.login.staffAccountsAreCreated')}</p>
        </div>
      </AuthCard>

      {/* Renders nothing unless this build was given demo accounts, which is
          every build except a demonstration one. */}
      <DemoLoginPanel
        emailLabel={t('common.emailAddress')}
        passwordLabel={t('common.password')}
      />

      {/* Renders nothing in English. */}
      <TranslationQualityNotice className="mt-5 text-center" />

      {/*
        The attribution, as small print at the foot of the column.

        NOT a mark above the title, and the note on the card above says why:
        there used to be a "U" badge there, the storefront's sign-in has never
        had one, and a badge on one of three otherwise identical screens is a
        difference that says nothing. The product is named in the heading —
        "Sign in to Glovia Admin" — and in the browser tab. What was missing
        was who stands behind it, and small print at the bottom is where that
        belongs on a sign-in screen rather than competing with the field
        somebody came here to type in.
      */}
      <p className="mt-5 text-center text-xxs font-medium uppercase tracking-[0.14em] text-ink-subtle">
        {PARENT_ATTRIBUTION}
      </p>
    </AuthSplit>
  );
}
