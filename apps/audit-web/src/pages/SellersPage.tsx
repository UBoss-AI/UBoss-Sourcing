/**
 * Seller verification.
 *
 *   SellersPage:      GET /api/v1/audit/sellers - the sellers, and the backfill review
 *   SellerDetailPage: GET /api/v1/audit/sellers/:id - four things kept apart:
 *                     business identity (decided in the Admin Panel), category
 *                     qualifications, product cases, and the documents behind them.
 *
 * `?status=` takes a case status, which is what the server filters sellers by
 * (a seller with at least one case in that status). `?health=` takes a health
 * band and `?sort=risk` lists the riskiest seller first - Amazon's Account
 * Health rating, worked out by the server for every seller in the list.
 */
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CardField, EnumBadge, QueryBoundary, ResponsiveTable } from '@/components/console';
import { DataTable, type Column } from '@/components/DataTable';
import {
  Badge,
  Button,
  Callout,
  Card,
  DescriptionList,
  Input,
  PageHeader,
  Select,
  Toolbar,
  ToolbarActions,
  ToolbarField,
} from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, fetchSeller, fetchSellers } from '@/lib/console-api';
import type { BackfillRow, SellerCaseRow, SellerDetail, SellerDocumentRow, SellerRow } from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { formatCalendarDate, formatDateTime, formatNumber } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useDebounced } from '@/lib/use-debounced';
import { HealthBadge } from '@/components/health';
import type { HealthBand } from '@/lib/console-types';
import { SellerHealthCard, VerificationReportCard } from './sellers/SellerHealthPanels';

const HEALTH_BANDS: readonly HealthBand[] = ['HEALTHY', 'AT_RISK', 'UNHEALTHY'];
const SORTS = ['name', 'risk'] as const;
import { CASE_STATUSES, pick } from './compliance/compliance-constants';
import { OpenCaseDialog } from './compliance/OpenCaseDialog';

export function SellersPage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const status = pick(params.get('status'), CASE_STATUSES);
  const health = pick(params.get('health'), HEALTH_BANDS);
  const sort = pick(params.get('sort'), SORTS) === 'risk' ? 'risk' : 'name';
  const debounced = useDebounced(search.trim());
  const [opening, setOpening] = useState<BackfillRow | null>(null);

  const filters = {
    ...(debounced === '' ? {} : { search: debounced }),
    ...(status === '' ? {} : { status }),
    ...(health === '' ? {} : { health }),
    sort,
  } as const;
  const query = useQuery({
    queryKey: consoleKeys.sellers(filters),
    queryFn: () => fetchSellers(filters),
    placeholderData: keepPreviousData,
  });

  const setParam = (name: string, next: string): void => {
    const copy = new URLSearchParams(params);
    if (next === '') copy.delete(name);
    else copy.set(name, next);
    setParams(copy, { replace: true });
  };
  const setStatus = (next: string): void => {
    setParam('status', next);
  };

  const columns: Column<SellerRow>[] = [
    {
      key: 'name',
      header: t('sellers.col.name'),
      render: (row) => (
        <Link className="font-medium text-accent hover:underline" to={`/sellers/${row.id}`}>
          {row.name}
        </Link>
      ),
    },
    {
      key: 'health',
      header: t('health.column'),
      nowrap: true,
      render: (row) => <HealthBadge band={row.health.band} score={row.health.score} />,
    },
    { key: 'kind', header: t('sellers.col.kind'), secondary: true, render: (row) => enumLabel(t, 'sellerKind', row.kind) },
    {
      key: 'application',
      header: t('sellers.col.application'),
      render: (row) => <EnumBadge family="sellerStatus" value={row.applicationStatus} />,
    },
    { key: 'qualifications', header: t('sellers.col.qualifications'), align: 'right', render: (row) => formatNumber(row.qualifications) },
    {
      key: 'cases',
      header: t('sellers.col.openCases'),
      align: 'right',
      render: (row) => <span className={row.casesOpen > 0 ? 'font-semibold text-warning' : ''}>{formatNumber(row.casesOpen)}</span>,
    },
    {
      key: 'documents',
      header: t('sellers.col.documentsWaiting'),
      align: 'right',
      render: (row) => (
        <span className={row.documentsWaiting > 0 ? 'font-semibold text-warning' : ''}>{formatNumber(row.documentsWaiting)}</span>
      ),
    },
  ];

  return (
    <>
      <PageHeader title={t('screens.sellers.title')} description={t('screens.sellers.description')} />

      <div className="space-y-6">
        <Card>
          <Toolbar>
            <ToolbarField label={t('common.search')} grow>
              <Input
                type="search"
                value={search}
                placeholder={t('sellers.searchPlaceholder')}
                onChange={(event) => {
                  setSearch(event.target.value);
                }}
              />
            </ToolbarField>
            <ToolbarField label={t('sellers.caseStatusFilter')}>
              <Select
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value);
                }}
              >
                <option value="">{t('common.all')}</option>
                {CASE_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {enumLabel(t, 'caseStatus', value)}
                  </option>
                ))}
              </Select>
            </ToolbarField>
            <ToolbarField label={t('health.column')}>
              <Select
                value={health}
                onChange={(event) => {
                  setParam('health', event.target.value);
                }}
              >
                <option value="">{t('common.all')}</option>
                {HEALTH_BANDS.map((value) => (
                  <option key={value} value={value}>
                    {t(`health.band.${value}`)}
                  </option>
                ))}
              </Select>
            </ToolbarField>
            <ToolbarField label={t('health.sort')}>
              <Select
                value={sort}
                onChange={(event) => {
                  setParam('sort', event.target.value === 'risk' ? 'risk' : '');
                }}
              >
                <option value="name">{t('health.sortName')}</option>
                <option value="risk">{t('health.sortRisk')}</option>
              </Select>
            </ToolbarField>
            {(search !== '' || status !== '' || health !== '' || sort !== 'name') && (
              <ToolbarActions>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSearch('');
                    setParams(new URLSearchParams(), { replace: true });
                  }}
                >
                  {t('common.clearFilters')}
                </Button>
              </ToolbarActions>
            )}
          </Toolbar>
          <QueryBoundary query={query}>
            {(data) => (
              <ResponsiveTable
                caption={t('screens.sellers.title')}
                columns={columns}
                rows={data.sellers}
                rowKey={(row) => row.id}
                minWidth="44rem"
                isRefreshing={query.isFetching}
                emptyTitle={t('sellers.empty')}
                card={(row) => (
                  <div className="space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <Link className="font-medium text-accent hover:underline" to={`/sellers/${row.id}`}>
                        {row.name}
                      </Link>
                      <EnumBadge family="sellerStatus" value={row.applicationStatus} />
                    </div>
                    <CardField label={t('health.column')}>
                      <HealthBadge band={row.health.band} score={row.health.score} />
                    </CardField>
                    <CardField label={t('sellers.col.qualifications')}>{formatNumber(row.qualifications)}</CardField>
                    <CardField label={t('sellers.col.openCases')}>{formatNumber(row.casesOpen)}</CardField>
                    <CardField label={t('sellers.col.documentsWaiting')}>{formatNumber(row.documentsWaiting)}</CardField>
                  </div>
                )}
              />
            )}
          </QueryBoundary>
        </Card>

        {query.data !== undefined && (
          <BackfillPanel
            rows={query.data.backfill}
            canOpen={can(Permission.CASE_REVIEW)}
            onOpen={setOpening}
          />
        )}
      </div>

      {opening !== null && (
        <OpenCaseDialog
          row={opening}
          onClose={() => {
            setOpening(null);
          }}
        />
      )}
    </>
  );
}

function BackfillPanel({
  rows,
  canOpen,
  onOpen,
}: {
  rows: BackfillRow[];
  canOpen: boolean;
  onOpen: (row: BackfillRow) => void;
}): React.JSX.Element {
  const { t } = useI18n();

  const columns: Column<BackfillRow>[] = [
    {
      key: 'seller',
      header: t('sellers.col.name'),
      render: (row) => (
        <Link className="font-medium text-accent hover:underline" to={`/sellers/${row.sellerAccountId}`}>
          {row.sellerName}
        </Link>
      ),
    },
    { key: 'category', header: t('sellers.backfill.category'), render: (row) => row.categoryName },
    { key: 'offers', header: t('sellers.backfill.liveOffers'), align: 'right', render: (row) => formatNumber(row.liveOffers) },
    {
      key: 'action',
      header: <span className="sr-only">{t('common.actions')}</span>,
      align: 'right',
      render: (row) =>
        canOpen ? (
          <Button
            size="sm"
            onClick={() => {
              onOpen(row);
            }}
            aria-label={t('sellers.backfill.openCaseFor', { seller: row.sellerName, category: row.categoryName })}
          >
            {t('sellers.backfill.openCase')}
          </Button>
        ) : null,
    },
  ];

  return (
    <Card title={t('sellers.backfill.title')} description={t('sellers.backfill.description')}>
      <ResponsiveTable
        caption={t('sellers.backfill.title')}
        columns={columns}
        rows={rows}
        rowKey={(row) => `${row.sellerAccountId}:${row.categoryId}`}
        emptyTitle={t('sellers.backfill.empty')}
        emptyDescription={t('sellers.backfill.emptyBody')}
        card={(row) => (
          <div className="space-y-1.5">
            <p className="font-medium text-ink">{row.sellerName}</p>
            <CardField label={t('sellers.backfill.category')}>{row.categoryName}</CardField>
            <CardField label={t('sellers.backfill.liveOffers')}>{formatNumber(row.liveOffers)}</CardField>
            {canOpen && (
              <Button
                size="sm"
                className="mt-1"
                onClick={() => {
                  onOpen(row);
                }}
              >
                {t('sellers.backfill.openCase')}
              </Button>
            )}
          </div>
        )}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// One seller
// ---------------------------------------------------------------------------

export function SellerDetailPage(): React.JSX.Element {
  const { t } = useI18n();
  const { id = '' } = useParams();
  const query = useQuery({ queryKey: consoleKeys.seller(id), queryFn: () => fetchSeller(id) });
  const back = { to: '/sellers', label: t('screens.sellerDetail.back') };

  return (
    <>
      {query.data === undefined && <PageHeader back={back} title={t('screens.sellerDetail.title')} />}
      <QueryBoundary query={query}>{(detail) => <SellerScreen detail={detail} back={back} />}</QueryBoundary>
    </>
  );
}

function SellerScreen({ detail, back }: { detail: SellerDetail; back: { to: string; label: string } }): React.JSX.Element {
  const { t } = useI18n();
  const qualifications = detail.cases.filter((row) => row.level === 'SELLER_CATEGORY');
  const products = detail.cases.filter((row) => row.level === 'PRODUCT');

  return (
    <>
      <PageHeader
        back={back}
        title={detail.seller.name}
        description={t('screens.sellerDetail.description')}
        meta={<EnumBadge family="sellerStatus" value={detail.seller.applicationStatus} />}
      />

      <div className="space-y-6">
        <SellerHealthCard detail={detail} />
        <VerificationReportCard detail={detail} />

        <div id="seller-identity" className="scroll-mt-20">
        <Card title={t('sellers.detail.identity')} description={t('sellers.detail.identityHint')} bodyClassName="px-5 py-4">
          <Callout tone="info" className="mb-4">
            {t('sellers.detail.identityNote')}
          </Callout>
          <DescriptionList
            columns={3}
            items={[
              { label: t('sellers.col.kind'), value: enumLabel(t, 'sellerKind', detail.seller.kind) },
              { label: t('sellers.detail.country'), value: detail.seller.country ?? '—' },
              { label: t('sellers.col.application'), value: enumLabel(t, 'sellerStatus', detail.seller.applicationStatus) },
              ...(detail.seller.statusReason === null
                ? []
                : [{ label: t('sellers.detail.statusReason'), value: detail.seller.statusReason }]),
            ]}
          />

          <h3 className="mb-2 mt-5 text-title-xs text-ink">{t('sellers.detail.checks')}</h3>
          {detail.businessIdentity.checks.length === 0 ? (
            <p className="text-sm text-ink-muted">{t('sellers.detail.noChecks')}</p>
          ) : (
            <ul className="divide-y divide-border-subtle rounded-md border border-border">
              {detail.businessIdentity.checks.map((check) => (
                <li key={check.kind} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="text-ink">{humaniseKind(check.kind)}</span>
                  <span className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                    {check.issuer !== null && <span>{check.issuer}</span>}
                    {check.validUntil !== null && <span>{t('sellers.detail.validUntil', { date: formatCalendarDate(check.validUntil) })}</span>}
                    <EnumBadge family="trustCheckState" value={check.state} />
                  </span>
                </li>
              ))}
            </ul>
          )}

          {detail.businessIdentity.screening.length > 0 && (
            <p className="mt-3 text-xs text-ink-muted">
              {t('sellers.detail.screening', {
                state: detail.businessIdentity.screening[0]?.state ?? '—',
                date: formatDateTime(detail.businessIdentity.screening[0]?.at),
              })}
            </p>
          )}

          {detail.factories.length > 0 && (
            <>
              <h3 className="mb-2 mt-5 text-title-xs text-ink">{t('sellers.detail.factories')}</h3>
              <ul className="space-y-1 text-sm text-ink">
                {detail.factories.map((factory) => (
                  <li key={factory.id}>
                    {[factory.name, factory.city, factory.countryCode].filter((part) => part !== null && part !== '').join(', ')}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
        </div>

        <div id="seller-qualifications" className="scroll-mt-20">
        <CasesCard
          title={t('sellers.detail.qualifications')}
          description={t('sellers.detail.qualificationsHint')}
          rows={qualifications}
          empty={t('sellers.detail.noQualifications')}
          linkBase="/cases"
        />
        </div>
        <CasesCard
          title={t('sellers.detail.productCases')}
          description={t('sellers.detail.productCasesHint')}
          rows={products}
          empty={t('sellers.detail.noProductCases')}
          linkBase="/products"
        />
        <div id="seller-documents" className="scroll-mt-20">
          <DocumentsCard rows={detail.documents} />
        </div>
      </div>
    </>
  );
}

/** "LEGAL_ENTITY" → "Legal Entity", for the check kinds the server lists. */
function humaniseKind(kind: string): string {
  return kind
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function CasesCard({
  title,
  description,
  rows,
  empty,
  linkBase,
}: {
  title: string;
  description: string;
  rows: SellerCaseRow[];
  empty: string;
  linkBase: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const columns: Column<SellerCaseRow>[] = [
    {
      key: 'case',
      header: t('products.col.case'),
      nowrap: true,
      render: (row) => (
        <Link className="font-mono text-xs font-semibold text-accent hover:underline" to={`${linkBase}/${row.id}`}>
          {row.caseNumber}
        </Link>
      ),
    },
    { key: 'category', header: t('products.col.category'), render: (row) => row.categoryName },
    { key: 'role', header: t('products.col.role'), secondary: true, render: (row) => enumLabel(t, 'supplyRole', row.supplyRole) },
    {
      key: 'market',
      header: t('case.destinationMarket'),
      secondary: true,
      render: (row) => (row.destinationMarket === '' ? t('case.anyMarket') : row.destinationMarket),
    },
    { key: 'status', header: t('common.status'), render: (row) => <EnumBadge family="caseStatus" value={row.status} /> },
    { key: 'expires', header: t('case.expiresAt'), nowrap: true, render: (row) => formatDateTime(row.expiresAt) },
  ];

  return (
    <Card title={title} description={description}>
      <ResponsiveTable
        caption={title}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        emptyTitle={empty}
        card={(row) => (
          <div className="space-y-1.5">
            <div className="flex items-start justify-between gap-2">
              <Link className="font-mono text-xs font-semibold text-accent hover:underline" to={`${linkBase}/${row.id}`}>
                {row.caseNumber}
              </Link>
              <EnumBadge family="caseStatus" value={row.status} />
            </div>
            <CardField label={t('products.col.category')}>{row.categoryName}</CardField>
            <CardField label={t('case.expiresAt')}>{formatDateTime(row.expiresAt)}</CardField>
          </div>
        )}
      />
    </Card>
  );
}

function DocumentsCard({ rows }: { rows: SellerDocumentRow[] }): React.JSX.Element {
  const { t } = useI18n();
  const columns: Column<SellerDocumentRow>[] = [
    {
      key: 'standard',
      header: t('documents.col.document'),
      render: (row) => (
        <Link className="font-medium text-accent hover:underline" to={`/documents?document=${row.id}`}>
          {row.standard}
        </Link>
      ),
    },
    { key: 'type', header: t('documents.col.type'), secondary: true, render: (row) => enumLabel(t, 'documentType', row.documentType) },
    {
      key: 'status',
      header: t('common.status'),
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <EnumBadge family="documentStatus" value={row.reviewStatus} />
          {row.supersededAt !== null && <Badge tone="neutral">{t('documents.superseded')}</Badge>}
        </span>
      ),
    },
    {
      key: 'codes',
      header: t('documents.col.requirements'),
      secondary: true,
      render: (row) => (row.requirementCodes.length === 0 ? '—' : <span className="font-mono text-xs">{row.requirementCodes.join(', ')}</span>),
    },
    { key: 'expires', header: t('documents.col.expires'), nowrap: true, render: (row) => formatCalendarDate(row.expiresOn) },
  ];

  return (
    <Card title={t('sellers.detail.documents')} description={t('sellers.detail.documentsHint')}>
      <DataTable
        caption={t('sellers.detail.documents')}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        emptyTitle={t('sellers.detail.noDocuments')}
      />
    </Card>
  );
}
