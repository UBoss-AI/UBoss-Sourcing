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
 *
 * The terms have to be accepted on every sign-in, not remembered from the
 * last one. Nothing is stored to say "this browser already agreed", because a
 * consent that carries itself forward is a consent nobody gave this time.
 *
 * Two tabs, Individual and Company, over one form. The tab is an INTENT sent
 * with the credentials, never an authority: the backend decides, after the
 * password is accepted, whether this person may act for a company at all -
 * and a failed sign-in is the same generic message on both tabs. Individual is
 * the default; `?buyerType=company` deep-links the other, and the choice
 * survives a validation error because it lives in the URL, not the form.
 *
 * The frame is `AuthSplit`: from `lg` up the form takes the right half and a
 * turning earth takes the left. That panel is decoration and is `aria-hidden`
 * — every word and every control on this screen is in the column below, and
 * the page is finished on a phone, on a machine with no WebGL and with the
 * chunk behind the globe still in flight.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { AcceptTermsCheckbox } from '@/components/AcceptTermsCheckbox';
import { DemoLoginPanel } from '@/components/DemoLoginPanel';
import { Button, Field, Spinner } from '@/components/ui';
import {
  AuthCard,
  AuthDivider,
  BottomGradient,
  GRADIENT_CTA,
  GlowInput,
} from '@/components/ui/auth-form';
import { AuthSplit } from '@/components/ui/auth-split';
import { Tabs } from '@/components/ui/Tabs';
import type { BuyerType } from '@/auth/session-context';
import { returnTarget } from '@/lib/return-target';
import { useI18n } from '@/i18n/i18n-context';
import { LanguageSwitcher, TranslationQualityNotice } from '@/i18n/LanguageSwitcher';
import { ApiError, NetworkError } from '@/lib/api';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { errorMessage } from '@/lib/errors';

/**
 * Built per render rather than once at module scope, because the messages
 * inside it are translated and the module is evaluated long before a language
 * has been resolved. A schema frozen at import time would report every
 * validation failure in whatever language the first visitor happened to load.
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

type FormValues = z.output<ReturnType<typeof buildSchema>>;

/** The tab a URL asks for. Anything but `company` is the individual tab. */
function buyerTypeFrom(search: string, companiesOffered: boolean): BuyerType {
  return companiesOffered && new URLSearchParams(search).get('buyerType') === 'company'
    ? 'company'
    : 'individual';
}

export function LoginPage(): React.JSX.Element {
  const { user, isCustomer, isLoading, login } = useSession();
  const { business, features } = useStorefront();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();

  const [formError, setFormError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const companiesOffered = features.buyerCompanies === true;
  const buyerType = buyerTypeFrom(`?${searchParams.toString()}`, companiesOffered);

  const chooseTab = (next: BuyerType): void => {
    const params = new URLSearchParams(searchParams);
    if (next === 'company') params.set('buyerType', 'company');
    else params.delete('buyerType');
    // Replace, so Back leaves the page rather than flipping between tabs.
    setSearchParams(params, { replace: true, state: location.state as unknown });
  };

  // The failure is kept as a code plus its retry window, not as a rendered
  // sentence. Somebody who has just failed to sign in and reached for the
  // language picker is precisely the person who needs this line re-rendered in
  // the language they picked, and a string translated once and parked in state
  // would stay in the old one.
  const [helpCode, setHelpCode] = useState<{
    code: string;
    retryAfterSeconds: number | null;
  } | null>(null);

  useDocumentMeta({ title: t('auth.login.pageTitle'), noIndex: true }, business.displayName);

  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(buildSchema(t)),
    // Never pre-ticked. `false` is not assignable to the `true` the schema
    // demands, which is the point: the form starts in a state it refuses to
    // submit until the customer acts.
    defaultValues: { email: '', password: '', acceptedTerms: false as never },
  });

  useEffect(() => {
    setFocus('email');
  }, [setFocus]);

  if (isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-ink-subtle" />
        <span className="sr-only" role="status">
          {t('auth.login.checkingSession')}
        </span>
      </div>
    );
  }

  if (isCustomer) {
    return <Navigate to={returnTarget(location.state, location.search)} replace />;
  }

  /**
   * The help line under a failed sign-in, rendered fresh each time so it
   * follows the current language.
   *
   * Each branch has a different next action, which is why the codes are not
   * collapsed into one generic message.
   */
  const extraHelp = ((): string | null => {
    if (helpCode === null) return null;

    switch (helpCode.code) {
      case 'RATE_LIMITED':
        return helpCode.retryAfterSeconds === null
          ? t('auth.login.rateLimited')
          : // Counted, not a template string: "minute(s)" has no equivalent in
            // Polish, which takes a different ending at 1, at 2-4 and at 5
            // upwards. i18next reads `count` and picks the form.
            t('auth.login.rateLimitedFor', {
              count: Math.ceil(helpCode.retryAfterSeconds / 60),
            });
      case 'ACCOUNT_NOT_ACTIVATED':
        return t('auth.login.notActivated');
      case 'EMAIL_NOT_VERIFIED':
        return t('auth.login.emailNotVerified');
      case 'ACCOUNT_PENDING_APPROVAL':
        return t('auth.login.pendingApproval');
      case 'ACCOUNT_LOCKED':
        return t('auth.login.locked');
      case 'ACCOUNT_DEACTIVATED':
        return business.supportEmail === null
          ? t('auth.login.deactivated')
          : t('auth.login.deactivatedContact', {
              email: business.supportEmail,
            });
      default:
        return null;
    }
  })();

  const onSubmit = async (values: FormValues): Promise<void> => {
    setFormError(null);
    setHelpCode(null);

    try {
      // `acceptedTerms` gates the submit and is not sent: `/auth/login` takes
      // an email and a password, and the acceptance that is recorded against
      // an account is the one given at registration or activation.
      const { next } = companiesOffered
        ? await login(values.email, values.password, buyerType)
        : await login(values.email, values.password);
      const target = returnTarget(location.state, location.search);
      // Several companies, or none: the selector decides with the person,
      // after sign-in. Everyone else goes straight to where they were going.
      if (next === 'CHOOSE_COMPANY' || next === 'NO_COMPANY') {
        void navigate('/select-company', { replace: true, state: { from: target, next } });
      } else {
        void navigate(target, { replace: true });
      }
    } catch (error) {
      if (error instanceof NetworkError) {
        setFormError(errorMessage(t, error));
        return;
      }

      if (error instanceof ApiError) {
        setFormError(error.message);

        // Each of these has a different next action, and leaving a customer to
        // guess which one applies is how a support call starts.
        if (error.isRateLimited) {
          setHelpCode({
            code: 'RATE_LIMITED',
            retryAfterSeconds: error.retryAfterSeconds,
          });
        } else if (
          error.code === 'ACCOUNT_NOT_ACTIVATED' ||
          error.code === 'EMAIL_NOT_VERIFIED' ||
          error.code === 'ACCOUNT_PENDING_APPROVAL' ||
          error.code === 'ACCOUNT_LOCKED' ||
          error.code === 'ACCOUNT_DEACTIVATED'
        ) {
          setHelpCode({ code: error.code, retryAfterSeconds: null });
        }
        return;
      }

      setFormError(t('auth.login.failed'));
    }
  };

  return (
    <AuthSplit>
      {/* Above the form, not tucked into the footer. Somebody who cannot read
          the interface cannot navigate to a setting buried inside it, so the
          first screen they land on is the one that has to offer the way out.
          The choice is remembered and carried into the session on sign-in. */}
      <LanguageSwitcher placement="auth" />

      {/* Title, form and the way to an account are one card, not three
          stacked panels: everything a visitor who cannot get in needs to read
          is inside one boundary. */}
      <AuthCard className="mt-2">
        <h1 className="text-xl font-bold text-ink">{t('auth.login.heading')}</h1>
        <p className="mt-2 max-w-sm text-sm text-ink-muted">
          {/* Reaching here means not signed in as a customer. A user object
              that still exists is therefore a staff session, which cannot
              shop — saying so beats an unexplained sign-in form. */}
          {user !== null
            ? t('auth.login.introStaff')
            : buyerType === 'company'
              ? t('auth.login.introCompany')
              : t('auth.login.introVisitor')}
        </p>

        <LoginTabs offered={companiesOffered} value={buyerType} onChange={chooseTab} label={t('auth.login.tabsLabel')} individual={t('auth.login.tabIndividual')} company={t('auth.login.tabCompany')}>
        <form
          onSubmit={(event) => {
            void handleSubmit(onSubmit)(event);
          }}
          noValidate
          className="my-8 space-y-4"
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
              <div className="relative">
                <GlowInput
                  id={inputId}
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  aria-describedby={describedBy}
                  invalid={errors.password !== undefined}
                  className="pr-20"
                  {...register('password')}
                />
                {/* A real button with a state, not an icon: its name says
                    what pressing it will do, and aria-pressed says which way
                    round it is now. */}
                <button
                  type="button"
                  aria-controls={inputId}
                  aria-pressed={showPassword}
                  onClick={() => {
                    setShowPassword((shown) => !shown);
                  }}
                  className="absolute inset-y-0 right-1 my-1 rounded-md px-2.5 text-xs font-medium text-brand hover:bg-brand-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                  {showPassword ? t('auth.login.hidePassword') : t('auth.login.showPassword')}
                </button>
              </div>
            )}
          </Field>

          {/* Above the button, not below it. The tick is a condition of signing
              in, so it has to be read before the thing it gates. */}
          <AcceptTermsCheckbox
            label={t('auth.login.acceptTerms')}
            error={errors.acceptedTerms?.message}
            errorId="login-terms-error"
            {...register('acceptedTerms')}
          />

          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            isLoading={isSubmitting}
            className={GRADIENT_CTA}
          >
            {t('auth.login.submit')}
            {/* Decoration, and hidden as such. In the accessible name this
                button is "Sign in", not "Sign in right arrow". */}
            <span aria-hidden="true">&rarr;</span>
            <BottomGradient />
          </Button>

          <p className="text-center text-sm">
            <Link to="/forgot-password" className="font-medium text-brand hover:underline">
              {t('auth.login.forgotPassword')}
            </Link>
          </p>
        </form>
        </LoginTabs>

        <AuthDivider className="my-8" />

        <div className="text-sm">
          <h2 className="font-medium text-ink">{t('auth.login.noAccountHeading')}</h2>

          {features.selfRegistration && buyerType === 'company' ? (
            <p className="mt-1.5 text-ink-muted">
              <Link to="/register/company" className="font-medium text-brand hover:underline">
                {t('auth.login.createCompany')}
              </Link>{' '}
              {t('auth.login.createCompanySuffix')}
            </p>
          ) : features.selfRegistration ? (
            <p className="mt-1.5 text-ink-muted">
              <Link to="/register" className="font-medium text-brand hover:underline">
                {t('auth.login.createOne')}
              </Link>{' '}
              {t('auth.login.createOneSuffix')}
            </p>
          ) : (
            <p className="mt-1.5 text-ink-muted">
              {t('auth.login.inviteOnly')}
              {business.supportEmail !== null && (
                <>
                  {' '}
                  {t('auth.login.inviteOnlyNotReceived')}{' '}
                  <a
                    href={`mailto:${business.supportEmail}`}
                    className="font-medium text-brand hover:underline"
                  >
                    {t('auth.login.getInTouch')}
                  </a>
                  .
                </>
              )}
            </p>
          )}
        </div>
      </AuthCard>

      {/* Renders nothing unless this build was given demo accounts, which is
          every build except a demonstration one. */}
      <DemoLoginPanel
        emailLabel={t('common.emailAddress')}
        passwordLabel={t('common.password')}
      />

      {/* Sits at the bottom of the first screen a customer sees, which is
          where a wording complaint is most likely to be worth acting on.
          Renders nothing in English. */}
      <TranslationQualityNotice className="mt-5 text-center" />
    </AuthSplit>
  );
}

/**
 * The two tabs over the form, or just the form where this deployment offers no
 * company accounts - a tablist with one tab is a control that does nothing.
 */
function LoginTabs({
  offered,
  value,
  onChange,
  label,
  individual,
  company,
  children,
}: {
  offered: boolean;
  value: BuyerType;
  onChange: (next: BuyerType) => void;
  label: string;
  individual: string;
  company: string;
  children: React.ReactNode;
}): React.JSX.Element {
  if (!offered) return <>{children}</>;
  return (
    <Tabs
      className="mt-6"
      label={label}
      value={value}
      onChange={onChange}
      tabs={[
        { key: 'individual', label: individual },
        { key: 'company', label: company },
      ]}
    >
      {children}
    </Tabs>
  );
}
