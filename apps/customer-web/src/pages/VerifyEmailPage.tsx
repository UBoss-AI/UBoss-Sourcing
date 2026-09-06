/**
 * Confirming the email address a self-registered account was opened with.
 *
 * The customer arrives from `/verify-email?token=…`, a link the backend built.
 * Unlike activation next door there is nothing to fill in — the link *is* the
 * whole interaction — so the page redeems it on arrival and spends its effort
 * on the three things that can be true afterwards:
 *
 *   - **Confirmed and open.** Where the deployment does not review sign-ups,
 *     the account is ACTIVE and the only thing left is to sign in.
 *   - **Confirmed and waiting.** Where it does, the account is real but a
 *     colleague has to say yes. Saying so plainly matters: somebody who is not
 *     told will keep trying the sign-in form and reading "incorrect".
 *   - **The link is no good.** Expired, already used, or wrong. Each has a
 *     different way out, and only the first two can be fixed by sending
 *     another — which this page offers, without ever confirming that the
 *     address it is offering to re-send to actually has an account.
 *
 * ## Why the token is redeemed behind a ref guard
 *
 * The token is single use, and `StrictMode` mounts every effect twice in
 * development. Without the guard the second run redeems a token the first run
 * already spent, and every developer's first test of this flow ends on
 * "this link has already been used" — a bug in the page, indistinguishable
 * from a bug in the backend.
 *
 * ## Why it does not sign anybody in
 *
 * It cannot: this page has the token, not the password. The password was
 * chosen on the registration form, possibly on another device, and the one
 * thing this flow must not do is invent a way in that does not need it.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSearchParams } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { Button, ButtonLink, Field, Input, Spinner } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { ApiError, NetworkError, api } from '@/lib/api';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

interface VerifyResponse {
  verified: boolean;
  email: string;
  status: 'ACTIVE' | 'PENDING_APPROVAL';
}

/** Failures a fresh link would fix. Anything else, another link will not help. */
const RESENDABLE_CODES = new Set(['TOKEN_EXPIRED', 'TOKEN_ALREADY_USED']);

type State =
  | { kind: 'verifying' }
  | { kind: 'verified'; status: 'ACTIVE' | 'PENDING_APPROVAL' }
  | { kind: 'failed'; code: string; message: string };

export function VerifyEmailPage(): React.JSX.Element {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const { business } = useStorefront();
  const { t } = useI18n();

  const [state, setState] = useState<State>(
    token === ''
      ? { kind: 'failed', code: 'TOKEN_INVALID', message: t('auth.verify.noToken') }
      : { kind: 'verifying' },
  );

  useDocumentMeta({ title: t('auth.verify.pageTitle'), noIndex: true }, business.displayName);

  // See the note at the top of the file: single-use token, double-mounted
  // effect. The ref is what keeps the two apart.
  const redeemed = useRef(false);

  useEffect(() => {
    if (token === '' || redeemed.current) return;
    redeemed.current = true;

    const run = async (): Promise<void> => {
      try {
        const result = await api.post<VerifyResponse>('/auth/verify-email', { token });
        setState({ kind: 'verified', status: result.status });
      } catch (error) {
        if (error instanceof NetworkError) {
          setState({ kind: 'failed', code: 'NETWORK', message: error.message });
          return;
        }

        if (error instanceof ApiError) {
          setState({ kind: 'failed', code: error.code, message: error.message });
          return;
        }

        setState({ kind: 'failed', code: 'UNKNOWN', message: t('auth.verify.failed') });
      }
    };

    void run();
  }, [token, t]);

  if (state.kind === 'verifying') {
    return (
      <div className="mx-auto flex w-full max-w-md items-center justify-center py-16">
        <Spinner className="h-6 w-6 text-ink-subtle" />
        <span className="sr-only" role="status">
          {t('auth.verify.checking')}
        </span>
      </div>
    );
  }

  if (state.kind === 'verified') {
    return <Confirmed status={state.status} />;
  }

  return <Failure code={state.code} message={state.message} />;
}

// ---------------------------------------------------------------------------

function Confirmed({ status }: { status: 'ACTIVE' | 'PENDING_APPROVAL' }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="mx-auto w-full max-w-md py-8">
      <div className="rounded-lg border border-success/30 bg-success-soft p-6 text-center">
        <h1 className="text-lg font-semibold text-success">
          {status === 'ACTIVE'
            ? t('auth.verify.readyHeading')
            : t('auth.verify.pendingApprovalHeading')}
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-ink">
          {status === 'ACTIVE' ? t('auth.verify.readyBody') : t('auth.verify.pendingApprovalBody')}
        </p>

        <div className="mt-6 flex justify-center gap-2">
          {status === 'ACTIVE' ? (
            <ButtonLink to="/login" variant="primary">
              {t('auth.verify.signIn')}
            </ButtonLink>
          ) : (
            // Nothing for them to do here, so the useful button is the one back
            // to the catalogue. Prices are public; only ordering is not.
            <ButtonLink to="/products" variant="primary">
              {t('auth.verify.browseProducts')}
            </ButtonLink>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** What the reader should do next, per failure the server can report. */
function recoveryFor(
  code: string,
  t: ReturnType<typeof useI18n>['t'],
): { title: string; body: string } {
  switch (code) {
    case 'TOKEN_EXPIRED':
      return { title: t('auth.verify.expiredTitle'), body: t('auth.verify.expiredBody') };
    case 'TOKEN_ALREADY_USED':
      return { title: t('auth.verify.usedTitle'), body: t('auth.verify.usedBody') };
    case 'TOKEN_INVALID':
      return { title: t('auth.verify.invalidTitle'), body: t('auth.verify.invalidBody') };
    case 'ACCOUNT_DEACTIVATED':
      return { title: t('auth.verify.deactivatedTitle'), body: t('auth.verify.deactivatedBody') };
    default:
      return { title: t('auth.verify.failedTitle'), body: t('auth.verify.failedBody') };
  }
}

function Failure({ code, message }: { code: string; message: string }): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const recovery = recoveryFor(code, t);

  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resend = async (): Promise<void> => {
    if (email.trim() === '') {
      setError(t('validation.emailRequired'));
      return;
    }

    setSending(true);
    setError(null);

    try {
      await api.post('/auth/verify-email/resend', { email: email.trim() });
      // Shown whatever the server found. It answers uniformly on purpose, and a
      // page that said "no such account" here would put back the enumeration
      // leak the endpoint removes.
      setSent(true);
    } catch (resendError) {
      setError(
        resendError instanceof ApiError || resendError instanceof NetworkError
          ? resendError.message
          : t('auth.verify.resendFailed'),
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-md py-8">
      <div
        role="alert"
        className="rounded-lg border border-border bg-surface p-6 text-center shadow-card"
      >
        <h1 className="text-lg font-semibold text-ink">{recovery.title}</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-ink-muted">{recovery.body}</p>
        {/* The server's own wording, kept alongside ours rather than replacing
            it — it sometimes carries a detail the generic copy cannot. */}
        <p className="mt-2 text-xs text-ink-subtle">{message}</p>
      </div>

      {RESENDABLE_CODES.has(code) && (
        <div className="mt-5 rounded-lg border border-border bg-surface p-5">
          {sent ? (
            <p role="status" className="text-center text-sm text-ink-muted">
              {t('auth.verify.resent')}
            </p>
          ) : (
            <>
              <h2 className="text-sm font-medium text-ink">{t('auth.verify.resendHeading')}</h2>
              <div className="mt-3 space-y-3">
                <Field label={t('common.emailAddress')} error={error ?? undefined}>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      type="email"
                      autoComplete="email"
                      value={email}
                      aria-describedby={describedBy}
                      invalid={error !== null}
                      onChange={(event) => {
                        setEmail(event.target.value);
                      }}
                    />
                  )}
                </Field>

                <Button
                  variant="primary"
                  fullWidth
                  isLoading={sending}
                  onClick={() => {
                    void resend();
                  }}
                >
                  {t('auth.verify.resend')}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Link
          to="/login"
          className="inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-hover"
        >
          {t('auth.verify.goToSignIn')}
        </Link>
        {business.supportEmail !== null && (
          <a
            href={`mailto:${business.supportEmail}?subject=Email%20confirmation`}
            className="inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-hover"
          >
            {t('auth.verify.contactSupport')}
          </a>
        )}
      </div>
    </div>
  );
}
