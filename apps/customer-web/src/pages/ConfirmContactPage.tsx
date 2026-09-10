/**
 * Where a contact-change link lands.
 *
 * One page for both purposes — a new email address and a new telephone number
 * — because the flow is identical and the only difference is which endpoint
 * promotes the pending value. Which one it is travels in the URL beside the
 * token (`?kind=email`), put there by `buildTokenUrl` on the server. That
 * parameter is a hint and is never trusted: the token carries its own purpose
 * and the server refuses a mismatch outright, so a tampered `kind` gets a
 * rejected token rather than the wrong change.
 *
 * Two things this has to get right.
 *
 * **It confirms once, and it says which state it is in.** A verification page
 * that silently re-posts on a React remount spends the token and then reports
 * "already used" for a link that had just worked. The request fires from an
 * effect guarded by a ref, so a double render in development, a fast refresh
 * and a Strict Mode remount all still send exactly one.
 *
 * **Confirming an email address signs every session out, including this one.**
 * That is correct — the address is the sign-in identity — and the page has to
 * be honest about it rather than leaving somebody to discover it when the next
 * click 401s. On success it says so and offers the way back in, with the new
 * address stated so they know which one to type.
 *
 * A signed-out visitor gets sign-in first: the endpoints are behind the session
 * guard, and the check that the token belongs to the signed-in account is
 * defence in depth worth keeping. The link still works after signing in with
 * the OLD address, which is exactly the point of not promoting it early.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { ButtonLink, Card, PageHeader, Spinner } from '@/components/ui';
import { AlertIcon, CheckIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';

type Kind = 'email' | 'phone';
type State = 'confirming' | 'done' | 'failed';

function kindFrom(raw: string | null): Kind {
  // Anything unrecognised is treated as the email flow, which is the one the
  // link is overwhelmingly for. The server decides in the end: an email
  // endpoint handed a phone token refuses it.
  return raw === 'phone' ? 'phone' : 'email';
}

export function ConfirmContactPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const { isCustomer, isLoading } = useSession();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const location = useLocation();

  useDocumentMeta({ title: t('confirmContact.title'), noIndex: true }, business.displayName);

  const token = searchParams.get('token');
  const kind = kindFrom(searchParams.get('kind'));

  const [state, setState] = useState<State>('confirming');
  const [message, setMessage] = useState<string | null>(null);
  const [value, setValue] = useState<string | null>(null);

  // One request, whatever React does with the component.
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    // Wait for the session to settle: firing while `/auth/me` is still in
    // flight would spend the token on a request that is about to 401.
    if (isLoading) return;
    if (token === null || token === '') {
      setState('failed');
      setMessage(t('confirmContact.noToken'));
      sent.current = true;
      return;
    }
    if (!isCustomer) return;

    sent.current = true;

    const path = kind === 'phone' ? '/account/phone-change/confirm' : '/account/email-change/confirm';

    void api
      .post<{ email?: string; phone?: string }>(path, { token })
      .then(async (response) => {
        setValue(response.email ?? response.phone ?? null);
        setState('done');

        // The profile read is now wrong wherever it is cached — the header
        // button, the sidebar and the profile panels all read it.
        await queryClient.invalidateQueries({ queryKey: ['account-profile'] });
      })
      .catch((error: unknown) => {
        setState('failed');
        setMessage(errorMessage(t, error, t('confirmContact.couldNotConfirm')));
      });
  }, [isCustomer, isLoading, kind, queryClient, t, token]);

  // --- Not signed in ------------------------------------------------------
  if (!isLoading && !isCustomer) {
    return (
      <>
        <PageHeader title={t('confirmContact.title')} />
        <Card>
          <div className="px-5 py-10 text-center">
            <p className="text-sm font-medium text-ink">{t('confirmContact.signInFirst')}</p>
            <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-ink-muted">
              {/* The OLD address still works, and saying so is the difference
                  between "sign in" and "sign in with what?". */}
              {t('confirmContact.signInWithCurrentAddress')}
            </p>
            <div className="mt-6">
              {/*
               * `state.from` carrying the path AND the query, which is the
               * convention `RequireCustomer` and `LoginPage` already share.
               * Dropping the query would send somebody back here with the
               * token gone, which reads as a broken link.
               */}
              <ButtonLink
                to="/login"
                variant="primary"
                state={{ from: `${location.pathname}${location.search}` }}
              >
                {t('header.signIn')}
              </ButtonLink>
            </div>
          </div>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('confirmContact.title')} />

      <Card>
        <div className="px-5 py-10 text-center">
          {state === 'confirming' && (
            <p className="flex items-center justify-center gap-2.5 text-sm text-ink-muted">
              <Spinner className="h-4 w-4" />
              {t('confirmContact.confirming')}
            </p>
          )}

          {state === 'done' && (
            <>
              <span
                aria-hidden="true"
                className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-success-soft text-success"
              >
                <CheckIcon className="h-6 w-6" />
              </span>

              <p className="mt-4 text-title-sm text-ink">
                {kind === 'phone'
                  ? t('confirmContact.phoneConfirmed')
                  : t('confirmContact.emailConfirmed')}
              </p>

              {value !== null && (
                <p className="mt-1.5 text-sm font-medium text-ink">{value}</p>
              )}

              <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-ink-muted">
                {kind === 'phone'
                  ? t('confirmContact.phoneConfirmedBody')
                  : t('confirmContact.emailConfirmedBody')}
              </p>

              <div className="mt-6">
                {kind === 'phone' ? (
                  <Link
                    to="/account/profile"
                    className="text-sm font-medium text-brand hover:underline"
                  >
                    {t('account.nav.profileInformation')}
                  </Link>
                ) : (
                  <Link to="/login" className="text-sm font-medium text-brand hover:underline">
                    {t('header.signIn')}
                  </Link>
                )}
              </div>
            </>
          )}

          {state === 'failed' && (
            <>
              <span
                aria-hidden="true"
                className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-danger-soft text-danger"
              >
                <AlertIcon className="h-6 w-6" />
              </span>

              <p className="mt-4 text-title-sm text-ink">{t('confirmContact.notConfirmed')}</p>
              <p role="alert" className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-ink-muted">
                {message ?? t('confirmContact.couldNotConfirm')}
              </p>

              <div className="mt-6">
                <Link
                  to="/account/profile"
                  className="text-sm font-medium text-brand hover:underline"
                >
                  {t('confirmContact.tryAgainFromProfile')}
                </Link>
              </div>
            </>
          )}
        </div>
      </Card>
    </>
  );
}
