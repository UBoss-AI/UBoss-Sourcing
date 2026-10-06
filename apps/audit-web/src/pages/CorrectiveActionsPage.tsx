/**
 * Non-conformances found at inspection, the seller's corrective action (in
 * the seller's own words, read-only) and the re-inspections that close them.
 * Nobody but the agency edits a finding; this screen only reads.
 */
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { EnumBadge, QueryBoundary } from '@/components/console';
import { Card, EmptyState, PageHeader, Select, Toolbar, ToolbarField } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, fetchCorrectiveActions } from '@/lib/console-api';
import type { CorrectiveActionRow } from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { formatDateTime } from '@/lib/format';

export function CorrectiveActionsPage(): React.JSX.Element {
  const { t } = useI18n();
  const [status, setStatus] = useState('');
  const filters = status === '' ? {} : { status };
  const query = useQuery({
    queryKey: consoleKeys.correctiveActions(filters),
    queryFn: () => fetchCorrectiveActions(filters),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <PageHeader title={t('screens.correctiveActions.title')} description={t('screens.correctiveActions.description')} />
      <Card>
        <Toolbar>
          <ToolbarField label={t('common.status')}>
            <Select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
              }}
            >
              <option value="">{t('common.all')}</option>
              {['OPEN', 'CAPA_SUBMITTED', 'VERIFIED_CLOSED'].map((value) => (
                <option key={value} value={value}>
                  {enumLabel(t, 'ncrStatus', value)}
                </option>
              ))}
            </Select>
          </ToolbarField>
        </Toolbar>
        <QueryBoundary query={query}>
          {(data) =>
            data.items.length === 0 ? (
              <EmptyState title={t('capa.empty')} description={t('capa.emptyHint')} />
            ) : (
              <ul className="divide-y divide-border-subtle">
                {data.items.map((item) => (
                  <CapaItem key={item.id} item={item} />
                ))}
              </ul>
            )
          }
        </QueryBoundary>
      </Card>
    </>
  );
}

function CapaItem({ item }: { item: CorrectiveActionRow }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <li className="px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-sm font-semibold text-ink">{item.ncrNumber}</p>
          <p className="text-xs text-ink-muted">
            <Link to={`/jobs/${encodeURIComponent(item.jobId)}`} className="font-medium text-accent hover:underline">
              {item.jobNumber}
            </Link>{' '}
            · {item.sellerName} · {item.sellerOrderNumber} · {item.agencyName}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <EnumBadge family="severity" value={item.severity} />
          <EnumBadge family="ncrStatus" value={item.status} />
        </div>
      </div>
      <p className="mt-2 text-sm text-ink">{item.description}</p>
      <p className="mt-1 text-xs text-ink-muted">{t('capa.requirementRef', { ref: item.requirementRef })}</p>

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-md border border-border-subtle bg-surface-sunken px-3 py-2.5">
          <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('capa.sellerWords')}</p>
          {item.sellerResponse === null && item.correctiveAction === null ? (
            <p className="mt-1 text-sm text-ink-muted">{t('capa.noResponse')}</p>
          ) : (
            <blockquote className="mt-1 space-y-1.5 border-l-2 border-border-strong pl-3 text-sm italic text-ink">
              {item.correctiveAction !== null && <p>{item.correctiveAction}</p>}
              {item.sellerResponse !== null && <p>{item.sellerResponse}</p>}
            </blockquote>
          )}
          {item.capaSubmittedAt !== null && (
            <p className="mt-1.5 text-xs text-ink-muted">{t('capa.submittedAt', { when: formatDateTime(item.capaSubmittedAt) })}</p>
          )}
        </div>
        <div className="rounded-md border border-border-subtle px-3 py-2.5">
          <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('capa.reinspections')}</p>
          {item.reinspections.length === 0 ? (
            <p className="mt-1 text-sm text-ink-muted">{t('capa.noReinspection')}</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {item.reinspections.map((job) => (
                <li key={job.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <Link to={`/jobs/${encodeURIComponent(job.id)}`} className="font-medium text-accent hover:underline">
                    {job.jobNumber}
                  </Link>
                  <EnumBadge family="jobStatus" value={job.status} />
                </li>
              ))}
            </ul>
          )}
          {item.verifiedAt !== null && (
            <p className="mt-1.5 text-xs text-ink-muted">{t('capa.verifiedAt', { when: formatDateTime(item.verifiedAt) })}</p>
          )}
        </div>
      </div>
    </li>
  );
}
