/**
 * The seller assessment queue: one tab per status group with a count, search
 * by assessment number or seller, and risk, overdue and expiry filters.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { QueryBoundary, ResponsiveTable } from '@/components/console';
import { Badge, Input, LinkButton, PageHeader, Select } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { formatDate } from '@/lib/format';
import { GATE_TONE, QUEUES, assessmentKeys, fetchAssessments, type AssessmentRow, type Queue } from '@/lib/seller-assessment';

const tk = (key: string) => key as TranslationKey;
const QUEUE_STATUS: Record<Queue, string[]> = { all: [], draft: ['DRAFT'], submitted: ['SUBMITTED'], correction: ['CORRECTION_REQUESTED'], review: ['IN_REVIEW'], remediation: ['REMEDIATION'], released: ['RELEASED'], closed: ['DECLINED', 'WITHDRAWN'] };

export function SellerAssessmentQueuePage(): React.JSX.Element {
  const { t } = useI18n();
  const [queue, setQueue] = useState<Queue>('review');
  const [search, setSearch] = useState('');
  const [risk, setRisk] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [expiringDays, setExpiring] = useState('');
  const params = { queue, search, risk, overdue, expiringDays, page: 1 };
  const query = useQuery({ queryKey: assessmentKeys.list(params), queryFn: () => fetchAssessments(params), placeholderData: keepPreviousData });
  return (
    <>
      <PageHeader title={t('sa.title')} description={t('sa.queue.description')} actions={<LinkButton to="/seller-assessments/assurance" variant="secondary">{t('sa.assurance.title')}</LinkButton>} />
      <div className="mb-4 flex flex-wrap gap-2" role="toolbar" aria-label={t('sa.queue.filters')}>
        <Select aria-label={t('sa.queue.status')} value={queue} onChange={(e) => { setQueue(e.target.value as Queue); }}>
          {QUEUES.map((q) => {
            const count = query.data === undefined ? null : QUEUE_STATUS[q].reduce((n, s) => n + (query.data.counts[s] ?? 0), 0);
            return <option key={q} value={q}>{t(tk(`sa.queue.${q}`))}{count === null || q === 'all' ? '' : ` (${String(count)})`}</option>;
          })}
        </Select>
        <Input aria-label={t('sa.queue.search')} placeholder={t('sa.queue.search')} value={search} onChange={(e) => { setSearch(e.target.value); }} />
        <Select aria-label={t('sa.overview.risk')} value={risk} onChange={(e) => { setRisk(e.target.value); }}>
          <option value="">{t('sa.queue.anyRisk')}</option>
          {['LOW', 'MEDIUM', 'HIGH'].map((r) => <option key={r} value={r}>{t(tk(`sa.risk.${r}`))}</option>)}
        </Select>
        <Select aria-label={t('sa.queue.expiring')} value={expiringDays} onChange={(e) => { setExpiring(e.target.value); }}>
          <option value="">{t('sa.queue.anyExpiry')}</option>
          {['30', '60', '90'].map((d) => <option key={d} value={d}>{t('sa.queue.expiringWithin', { days: d })}</option>)}
        </Select>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={overdue} onChange={(e) => { setOverdue(e.target.checked); }} />{t('sa.queue.overdueOnly')}</label>
      </div>
      <QueryBoundary query={query}>
        {(data) => (
          <ResponsiveTable<AssessmentRow>
            caption={t('sa.title')}
            rows={data.rows}
            rowKey={(r) => r.id}
            emptyTitle={t('sa.queue.empty')}
            emptyDescription={t('sa.queue.emptyHint')}
            columns={[
              { key: 'number', header: t('sa.queue.assessment'), render: (r) => <Link className="font-medium underline-offset-2 hover:underline" to={`/seller-assessments/${r.id}`}>{r.number}</Link> },
              { key: 'seller', header: t('sa.queue.seller'), render: (r) => <>{r.seller}<span className="block text-xs text-ink-muted">{r.legalName}</span></> },
              { key: 'status', header: t('sa.queue.status'), render: (r) => <Badge tone="action">{t(tk(`sa.status.${r.status}`))}</Badge> },
              { key: 'stage', header: t('sa.queue.stage'), render: (r) => <Badge tone={GATE_TONE[r.stage === 8 && r.status === 'RELEASED' ? 'PASSED' : 'IN_PROGRESS'] ?? 'neutral'}>{t('sa.queue.stageOf', { gate: String(r.stage), passed: String(r.gatesPassed) })}</Badge> },
              { key: 'owner', header: t('sa.overview.owner'), render: (r) => r.owner ?? '—' },
              { key: 'risk', header: t('sa.overview.risk'), render: (r) => t(tk(`sa.risk.${r.riskLevel}`)) },
              { key: 'target', header: t('sa.overview.reviewTarget'), render: (r) => <span className={r.overdue ? 'font-medium text-danger' : ''}>{formatDate(r.reviewTargetAt)}{r.overdue ? ` · ${t('sa.findings.overdue')}` : ''}</span> },
              { key: 'findings', header: t('sa.tab.findings'), render: (r) => `${String(r.openFindings.critical)} / ${String(r.openFindings.major)} / ${String(r.openFindings.minor)}${r.hardStops > 0 ? ` · ${t('sa.queue.hardStops', { stops: String(r.hardStops) })}` : ''}` },
            ]}
            card={(r) => (
              <Link to={`/seller-assessments/${r.id}`} className="block space-y-1">
                <p className="font-medium">{r.number} · {r.seller}</p>
                <p className="text-sm">{t(tk(`sa.status.${r.status}`))} · {t('sa.queue.stageOf', { gate: String(r.stage), passed: String(r.gatesPassed) })}</p>
              </Link>
            )}
          />
        )}
      </QueryBoundary>
    </>
  );
}
