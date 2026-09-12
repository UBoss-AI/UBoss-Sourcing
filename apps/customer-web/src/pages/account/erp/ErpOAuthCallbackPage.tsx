/**
 * The last step of an ERP authorisation.
 *
 * The buyer's own ERP - monday, or anything else speaking authorisation-code
 * OAuth - has just redirected their browser here with `code` and `state` in the
 * query string. This page trades them for tokens and says what happened.
 *
 * WHY THIS PAGE EXISTS AT ALL
 *
 * The obvious design is to let the ERP redirect straight at the API and have it
 * finish the flow there. That was the original arrangement and it was wrong
 * twice over: the API's callback is a POST, so a redirected browser arriving by
 * GET found a 404 at the end of an authorisation that had otherwise worked; and
 * an authorisation code arriving as a GET parameter is an authorisation code
 * written into the access log of every proxy on the way. Landing on a page
 * instead keeps the code in a request body, on the buyer's own authenticated
 * session, and leaves somebody looking at words rather than at JSON.
 *
 * WHAT IS NOT CARRIED ACROSS THE REDIRECT
 *
 * Which connection this belongs to. The ERP sends back exactly what it was
 * given, and that is `code` and `state`; anything the browser was holding
 * before the redirect is gone the moment the provider decides to open the
 * callback in a new tab. The server recovers the connection from the `state` it
 * issued, so this page does not try to remember it.
 *
 * THE CONSENT SCREEN CAN ALSO SAY NO
 *
 * A buyer who presses Cancel comes back with `error` instead of `code`. That is
 * an ordinary outcome and not a fault, so it gets its own words and a way back
 * to the connection, rather than the failure message.
 */
import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { ButtonLink, LoadingState, PageHeader } from '@/components/ui';
import { AlertIcon, CheckIcon } from '@/components/icons';
import { errorMessage } from '@/lib/errors';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import { customerErpApi, erpKeys } from '@/lib/customer-erp';
import { AccountPanel } from '../AccountPanel';

export function ErpOAuthCallbackPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();

  const code = searchParams.get('code') ?? '';
  const state = searchParams.get('state') ?? '';
  /*
   * The consent screen's own refusal, per RFC 6749. `access_denied` is somebody
   * pressing Cancel; the rest are configuration problems on the ERP's side.
   * Either way there is no code to redeem, so nothing is sent.
   */
  const refusal = searchParams.get('error');

  useDocumentMeta({ title: t('erp.oauth.title'), noIndex: true }, business.displayName);

  const complete = useMutation({
    mutationFn: () => customerErpApi.completeOAuth({ state, code }),
    onSuccess: (result) => {
      // The connection's own screen is about to be visited, and its
      // credentials have just changed underneath whatever is cached.
      void queryClient.invalidateQueries({ queryKey: erpKeys.connection(result.connection.id) });
      void queryClient.invalidateQueries({ queryKey: erpKeys.connections });
    },
  });

  /*
   * Redeemed once, automatically. A ref rather than the mutation's own state
   * because React runs effects twice under development's strict mode, and the
   * code is single-use on both sides - a second attempt turns a successful
   * authorisation into "that could not be completed".
   */
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    if (refusal !== null || code.length === 0 || state.length === 0) return;

    attempted.current = true;
    complete.mutate();
  }, [code, state, refusal, complete]);

  if (complete.isPending) return <LoadingState label={t('erp.oauth.finishing')} />;

  const connectionId = complete.data?.connection.id ?? null;
  const backToConnection =
    connectionId === null
      ? '/account/integrations/erp'
      : `/account/integrations/erp/${connectionId}`;

  if (refusal !== null) {
    return (
      <Outcome
        title={t('erp.oauth.refusedTitle')}
        tone="warning"
        body={t('erp.oauth.refusedBody')}
        linkTo="/account/integrations/erp"
        linkLabel={t('erp.oauth.backToConnections')}
      />
    );
  }

  if (code.length === 0 || state.length === 0) {
    return (
      <Outcome
        title={t('erp.oauth.incompleteTitle')}
        tone="warning"
        body={t('erp.oauth.incompleteBody')}
        linkTo="/account/integrations/erp"
        linkLabel={t('erp.oauth.backToConnections')}
      />
    );
  }

  if (complete.isError) {
    return (
      <Outcome
        title={t('erp.oauth.failedTitle')}
        tone="warning"
        body={errorMessage(t, complete.error, t('erp.oauth.failedBody'))}
        linkTo="/account/integrations/erp"
        linkLabel={t('erp.oauth.backToConnections')}
      />
    );
  }

  if (complete.data === undefined) return <LoadingState label={t('erp.oauth.finishing')} />;

  return (
    <Outcome
      title={t('erp.oauth.doneTitle')}
      tone="success"
      body={
        // What was actually granted, not what was asked for. A buyer whose
        // administrator trimmed the scopes is told now, rather than at the
        // first purchase order that quietly fails to be created.
        complete.data.grantedScope === null
          ? t('erp.oauth.doneBody', { connection: complete.data.connection.name })
          : t('erp.oauth.doneBodyWithScope', {
              connection: complete.data.connection.name,
              scope: complete.data.grantedScope,
            })
      }
      linkTo={backToConnection}
      linkLabel={t('erp.oauth.backToConnection')}
    />
  );
}

/** One outcome, told the same way whichever of the four it is. */
function Outcome({
  title,
  tone,
  body,
  linkTo,
  linkLabel,
}: {
  title: string;
  tone: 'success' | 'warning';
  body: string;
  linkTo: string;
  linkLabel: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const Icon = tone === 'success' ? CheckIcon : AlertIcon;

  return (
    <>
      <PageHeader title={t('erp.oauth.title')} />

      <AccountPanel title={title}>
        <p className="flex max-w-prose items-start gap-2 text-sm leading-relaxed text-ink">
          <Icon
            aria-hidden="true"
            className={`mt-0.5 h-4 w-4 shrink-0 ${
              tone === 'success' ? 'text-success' : 'text-warning'
            }`}
          />
          {body}
        </p>

        <ButtonLink className="mt-5" to={linkTo} variant="primary">
          {linkLabel}
        </ButtonLink>
      </AccountPanel>
    </>
  );
}
