/**
 * Choose who to buy for, straight after a Company-tab sign-in.
 *
 * Reached in two cases the sign-in page cannot settle on its own:
 *
 *   - **Several companies.** The session stays in the individual context until
 *     the person picks one - guessing is how an order lands on the wrong
 *     company's account.
 *   - **None.** They chose Company but this account belongs to no company.
 *     Said plainly, with the two ways forward. Only ever shown to somebody who
 *     has just proven the password, so it tells a stranger nothing.
 *
 * Every choice is sent to the server, which confirms the membership before it
 * changes the session. Then the person goes where they were headed, which is
 * `/` unless a deep link said otherwise.
 */
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import type { CompanyContextOption } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { Badge, Button, ButtonLink, PageHeader } from '@/components/ui';
import { BuildingIcon, UserIcon } from '@/components/icons';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { statusTone } from '@/lib/buyer-companies';
import { errorMessage } from '@/lib/errors';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { HOME, returnTarget } from '@/lib/return-target';

export function SelectCompanyPage(): React.JSX.Element {
  const { companies, switchBuyerContext, buyerContext } = useSession();
  const { business } = useStorefront();
  const { t } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useDocumentMeta({ title: t('selectCompany.pageTitle'), noIndex: true }, business.displayName);

  const target = returnTarget(location.state, location.search);
  const destination = target === '/select-company' ? HOME : target;

  const choose = async (option: CompanyContextOption | null): Promise<void> => {
    setError(null);
    setPending(option?.companyId ?? 'INDIVIDUAL');
    try {
      await switchBuyerContext(
        option === null ? { kind: 'INDIVIDUAL' } : { kind: 'COMPANY', companyId: option.companyId },
      );
      void navigate(destination, { replace: true });
    } catch (failure) {
      setError(errorMessage(t, failure, t('buyerContext.switchFailed')));
    } finally {
      setPending(null);
    }
  };

  const none = companies.length === 0;
  const current = buyerContext.kind === 'COMPANY' ? buyerContext.companyId : null;

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        title={none ? t('selectCompany.noneHeading') : t('selectCompany.heading')}
        description={none ? t('selectCompany.noneIntro') : t('selectCompany.intro')}
      />

      {error !== null && (
        <p role="alert" className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}

      {!none && (
        <ul className="space-y-2" aria-label={t('selectCompany.listLabel')}>
          {companies.map((company) => (
            <li key={company.companyId}>
              <button
                type="button"
                onClick={() => {
                  void choose(company);
                }}
                disabled={pending !== null}
                aria-busy={pending === company.companyId}
                aria-current={current === company.companyId ? 'true' : undefined}
                className="flex w-full items-center gap-3 rounded-lg border border-border bg-surface p-4 text-left shadow-card transition-colors hover:border-brand hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60"
              >
                <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand">
                  <BuildingIcon className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold text-ink">{company.companyName}</span>
                  <span className="block text-xs text-ink-muted">
                    {t(`companyRole.${company.role}` as TranslationKey)} · {company.applicationReference}
                  </span>
                </span>
                <Badge tone={statusTone(company.companyStatus)}>
                  {t(`companyStatus.${company.companyStatus}` as TranslationKey)}
                </Badge>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        {none && (
          <ButtonLink to="/register/company" variant="primary">
            {t('selectCompany.registerCompany')}
          </ButtonLink>
        )}
        <Button
          variant="secondary"
          isLoading={pending === 'INDIVIDUAL'}
          disabled={pending !== null}
          onClick={() => {
            void choose(null);
          }}
        >
          <UserIcon aria-hidden="true" className="h-4 w-4" />
          {t('selectCompany.continueIndividual')}
        </Button>
      </div>
    </div>
  );
}
