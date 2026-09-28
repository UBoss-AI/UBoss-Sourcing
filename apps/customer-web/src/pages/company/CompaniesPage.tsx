/**
 * Account -> Company accounts: every company this person belongs to, where
 * each one's verification stands, and the way to register another.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { Badge, ButtonLink, EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { BuildingIcon } from '@/components/icons';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { COMPANIES_QUERY_KEY, fetchMyCompanies, statusTone } from '@/lib/buyer-companies';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

export function CompaniesPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  useDocumentMeta({ title: t('companies.pageTitle'), noIndex: true }, business.displayName);

  const query = useQuery({ queryKey: COMPANIES_QUERY_KEY, queryFn: fetchMyCompanies });

  return (
    <div>
      <PageHeader
        title={t('companies.heading')}
        description={t('companies.intro')}
        actions={
          <ButtonLink to="/register/company" variant="primary">
            {t('companies.register')}
          </ButtonLink>
        }
      />

      {query.isPending ? (
        <LoadingState label={t('companies.loading')} />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : query.data.companies.length === 0 ? (
        <EmptyState title={t('companies.emptyTitle')} description={t('companies.emptyBody')} />
      ) : (
        <ul className="space-y-2">
          {query.data.companies.map((company) => (
            <li key={company.companyId}>
              <Link
                to={`/account/companies/${company.companyId}`}
                className="flex items-center gap-3 rounded-lg border border-border bg-surface p-4 shadow-card transition-colors hover:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
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
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
