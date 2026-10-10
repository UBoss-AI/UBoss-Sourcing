/**
 * Shipment Assessment in the admin panel: READ ONLY.
 *
 *   GET /api/v1/admin/shipment-assessments        the queues
 *   GET /api/v1/admin/shipment-assessments/:id    one case
 *
 * The Audit Team decides assessments, waivers and certificates in the Audit
 * Console. This page shows what was decided and by whom, and lets staff
 * download the documents. It has no buttons that change anything, and the
 * server has no admin route that would.
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Callout, Card, EmptyState, ErrorState, Input, LoadingState, PageHeader, Select } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { api, downloadFile } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

const QUEUES = ['ready', 'inProgress', 'awaitingQa', 'waiver', 'approved', 'failed', 'reassessment', 'awaitingL1', 'history'] as const;

interface Row {
  id: string;
  number: string;
  status: string;
  orderNumber: string;
  sellerOrderNumber: string;
  seller: string;
  badge: string | null;
  requirement: string;
  requirementReason: string;
  l1CompletedAt: string | null;
  releaseDeadline: string | null;
  existingAtRollout: boolean;
}

interface Detail extends Row {
  releaseRefusal: string | null;
  holdReason: string | null;
  mandatoryInspection: boolean;
  assessor: string | null;
  qaReviewer: string | null;
  documents: { id: string; number: string; kind: string; status: string; issuedAt: string; signedByName: string }[];
  events: { id: string; kind: string; toStatus: string | null; actor: string | null; note: string | null; occurredAt: string }[];
  waivers: { id: string; decision: string; badgeAtDecision: string | null; reason: string; decidedBy: string | null; decidedAt: string; invalidationReason: string | null }[];
  rounds: { round: number; kind: string; outcome: string | null; findingsSummary: string | null }[];
}

export function ShipmentAssessmentListPage(): React.JSX.Element {
  const { t } = useI18n();
  const [queue, setQueue] = useState<(typeof QUEUES)[number] | 'rollout'>('ready');
  const [search, setSearch] = useState('');
  const query = useQuery({
    queryKey: ['admin-shipment-assessments', queue, search],
    queryFn: () => {
      const params = new URLSearchParams(queue === 'rollout' ? { rollout: 'true' } : { queue });
      if (search.trim() !== '') params.set('search', search.trim());
      return api.get<{ rows: Row[]; counts: Record<string, number> }>(`/admin/shipment-assessments?${params.toString()}`);
    },
  });
  return (
    <>
      <PageHeader title={t('shipmentAssessment.title')} description={t('shipmentAssessment.adminDescription')} />
      <Callout tone="info">{t('shipmentAssessment.readOnly')}</Callout>
      <Card>
        <div className="flex flex-wrap gap-3 p-4">
          <Select
            aria-label={t('shipmentAssessment.queue')}
            value={queue}
            onChange={(event) => {
              setQueue(event.target.value as typeof queue);
            }}
          >
            {[...QUEUES, 'rollout' as const].map((key) => (
              <option key={key} value={key}>
                {t(`shipmentAssessment.queue.${key}` as TranslationKey)} ({String(query.data?.counts[key] ?? 0)})
              </option>
            ))}
          </Select>
          <Input
            type="search"
            aria-label={t('shipmentAssessment.search')}
            placeholder={t('shipmentAssessment.search')}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        {query.isPending ? (
          <LoadingState />
        ) : query.isError ? (
          <ErrorState error={query.error} />
        ) : query.data.rows.length === 0 ? (
          <EmptyState title={t('shipmentAssessment.empty')} />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {query.data.rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-start justify-between gap-2 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <Link className="font-medium text-accent hover:underline" to={`/inspection/shipment-assessments/${row.id}`}>
                    {row.number}
                  </Link>
                  <p className="text-xs text-ink-muted">
                    {row.orderNumber} · {row.sellerOrderNumber} · {row.seller} · {t(`shipmentAssessment.badge.${row.badge ?? 'NONE'}` as TranslationKey)}
                  </p>
                  <p className="text-xs">{row.requirementReason}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge tone="neutral">{t(`shipmentAssessment.status.${row.status}` as TranslationKey)}</Badge>
                  {row.releaseDeadline !== null && <span className="text-xs">{formatDateTime(row.releaseDeadline)}</span>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

export function ShipmentAssessmentViewPage(): React.JSX.Element {
  const { id = '' } = useParams();
  const { t } = useI18n();
  const query = useQuery({ queryKey: ['admin-shipment-assessment', id], queryFn: () => api.get<{ assessment: Detail }>(`/admin/shipment-assessments/${encodeURIComponent(id)}`) });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} />;
  const a = query.data.assessment;
  return (
    <>
      <PageHeader title={a.number} description={`${a.orderNumber} · ${a.sellerOrderNumber} · ${a.seller}`} />
      <Callout tone="info">{t('shipmentAssessment.readOnly')}</Callout>
      <div className="space-y-4">
        <Card title={t(`shipmentAssessment.status.${a.status}` as TranslationKey)}>
          <dl className="grid gap-2 p-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-ink-muted">{t('shipmentAssessment.requirementLabel')}</dt>
              <dd>{a.requirementReason}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">{t('shipmentAssessment.people')}</dt>
              <dd>
                {a.assessor ?? '—'} / {a.qaReviewer ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-ink-muted">{t('shipmentAssessment.deadline')}</dt>
              <dd>{formatDateTime(a.releaseDeadline)}</dd>
            </div>
            {a.holdReason !== null && (
              <div>
                <dt className="text-ink-muted">{t('shipmentAssessment.holdReason')}</dt>
                <dd>{a.holdReason}</dd>
              </div>
            )}
          </dl>
        </Card>
        <Card title={t('shipmentAssessment.documents')}>
          <ul className="divide-y divide-border-subtle text-sm">
            {a.documents.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                <span>
                  {t(`shipmentAssessment.docKind.${doc.kind}` as TranslationKey)} · {doc.number} · {doc.status} · {doc.signedByName}
                </span>
                <Button
                  size="sm"
                  onClick={() => {
                    void downloadFile(`/admin/shipment-assessments/${encodeURIComponent(a.id)}/documents/${encodeURIComponent(doc.id)}`, `${doc.number}.pdf`);
                  }}
                >
                  {t('shipmentAssessment.download')}
                </Button>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={t('shipmentAssessment.decisions')}>
          <ul className="space-y-2 p-4 text-sm">
            {a.rounds.map((round) => (
              <li key={`r${String(round.round)}`}>
                #{String(round.round)} · {round.kind} · {round.outcome ?? '—'} · {round.findingsSummary ?? ''}
              </li>
            ))}
            {a.waivers.map((waiver) => (
              <li key={waiver.id}>
                {waiver.decision} · {waiver.badgeAtDecision ?? '—'} · {waiver.decidedBy ?? '—'} · {formatDateTime(waiver.decidedAt)} · {waiver.reason}
                {waiver.invalidationReason !== null && ` · ${waiver.invalidationReason}`}
              </li>
            ))}
          </ul>
        </Card>
        <Card title={t('shipmentAssessment.history')}>
          <ol className="space-y-2 p-4 text-sm">
            {[...a.events].reverse().map((event) => (
              <li key={event.id}>
                {formatDateTime(event.occurredAt)} · {event.kind} {event.toStatus === null ? '' : `→ ${t(`shipmentAssessment.status.${event.toStatus}` as TranslationKey)}`} · {event.actor ?? '—'} {event.note ?? ''}
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}
