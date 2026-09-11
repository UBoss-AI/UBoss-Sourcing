/**
 * Accepting an invitation into a buyer organisation.
 *
 * Reached from a link in an email. The token is in the query string, which is
 * unavoidable — it has to survive an email client, a copy and a paste — and is
 * the reason the token is single-use, expires, is stored only as a SHA-256, and
 * is checked against the signed-in account's own email address before it does
 * anything.
 *
 * That last check is what stops a forwarded link working for the wrong person.
 * The token proves somebody read the message; the address check proves it was
 * the person it was addressed to.
 *
 * The five ways this can fail — no such token, expired, withdrawn, already
 * used, wrong person — all produce the same message, and that is deliberate.
 * Distinguishing them turns this page into a way to test whether a given
 * address has been invited to a given organisation.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { Button, ButtonLink, LoadingState, PageHeader } from '@/components/ui';
import { AlertIcon, CheckIcon } from '@/components/icons';
import { errorMessage } from '@/lib/errors';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import { customerErpApi } from '@/lib/customer-erp';
import { AccountPanel } from '../AccountPanel';

export function ErpJoinPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const token = searchParams.get('token') ?? '';

  useDocumentMeta({ title: t('erp.join.title'), noIndex: true }, business.displayName);

  const [organisation, setOrganisation] = useState<string | null>(null);

  const join = useMutation({
    mutationFn: () => customerErpApi.join(token),
    onSuccess: (org) => { setOrganisation(org.name); },
  });

  /*
   * Redeemed once, automatically, as soon as the page opens with a token.
   *
   * A ref rather than relying on the mutation's own state: React runs effects
   * twice in development's strict mode, and a second redemption attempt would
   * be refused as "already used" — turning a perfectly good invitation into an
   * error message the first time anybody clicked it.
   */
  const attempted = useRef(false);

  useEffect(() => {
    if (token.length === 0 || attempted.current) return;

    attempted.current = true;
    join.mutate();
  }, [token, join]);

  if (token.length === 0) {
    return (
      <>
        <PageHeader title={t('erp.join.title')} />
        <AccountPanel title={t('erp.join.invalidTitle')}>
          <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
            {t('erp.join.noToken')}
          </p>
        </AccountPanel>
      </>
    );
  }

  if (join.isPending) return <LoadingState label={t('erp.join.joining')} />;

  return (
    <>
      <PageHeader title={t('erp.join.title')} />

      <AccountPanel
        title={organisation === null ? t('erp.join.invalidTitle') : t('erp.join.welcomeTitle')}
      >
        {organisation === null ? (
          <>
            <p className="flex items-start gap-2 max-w-prose text-sm leading-relaxed text-ink">
              <AlertIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              {errorMessage(t, join.error, t('erp.join.invalidBody'))}
            </p>

            <div className="mt-5 flex flex-wrap gap-2">
              <ButtonLink to="/account/integrations/erp">{t('erp.join.goToIntegrations')}</ButtonLink>

              {/*
               * Retry, for the one failure that is genuinely transient — the
               * network. It is offered without promising it will help, because
               * four of the five causes are permanent.
               */}
              <Button
                variant="ghost"
                onClick={() => {
                  attempted.current = true;
                  join.mutate();
                }}
              >
                {t('common.tryAgain')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="flex items-start gap-2 max-w-prose text-sm leading-relaxed text-ink">
              <CheckIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-success" />
              {t('erp.join.welcomeBody', { organisation })}
            </p>

            <Button
              className="mt-5"
              variant="primary"
              onClick={() => navigate('/account/integrations/erp')}
            >
              {t('erp.join.goToIntegrations')}
            </Button>
          </>
        )}
      </AccountPanel>
    </>
  );
}
