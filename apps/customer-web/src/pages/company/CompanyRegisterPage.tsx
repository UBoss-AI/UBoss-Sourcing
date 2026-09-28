/**
 * "Register your company", from the Company sign-in tab.
 *
 * Two pages behind one address, because the first step is different for the
 * two people who arrive here:
 *
 *   - **Signed out**: step 1 is the account itself - the same sign-up form,
 *     the same confirmation link and password rules as an individual account.
 *     There is one identity system; buying for a company does not need a
 *     second login. The company's details come after the address is proven.
 *   - **Signed in**: the account exists, so this page says what the rest of
 *     the application will ask for, and why, then opens a draft. The draft is
 *     saved on the server step by step, so it can be finished later or on
 *     another device.
 *
 * What it will NOT ask for is said up front, because that is what somebody
 * wary of a business registration form most wants to know: no bank details,
 * no identity document and no beneficial owners by default.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { Button, Card, PageHeader, Spinner } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { COMPANIES_QUERY_KEY, createCompany, fetchMyCompanies } from '@/lib/buyer-companies';
import { errorMessage } from '@/lib/errors';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { InvitationOnly, RegistrationForm } from '@/pages/RegisterPage';

export function CompanyRegisterPage(): React.JSX.Element {
  const { isCustomer, isLoading, refreshUser } = useSession();
  const { features, business } = useStorefront();
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  useDocumentMeta({ title: t('companyRegister.pageTitle'), noIndex: true }, business.displayName);

  // The seller account this person runs, if any - offered as a starting
  // point so the same legal entity is not typed in twice. Only ever their
  // own; the server refuses any other id.
  const mine = useQuery({
    queryKey: COMPANIES_QUERY_KEY,
    queryFn: fetchMyCompanies,
    enabled: isCustomer && features.buyerCompanies === true,
  });
  const sellerSource = mine.data?.sellerSource ?? null;

  const start = useMutation({
    mutationFn: (fromSellerAccountId: string | null) =>
      createCompany(fromSellerAccountId === null ? {} : { fromSellerAccountId }),
    onSuccess: async (application) => {
      await queryClient.invalidateQueries({ queryKey: COMPANIES_QUERY_KEY });
      // The session's company list now has one more entry for the switcher.
      await refreshUser();
      void navigate(`/account/companies/${application.id}`);
    },
    onError: (failure) => {
      setError(errorMessage(t, failure, t('companyRegister.startFailed')));
    },
  });

  if (isLoading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Spinner className="h-6 w-6 text-ink-subtle" />
      </div>
    );
  }

  if (features.buyerCompanies !== true) {
    return (
      <div className="mx-auto max-w-xl">
        <PageHeader title={t('companyRegister.unavailableTitle')} description={t('companyRegister.unavailableBody')} />
        <Link to="/" className="font-medium text-brand hover:underline">
          {t('companyRegister.backHome')}
        </Link>
      </div>
    );
  }

  if (!isCustomer) {
    return features.selfRegistration ? <RegistrationForm variant="company" /> : <InvitationOnly />;
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t('companyRegister.heading')} description={t('companyRegister.intro')} />

      <div className="grid gap-4 md:grid-cols-2">
        <Card title={t('companyRegister.youWillNeed')} bodyClassName="p-5">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink">
            <li>{t('companyRegister.need.registration')}</li>
            <li>{t('companyRegister.need.tax')}</li>
            <li>{t('companyRegister.need.addresses')}</li>
            <li>{t('companyRegister.need.document')}</li>
            <li>{t('companyRegister.need.email')}</li>
          </ul>
        </Card>
        <Card title={t('companyRegister.weDoNotAsk')} bodyClassName="p-5">
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink">
            <li>{t('companyRegister.notAsked.bank')}</li>
            <li>{t('companyRegister.notAsked.identity')}</li>
            <li>{t('companyRegister.notAsked.owners')}</li>
          </ul>
          <p className="mt-3 text-xs leading-relaxed text-ink-muted">{t('companyRegister.notAskedNote')}</p>
        </Card>
      </div>

      <div className="mt-6 rounded-lg border border-border bg-surface-sunken p-4 text-sm leading-relaxed text-ink-muted">
        {t('companyRegister.howItWorks')}
      </div>

      {error !== null && (
        <p role="alert" className="mt-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {error}
        </p>
      )}

      {sellerSource !== null && (
        <div className="mt-6 rounded-lg border border-brand/30 bg-brand-soft p-4 text-sm">
          <p className="font-semibold text-ink">{t('companyRegister.fromSellerHeading', { name: sellerSource.legalName })}</p>
          <p className="mt-1 leading-relaxed text-ink-muted">{t('companyRegister.fromSellerBody')}</p>
          <Button
            variant="secondary"
            className="mt-3"
            isLoading={start.isPending && start.variables === sellerSource.id}
            disabled={start.isPending}
            onClick={() => {
              setError(null);
              start.mutate(sellerSource.id);
            }}
          >
            {t('companyRegister.fromSellerStart')}
          </Button>
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          size="lg"
          isLoading={start.isPending && start.variables === null}
          disabled={start.isPending}
          onClick={() => {
            setError(null);
            start.mutate(null);
          }}
        >
          {sellerSource === null ? t('companyRegister.start') : t('companyRegister.startBlank')}
        </Button>
        <Link to="/account/companies" className="text-sm font-medium text-brand hover:underline">
          {t('companyRegister.seeExisting')}
        </Link>
      </div>
    </div>
  );
}
