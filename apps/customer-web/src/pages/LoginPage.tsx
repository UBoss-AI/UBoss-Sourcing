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
 * The frame is `AuthSplit`: from `lg` up the form takes the right half and a
 * turning earth takes the left. That panel is decoration and is `aria-hidden`
 * — every word and every control on this screen is in the column below, and
 * the page is finished on a phone, on a machine with no WebGL and with the
 * chunk behind the globe still in flight.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
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

interface LocationState {
  from?: string;
}

/**
 * Where to go once they are in.
 *
 * Two spellings reach this page and both are in use:
 *
 *   - router state (`state.from`), set by `RequireCustomer`, the service
 *     banner, the product page and AI Mode's sign-in panel;
 *   - `?next=`, in the Seller Hub's plain links, which are `<a href>`s with
 *     nowhere to hang router state.
 *
 * The second was being ignored, so pressing "Sign in" on the Sell page landed
 * somebody on the home page having forgotten what they came for.
 *
 * **Same-origin paths only.** An open redirect is a phishing primitive: a link
 * to our own sign-in page that hands the visitor to somebody else's site
 * afterwards borrows this shop's credibility for it. Anything that is not a
 * single leading slash - `//evil.example`, `https://…`, a backslash Windows
 * clients normalise into a slash - is discarded rather than corrected.
 */
function returnTarget(state: unknown, search: string): string {
  const candidate =
    (state as LocationState | null)?.from ?? new URLSearchParams(search).get('next') ?? null;

  if (candidate === null) return '/';

  // One leading slash, and the next character must not be another slash or a
  // backslash: `//evil.example` is a protocol-relative URL, and `/\evil.example`
  // is the same thing after a browser normalises the backslash.
  if (!/^\/(?![/\\])/.test(candidate)) return '/';

  return candidate;
}

export function LoginPage(): React.JSX.Element {
  const { user, isCustomer, isLoading, login } = useSession();
  const { business, features } = useStorefront();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();

  const [formError, setFormError] = useState<string | null>(null);

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
      await login(values.email, values.password);
      void navigate(returnTarget(location.state, location.search), { replace: true });
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
          {user === null ? t('auth.login.introVisitor') : t('auth.login.introStaff')}
        </p>

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

        <AuthDivider className="my-8" />

        <div className="text-sm">
          <h2 className="font-medium text-ink">{t('auth.login.noAccountHeading')}</h2>

          {features.selfRegistration ? (
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
