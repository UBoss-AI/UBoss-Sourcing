/**
 * The facts of the job: where, when, for whom, against what, and how many.
 *
 * The time is shown in the job's own time zone, with the zone written out -
 * an inspector reading "09:00" on a phone must not read it in the wrong
 * place. The sampling plan is the server's, from MIL-STD-105E / ANSI/ASQ
 * Z1.4; nothing here recomputes it.
 */
import { CardField } from '@/components/console';
import { Badge, Callout, Card, DescriptionList, SummaryTiles } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { JobDetail } from '@/lib/console-types';
import { enumLabel, enumTone, placeLine } from '@/lib/enum-labels';
import { formatDateTime, formatDateTimeIn, formatNumber } from '@/lib/format';
import { agencyKindLabel } from '@/lib/labels';
import { SECTION_IDS } from './workspace-mode';

function isOverdue(iso: string | null, open: boolean): boolean {
  return open && iso !== null && new Date(iso).getTime() < Date.now();
}

export function JobOverview({ detail }: { detail: JobDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { job, extras, requirement } = detail;
  const place = placeLine(job.inspectionPoint);
  const gateSentence = detail.gate.sentence !== '' ? detail.gate.sentence : requirement.gate.sentence;
  const gateOpen = requirement.gate.allowed;
  const finished = ['COMPLETED', 'CANCELLED', 'DECLINED'].includes(job.status);
  const acceptLate = isOverdue(job.acceptDueAt, job.status === 'REQUESTED');
  const reportLate = isOverdue(job.reportDueAt, !finished && job.status !== 'REQUESTED');

  return (
    <section id={SECTION_IDS.overview} aria-labelledby={`${SECTION_IDS.overview}-title`} className="scroll-mt-6 space-y-4">
      <h2 id={`${SECTION_IDS.overview}-title`} className="sr-only">
        {t('job.overview.title')}
      </h2>

      <Callout tone={gateOpen ? 'success' : 'warning'} title={t('job.overview.gateTitle')}>
        {gateSentence}
      </Callout>

      <Card title={t('job.overview.factsTitle')} bodyClassName="px-5 py-4">
        <DescriptionList
          columns={3}
          items={[
            {
              label: t('job.overview.scheduled'),
              value: (
                <>
                  <span className="font-medium">{formatDateTimeIn(job.scheduledFor, extras.timezone)}</span>
                  {extras.timezone !== null && (
                    <span className="block text-xs text-ink-muted">{t('job.overview.timezone', { zone: extras.timezone })}</span>
                  )}
                </>
              ),
            },
            {
              label: t('job.overview.agency'),
              value: (
                <>
                  <span className="font-medium">{extras.agencyName}</span>
                  <span className="block text-xs text-ink-muted">{agencyKindLabel(t, extras.agencyKind)}</span>
                </>
              ),
            },
            {
              label: t('job.overview.seller'),
              value: (
                <>
                  <span className="font-medium">{requirement.sellerName}</span>
                  <span className="block text-xs text-ink-muted">
                    {t('job.overview.orderLine', { order: requirement.orderNumber, sellerOrder: requirement.sellerOrderNumber })}
                  </span>
                </>
              ),
            },
            {
              label: t('job.overview.place'),
              value: (
                <>
                  <span>{enumLabel(t, 'inspectionPointType', job.inspectionPointType)}</span>
                  {place !== null && <span className="block text-xs text-ink-muted">{place}</span>}
                </>
              ),
            },
            { label: t('job.overview.lotSize'), value: <span className="tabular">{formatNumber(job.lotSize)}</span> },
            {
              label: t('job.overview.inspector'),
              value:
                job.inspector === null ? (
                  t('job.overview.noInspector')
                ) : (
                  <>
                    <span>{job.inspector.fullName}</span>
                    <span className="block text-xs text-ink-muted">
                      {job.inspector.identityVerified ? t('job.overview.identityVerified') : t('job.overview.identityNotVerified')}
                    </span>
                  </>
                ),
            },
            {
              label: t('job.overview.acceptBy'),
              value: (
                <span className="inline-flex flex-wrap items-center gap-2">
                  {formatDateTime(job.acceptDueAt)}
                  {acceptLate && <Badge tone="danger" dot>{enumLabel(t, 'slaState', 'ACCEPT_OVERDUE')}</Badge>}
                </span>
              ),
            },
            {
              label: t('job.overview.reportBy'),
              value: (
                <span className="inline-flex flex-wrap items-center gap-2">
                  {formatDateTime(job.reportDueAt)}
                  {reportLate && <Badge tone="danger" dot>{enumLabel(t, 'slaState', 'REPORT_OVERDUE')}</Badge>}
                </span>
              ),
            },
            {
              label: t('job.overview.readiness'),
              value: (
                <Badge tone={enumTone('readiness', job.readinessSubmittedAt === null ? 'NOT_READY' : 'READY')} dot>
                  {enumLabel(t, 'readiness', job.readinessSubmittedAt === null ? 'NOT_READY' : 'READY')}
                </Badge>
              ),
            },
          ]}
        />
        <p className="mt-4 border-t border-border-subtle pt-3 text-xs leading-relaxed text-ink-muted">
          <span className="font-semibold text-ink">{t('job.overview.standard')}: </span>
          {job.standard}
        </p>
        {job.declineReason !== null && (
          <Callout tone="neutral" className="mt-3" title={t('job.overview.declined')}>
            {job.declineReason}
          </Callout>
        )}
        {job.cancelReason !== null && (
          <Callout tone="neutral" className="mt-3" title={t('job.overview.cancelled')}>
            {job.cancelReason}
          </Callout>
        )}
      </Card>

      <ScopeCard detail={detail} />
      <SamplingPlanCard detail={detail} />
    </section>
  );
}

function ScopeCard({ detail }: { detail: JobDetail }): React.JSX.Element | null {
  const { t } = useI18n();
  const { job, requirement } = detail;
  const lines = job.scope?.lines ?? [];
  const po = requirement.purchaseOrder;
  const sample = requirement.referenceSample;

  return (
    <Card title={t('job.scope.title')} description={t('job.scope.description')} bodyClassName="px-5 py-4 space-y-4">
      {lines.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('job.scope.noLines')}</p>
      ) : (
        <ul className="divide-y divide-border-subtle rounded-md border border-border" aria-label={t('job.scope.title')}>
          {lines.map((line) => (
            <li key={line.orderItemId} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">
                  {line.name}
                  {line.variant !== null && <span className="text-ink-muted"> · {line.variant}</span>}
                </p>
                {line.sku !== '' && <p className="font-mono text-xxs text-ink-subtle">{line.sku}</p>}
              </div>
              <p className="text-sm tabular text-ink">
                {formatNumber(line.quantity)} {enumLabel(t, 'unit', line.orderingUnit).toLowerCase()}
              </p>
            </li>
          ))}
        </ul>
      )}

      {job.scope?.specialRequirements !== null && job.scope?.specialRequirements !== undefined && (
        <Callout tone="info" title={t('job.scope.special')}>
          {job.scope.specialRequirements}
        </Callout>
      )}

      {(po !== null || sample !== null || job.scope?.poReference !== undefined) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {(po !== null || job.scope?.poReference !== undefined) && (
            <div className="space-y-1.5 rounded-md border border-border-subtle bg-surface-sunken px-3 py-2.5">
              <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('job.scope.purchaseOrder')}</p>
              <CardField label={t('job.scope.reference')}>{po?.reference ?? job.scope?.poReference ?? '—'}</CardField>
              {po?.inspectionRequirement != null && <CardField label={t('job.scope.poRequirement')}>{po.inspectionRequirement}</CardField>}
              {po?.inspectionTerms != null && <p className="text-xs leading-relaxed text-ink">{po.inspectionTerms}</p>}
            </div>
          )}
          {sample !== null && (
            <div className="space-y-1.5 rounded-md border border-border-subtle bg-surface-sunken px-3 py-2.5">
              <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('job.scope.referenceSample')}</p>
              <CardField label={t('job.scope.reference')}>{sample.referenceCode ?? sample.reference}</CardField>
              <CardField label={t('job.scope.approved')}>{formatDateTime(sample.approvedAt)}</CardField>
              {sample.approvalCriteria !== null && <p className="text-xs leading-relaxed text-ink">{sample.approvalCriteria}</p>}
              {sample.files.length > 0 && (
                <p className="text-xs text-ink-muted">{t('job.scope.sampleFiles', { files: sample.files.join(', ') })}</p>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function SamplingPlanCard({ detail }: { detail: JobDetail }): React.JSX.Element {
  const { t } = useI18n();
  const plan = detail.job.sampling;
  const full = detail.extras.scopeMethod === 'FULL';

  return (
    <Card
      title={t('job.plan.title')}
      description={full ? t('job.plan.fullDescription') : t('job.plan.description')}
      bodyClassName="px-5 py-4"
    >
      {plan === null ? (
        <p className="text-sm text-ink-muted">{t('job.plan.none')}</p>
      ) : (
        <div className="space-y-3">
          <SummaryTiles
            items={[
              { label: t('job.plan.level'), value: plan.level },
              { label: t('job.plan.codeLetter'), value: plan.codeLetter },
              { label: t('job.plan.lot'), value: formatNumber(plan.lotSize) },
              { label: t('job.plan.sampleSize'), value: formatNumber(plan.sampleSize) },
            ]}
          />
          <div className="overflow-x-auto" role="region" aria-label={t('job.plan.classes')} tabIndex={0}>
            <table className="w-full min-w-[22rem] border-collapse text-sm">
              <caption className="sr-only">{t('job.plan.classes')}</caption>
              <thead className="bg-surface-sunken">
                <tr className="text-xxs uppercase tracking-wider text-ink-muted">
                  <th scope="col" className="px-3 py-2 text-left font-semibold">{t('job.plan.class')}</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">{t('job.plan.aql')}</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">{t('job.plan.examine')}</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">{t('job.plan.accept')}</th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">{t('job.plan.reject')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {(['critical', 'major', 'minor'] as const).map((key) => (
                  <tr key={key}>
                    <th scope="row" className="px-3 py-2 text-left font-medium text-ink">
                      {enumLabel(t, 'severity', key.toUpperCase())}
                    </th>
                    <td className="px-3 py-2 text-right tabular">{plan[key].aql}</td>
                    <td className="px-3 py-2 text-right tabular">{formatNumber(plan[key].sampleSize)}</td>
                    <td className="px-3 py-2 text-right tabular">{formatNumber(plan[key].accept)}</td>
                    <td className="px-3 py-2 text-right tabular">{formatNumber(plan[key].reject)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs leading-relaxed text-ink-muted">{t('job.plan.acReExplained')}</p>
        </div>
      )}
    </Card>
  );
}
