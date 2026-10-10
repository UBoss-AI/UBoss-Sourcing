/**
 * Product evidence and safety cases, READ ONLY (Doc 08 s7-9).
 *
 * The Audit Console verifies product evidence and decides safety cases. This
 * panel shows them so operations can see why a listing cannot trade, and
 * offers no control that changes them.
 */
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge, Callout, Card, DescriptionList, EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { commercialApi, type ProductEvidence, type SafetyCase } from '@/lib/commercial-policy';
import { formatDate, formatDateTime } from '@/lib/format';
import { codeLabel } from './format';
import { StatusBadge } from './shared';

export function ReadOnlyNotice(): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Callout tone="info" title={t('commercial.readOnlyTitle')}>
      {t('commercial.readOnlyBody')}
    </Callout>
  );
}

export function ProductEvidencePage(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: ['commercial', 'product-evidence'], queryFn: commercialApi.productEvidence });
  const columns: Column<ProductEvidence>[] = [
    { key: 'product', header: t('commercial.evidenceProduct'), render: (row) => `${row.productKey} · ${row.productVersion}` },
    { key: 'kind', header: t('commercial.kindLabel'), render: (row) => codeLabel(t, row.kind) },
    { key: 'scheme', header: t('commercial.scheme'), secondary: true, render: (row) => `${row.scheme} · ${row.issuer}` },
    { key: 'country', header: t('commercial.launch.country'), tertiary: true, render: (row) => row.countryCode },
    { key: 'expiry', header: t('commercial.expires'), nowrap: true, render: (row) => (row.expiresOn === null ? '—' : `${formatDate(row.expiresOn)}${row.daysToExpiry === null ? '' : ` (${t('commercial.days', { days: String(row.daysToExpiry) })})`}`) },
    { key: 'status', header: t('commercial.statusLabel'), render: (row) => <StatusBadge status={row.status} /> },
    { key: 'blocks', header: t('commercial.trading'), render: (row) => (row.blocksTrading ? <Badge tone="danger">{t('commercial.blocksTrading')}</Badge> : <Badge tone="success">{t('commercial.canTrade')}</Badge>) },
  ];
  return (
    <>
      <PageHeader title={t('commercial.productEvidenceTitle')} description={t('commercial.productEvidenceDescription')} />
      <ReadOnlyNotice />
      <Card className="mt-4">
        <DataTable caption={t('commercial.productEvidenceTitle')} columns={columns} rows={query.data?.evidence} rowKey={(row) => row.id} isLoading={query.isLoading} error={query.error} onRetry={() => { void query.refetch(); }} emptyTitle={t('commercial.empty')} />
      </Card>
    </>
  );
}

export function SafetyCasesPage(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: ['commercial', 'safety-cases'], queryFn: commercialApi.safetyCases });
  const columns: Column<SafetyCase>[] = [
    { key: 'ref', header: t('commercial.reference'), nowrap: true, render: (row) => <Link className="font-medium text-accent hover:underline" to={`/commercial/safety-cases/${row.id}`}>{row.reference}</Link> },
    { key: 'title', header: t('commercial.title'), render: (row) => row.title },
    { key: 'severity', header: t('commercial.severity'), render: (row) => <Badge tone={row.severity === 'CRITICAL' || row.severity === 'HIGH' ? 'danger' : 'warning'}>{codeLabel(t, row.severity)}</Badge> },
    { key: 'status', header: t('commercial.statusLabel'), render: (row) => <StatusBadge status={row.status} /> },
    { key: 'opened', header: t('commercial.opened'), secondary: true, render: (row) => formatDateTime(row.createdAt) },
  ];
  return (
    <>
      <PageHeader title={t('commercial.safetyTitle')} description={t('commercial.safetyDescription')} />
      <ReadOnlyNotice />
      <Card className="mt-4">
        <DataTable caption={t('commercial.safetyTitle')} columns={columns} rows={query.data?.cases} rowKey={(row) => row.id} isLoading={query.isLoading} error={query.error} onRetry={() => { void query.refetch(); }} emptyTitle={t('commercial.empty')} />
      </Card>
    </>
  );
}

export function SafetyCaseDetailPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const query = useQuery({ queryKey: ['commercial', 'safety-case', id], queryFn: () => commercialApi.safetyCase(id) });
  if (query.isLoading) return <LoadingState />;
  if (query.error !== null || query.data === undefined) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const c = query.data;
  return (
    <>
      <PageHeader title={`${c.reference} · ${c.title}`} back={{ to: '/commercial/safety-cases', label: t('commercial.safetyTitle') }} meta={<StatusBadge status={c.status} />} />
      <ReadOnlyNotice />
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title={t('commercial.detailsTitle')} bodyClassName="px-5 py-4">
          <DescriptionList
            columns={1}
            items={[
              { label: t('commercial.description'), value: c.description },
              { label: t('commercial.severity'), value: codeLabel(t, c.severity) },
              { label: t('commercial.source'), value: codeLabel(t, c.sourceType) },
              { label: t('commercial.rootCause'), value: c.rootCause ?? '—' },
              { label: t('commercial.correctionEvidence'), value: c.correctionEvidence ?? '—' },
              { label: t('commercial.released'), value: formatDateTime(c.releasedAt) },
            ]}
          />
        </Card>
        <Card title={t('commercial.scopeTitle')} bodyClassName="px-5 py-4">
          {c.scope.length === 0 ? (
            <EmptyState title={t('commercial.empty')} />
          ) : (
            <ul className="space-y-1 text-sm">
              {c.scope.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-2">
                  <span className="text-ink">{codeLabel(t, s.kind)}: {s.label ?? s.ref}</span>
                  <Badge tone={s.contained ? 'success' : 'warning'}>{s.contained ? t('commercial.contained') : t('commercial.notContained')}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card title={t('commercial.historyTitle')} className="mt-4" bodyClassName="px-5 py-4">
        {c.actions.length === 0 ? (
          <EmptyState title={t('commercial.noHistory')} />
        ) : (
          <ol className="space-y-2 text-sm">
            {c.actions.map((a) => (
              <li key={a.id}>
                <span className="text-ink-muted">{formatDateTime(a.createdAt)}</span> · <span className="font-medium text-ink">{codeLabel(t, a.kind)}</span> — {a.detail}
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
