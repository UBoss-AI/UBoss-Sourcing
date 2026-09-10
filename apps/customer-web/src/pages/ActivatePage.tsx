/**
 * Invitation activation.
 *
 * The customer arrives from an emailed link the backend built:
 * `/activate?token=…`. Everything about this screen is shaped by the fact that
 * the token might be expired, already used, or simply wrong — and a customer
 * who cannot tell which is stuck.
 *
 * Two decisions worth keeping:
 *
 *   - **The token is never validated by a separate "check" call first.** There
 *     is no such endpoint, and adding a client-side guess would create a second
 *     source of truth. The form submits, and the server's own error code
 *     decides what the customer is told and what they can do about it.
 *   - **Nobody but the account holder sets the password.** There is no path
 *     here that accepts a password chosen by anyone else — that is the whole
 *     point of the invitation flow.
 *
 * The password rules mirror the backend's `passwordSchema`. They are shown
 * *before* the customer types, not as a rejection afterwards.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { AcceptTermsCheckbox } from '@/components/AcceptTermsCheckbox';
import { Button, ButtonLink, Field, Input } from '@/components/ui';
import { ApiError, NetworkError, api } from '@/lib/api';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import type { Translate } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';

/**
 * Mirrors the backend's password policy.
 *
 * Duplicated deliberately, and it is the *only* rule duplicated in this app:
 * a customer setting a password should be told the requirement as they type,
 * not have their submission rejected. The server enforces the same policy, so
 * a drift here costs a confusing message, never a weak password.
 */
function buildSchema(t: Translate) {
  const passwordSchema = z
    .string()
    .min(12, t('validation.passwordTooShort'))
    .max(128, t('validation.passwordTooLong'));

  return z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
    acceptedTerms: z.literal(true, {
      message: t('activatePage.acceptTermsToActivate'),
    }),
  })
  .refine((values) => values.password === values.confirmPassword, {
    path: ['confirmPassword'],
    message: t('validation.passwordsDoNotMatch'),
  });
}

type FormValues = z.output<ReturnType<typeof buildSchema>>;

/** Failures no amount of retyping can fix — the link itself is the problem. */
const TERMINAL_CODES = new Set([
  'TOKEN_EXPIRED',
  'TOKEN_ALREADY_USED',
  'INVITATION_ALREADY_ACCEPTED',
  'TOKEN_INVALID',
  'ACCOUNT_DEACTIVATED',
]);

/** What the customer should do next, per failure the server can report. */
function recoveryFor(
  t: Translate,
  code: string,
): {
  title: string;
  body: string;
  canRetry: boolean;
} {
  switch (code) {
    case 'TOKEN_EXPIRED':
      return {
        title: t('activatePage.invitationExpired'),
        body: t('activatePage.invitationExpiredBody'),
        canRetry: false,
      };
    case 'TOKEN_ALREADY_USED':
    case 'INVITATION_ALREADY_ACCEPTED':
      return {
        title: t('activatePage.invitationUsed'),
        body: t('activatePage.invitationUsedBody'),
        canRetry: false,
      };
    case 'TOKEN_INVALID':
      return {
        title: t('activatePage.linkNotValid'),
        body: t('activatePage.linkNotValidBody'),
        canRetry: false,
      };
    case 'ACCOUNT_DEACTIVATED':
      return {
        title: t('activatePage.accountNoLongerActive'),
        body: t('activatePage.pleaseContactUs'),
        canRetry: false,
      };
    default:
      return {
        title: t('activatePage.couldNotActivate'),
        body: t('activatePage.somethingWentWrongAtOurEnd'),
        canRetry: true,
      };
  }
}

function Failure({
  code,
  message,
  onRetry,
}: {
  code: string;
  message: string;
  onRetry: () => void;
}): React.JSX.Element {
  const { t } = useI18n();

  const { business } = useStorefront();
  const recovery = recoveryFor(t, code);

  return (
    <div
      role="alert"
      className="rounded-lg border border-border bg-surface p-6 text-center shadow-card"
    >
      <h1 className="text-lg font-semibold text-ink">{recovery.title}</h1>
      <p className="mx-auto mt-2 max-w-sm text-sm text-ink-muted">{recovery.body}</p>
      {/* The server's own wording, kept alongside ours rather than replacing
          it — it sometimes carries a detail the generic copy cannot. */}
      <p className="mt-2 text-xs text-ink-subtle">{message}</p>

      <div className="mt-6 flex flex-wrap justify-center gap-2">
        {recovery.canRetry && (
          <Button variant="primary" onClick={onRetry}>
            {t('activatePage.tryAgain')}
          </Button>
        )}
        <Link
          to="/login"
          className="inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-hover"
        >
          {t('activatePage.goToSignIn')}
        </Link>
        {business.supportEmail !== null && (
          <a
            href={`mailto:${business.supportEmail}?subject=Account%20activation`}
            className="inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-hover"
          >
            {t('activatePage.contactSupport')}
          </a>
        )}
      </div>
    </div>
  );
}

export function ActivatePage(): React.JSX.Element {
  const { t } = useI18n();

  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const navigate = useNavigate();
  const { login } = useSession();
  const { business } = useStorefront();

  const [failure, setFailure] = useState<{
    code: string;
    message: string;
  } | null>(null);

  /**
   * null      still on the form
   * activated the account works, but the automatic sign-in did not
   * signed-in  activated and signed in — the ordinary path
   */
  const [outcome, setOutcome] = useState<'activated' | 'signed-in' | null>(null);

  useDocumentMeta({ title: t('activatePage.activateYourAccount'), noIndex: true }, business.displayName);

  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(buildSchema(t)),
    defaultValues: {
      password: '',
      confirmPassword: '',
      acceptedTerms: false as never,
    },
  });

  useEffect(() => {
    if (token !== '') setFocus('password');
  }, [token, setFocus]);

  // A link with no token at all never reaches the server — there is nothing to
  // send, and a round trip would only produce the same answer more slowly.
  if (token === '') {
    return (
      <div className="mx-auto w-full max-w-md py-8">
        <Failure
          code="TOKEN_INVALID"
          message={t('activatePage.noActivationTokenWasFound')}
          onRetry={() => {
            void navigate('/login');
          }}
        />
      </div>
    );
  }

  if (outcome !== null) {
    return (
      <div className="mx-auto w-full max-w-md py-8">
        <div className="rounded-lg border border-success/30 bg-success-soft p-6 text-center">
          <h1 className="text-lg font-semibold text-success">
            {t('activatePage.yourAccountIsReady')}
          </h1>
          <p className="mt-2 text-sm text-ink">
            {outcome === 'signed-in'
              ? t('activatePage.signedInStartOrdering')
              : t('activatePage.signInWithPasswordJustChosen')}
          </p>
          <div className="mt-6 flex justify-center gap-2">
            {outcome === 'signed-in' ? (
              <ButtonLink to="/products" variant="primary">
                {t('activatePage.browseProducts')}
              </ButtonLink>
            ) : (
              <Link
                to="/login"
                className="inline-flex h-10 items-center rounded-md bg-brand-fill px-5 text-sm font-medium text-white hover:bg-brand-fill-hover"
              >
                {t('activatePage.goToSignIn')}
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  const onSubmit = async (values: FormValues): Promise<void> => {
    setFailure(null);

    try {
      const result = await api.post<{ activated: boolean; email: string }>(
        '/auth/invitations/accept',
        {
          token,
          password: values.password,
          acceptedTerms: values.acceptedTerms,
        },
      );

      // Activation deliberately issues no session — the endpoint's own message
      // is "you can now sign in". Rather than sending the customer to a form to
      // retype the password they chose one second ago, sign them in here.
      try {
        await login(result.email, values.password);
        setOutcome('signed-in');
      } catch {
        // The account is genuinely active; only the convenience sign-in failed.
        // Saying so is honest, and the sign-in page still works.
        setOutcome('activated');
      }
    } catch (error) {
      if (error instanceof NetworkError) {
        setFailure({ code: 'NETWORK', message: errorMessage(t, error) });
        return;
      }

      if (error instanceof ApiError) {
        setFailure({ code: error.code, message: error.message });
        return;
      }

      setFailure({ code: 'UNKNOWN', message: t('activatePage.activationFailed') });
    }
  };

  // A token problem is terminal for this page — there is nothing useful to
  // type, so the form is replaced by a recovery panel. A validation problem is
  // not terminal, so the form stays and the message sits above it.
  const isTerminal = failure !== null && TERMINAL_CODES.has(failure.code);

  if (failure !== null && isTerminal) {
    return (
      <div className="mx-auto w-full max-w-md py-8">
        <Failure
          code={failure.code}
          message={failure.message}
          onRetry={() => {
            setFailure(null);
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-md py-8">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">
          {t('activatePage.activateYourAccount')}
        </h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          {t('activatePage.choosePasswordOnlyYou', { store: business.displayName })}
        </p>
      </div>

      <form
        onSubmit={(event) => {
          void handleSubmit(onSubmit)(event);
        }}
        noValidate
        className="space-y-4 rounded-lg border border-border bg-surface p-6 shadow-card"
      >
        {failure !== null && !isTerminal && (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
          >
            {failure.message}
          </div>
        )}

        <Field
          label={t('activatePage.chooseAPassword')}
          hint={t('activatePage.atLeast12CharactersA')}
          error={errors.password?.message}
          required
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              invalid={errors.password !== undefined}
              {...register('password')}
            />
          )}
        </Field>

        <Field
          label={t('activatePage.confirmYourPassword')}
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

        <AcceptTermsCheckbox
          label={t('activatePage.iAcceptTheTerms')}
          error={errors.acceptedTerms?.message}
          errorId="terms-error"
          {...register('acceptedTerms')}
        />

        <Button type="submit" variant="primary" size="lg" fullWidth isLoading={isSubmitting}>
          {t('activatePage.activateMyAccount')}
        </Button>
      </form>
    </div>
  );
}
