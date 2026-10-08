/**
 * The two panels at the top of one seller's page.
 *
 *   SellerHealthCard        - Amazon's Account Health page: the rating on its
 *                             bar, the open issues counted by severity, each
 *                             issue with what it means and where to fix it,
 *                             and the inspection performance against its target.
 *   VerificationReportCard  - Alibaba's Verified Supplier assessment report:
 *                             one line per area (legal status, screening,
 *                             sites, certifications, qualifications, quality)
 *                             with its state, and the certificates listed.
 *
 * Both read `GET /api/v1/audit/sellers/:id`. The rating is the server's; the
 * report's states are summarised by `lib/verification-report.ts`.
 */
import { Link } from 'react-router-dom';
import { HealthBadge, HealthMeter } from '@/components/health';
import { SEVERITY_TONE } from '@/lib/health';
import { Badge, Card, type BadgeTone } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { IssueKind, IssueSeverity, SellerDetail } from '@/lib/console-types';
import { cx } from '@/lib/cx';
import { formatCalendarDate, formatNumber } from '@/lib/format';
import { verificationReport, type SectionState } from '@/lib/verification-report';

const SEVERITIES: IssueSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

/** Where each kind of issue is put right. In-page anchors point at this seller's own sections. */
function fixLink(kind: IssueKind, sellerName: string): string {
  switch (kind) {
    case 'CRITICAL_NCR_OPEN':
    case 'MAJOR_NCR_OPEN':
    case 'MINOR_NCR_OPEN':
      return '/corrective-actions';
    case 'LOT_HELD':
    case 'INSPECTION_FAILURE_RATE':
      return `/jobs?search=${encodeURIComponent(sellerName)}`;
    case 'CASE_SUSPENDED':
    case 'CASE_EXPIRED':
    case 'CASE_REREVIEW':
      return '#seller-qualifications';
    case 'IDENTITY_CHECK_LAPSED':
      return '#seller-identity';
    case 'DOCUMENT_SUSPENDED':
    case 'DOCUMENT_EXPIRED':
    case 'DOCUMENT_EXPIRING':
    case 'DOCUMENT_REJECTED':
    case 'CHANGES_REQUESTED':
      return '#seller-documents';
  }
}

export function SellerHealthCard({ detail }: { detail: SellerDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { health } = detail;
  const record = health.inspection;

  return (
    <Card title={t('health.title')} description={t('health.description')} bodyClassName="px-5 py-4">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="min-w-0">
          <p className="text-xxs font-semibold uppercase tracking-[0.12em] text-ink-subtle">{t('health.rating')}</p>
          <div className="mt-1 flex flex-wrap items-baseline gap-3">
            <span className="tabular text-title-lg text-ink">{formatNumber(health.score)}</span>
            <HealthBadge band={health.band} />
          </div>
          <HealthMeter className="mt-3" score={health.score} band={health.band} />
          <p className="mt-3 text-sm text-ink-muted">{t(`health.bandExplain.${health.band}`)}</p>

          <div className="mt-5 rounded-md border border-border px-3 py-3">
            <p className="text-xs font-semibold text-ink">{t('health.inspection.title')}</p>
            <div className="mt-1 flex flex-wrap items-baseline justify-between gap-2">
              <span className="tabular text-title-sm text-ink">
                {record.passRatePercent === null ? '—' : t('health.inspection.passRate', { percent: formatNumber(record.passRatePercent) })}
              </span>
              <Badge tone={record.meetsTarget === null ? 'neutral' : record.meetsTarget ? 'success' : 'danger'} dot>
                {t(record.meetsTarget === null ? 'health.inspection.notJudged' : record.meetsTarget ? 'health.inspection.onTarget' : 'health.inspection.offTarget')}
              </Badge>
            </div>
            <p className="mt-1 text-xs text-ink-muted">
              {t('health.inspection.basis', { reports: formatNumber(record.reports), notPassed: formatNumber(record.notPassed) })}
            </p>
            <p className="mt-0.5 text-xs text-ink-subtle">{t('health.inspection.target')}</p>
          </div>
        </div>

        <div className="min-w-0">
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label={t('health.bySeverity')}>
            {SEVERITIES.map((severity) => (
              <li
                key={severity}
                className={cx(
                  'rounded-md border px-3 py-2',
                  health.bySeverity[severity] > 0 && severity !== 'LOW' ? 'border-danger/30' : 'border-border',
                )}
              >
                <p className="text-xxs font-semibold uppercase tracking-[0.1em] text-ink-subtle">{t(`health.severity.${severity}`)}</p>
                <p className={cx('tabular text-title-sm', health.bySeverity[severity] > 0 ? (severity === 'LOW' ? 'text-ink' : severity === 'MEDIUM' ? 'text-warning' : 'text-danger') : 'text-ink-muted')}>
                  {formatNumber(health.bySeverity[severity])}
                </p>
              </li>
            ))}
          </ul>

          <h3 className="mb-2 mt-4 text-title-xs text-ink">{t('health.issues')}</h3>
          {health.issues.length === 0 ? (
            <p className="rounded-md border border-success/30 bg-success-soft px-3 py-3 text-sm text-success">{t('health.noIssues')}</p>
          ) : (
            <ul className="divide-y divide-border-subtle rounded-md border border-border">
              {health.issues.map((issue) => {
                const to = fixLink(issue.kind, detail.seller.name);
                const label = t(`health.issue.${issue.kind}.title`);
                return (
                  <li key={issue.kind} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                        <Badge tone={SEVERITY_TONE[issue.severity]}>{t(`health.severity.${issue.severity}`)}</Badge>
                        <span>{label}</span>
                        <span className="tabular text-xs text-ink-muted">×{formatNumber(issue.count)}</span>
                      </p>
                      <p className="mt-0.5 text-xs text-ink-muted">{t(`health.issue.${issue.kind}.fix`)}</p>
                    </div>
                    {to.startsWith('#') ? (
                      <a className="shrink-0 text-xs font-semibold text-accent hover:underline" href={to}>
                        {t('health.review')}
                      </a>
                    ) : (
                      <Link className="shrink-0 text-xs font-semibold text-accent hover:underline" to={to}>
                        {t('health.review')}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-2 text-xxs text-ink-subtle">{t('health.howScored')}</p>
        </div>
      </div>
    </Card>
  );
}

const STATE_TONE: Record<SectionState, BadgeTone> = {
  VERIFIED: 'success',
  ATTENTION: 'danger',
  PENDING: 'warning',
  DECLARED: 'accent',
  NOT_ASSESSED: 'neutral',
};

function StateMark({ state }: { state: SectionState }): React.JSX.Element {
  // Shape as well as colour: a tick, a bang, a clock-dot, a ring.
  const tone = {
    VERIFIED: 'bg-success-soft text-success',
    ATTENTION: 'bg-danger-soft text-danger',
    PENDING: 'bg-warning-soft text-warning',
    DECLARED: 'bg-accent-soft text-accent',
    NOT_ASSESSED: 'bg-surface-sunken text-ink-subtle',
  }[state];
  return (
    <span aria-hidden="true" className={cx('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full', tone)}>
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {state === 'VERIFIED' && <path d="M3.5 8.5l3 3 6-7" />}
        {state === 'ATTENTION' && <path d="M8 3.5v5.5M8 12.5v.01" />}
        {state === 'PENDING' && <path d="M8 4.5V8l2.5 1.5" />}
        {state === 'DECLARED' && <path d="M4 8h8" />}
        {state === 'NOT_ASSESSED' && <circle cx="8" cy="8" r="3.5" />}
      </svg>
    </span>
  );
}

export function VerificationReportCard({ detail }: { detail: SellerDetail }): React.JSX.Element {
  const { t } = useI18n();
  const report = verificationReport(detail);
  const certificates = detail.documents.filter((row) => row.supersededAt === null && row.reviewStatus === 'APPROVED');

  return (
    <Card
      title={t('verification.title')}
      description={t('verification.description')}
      actions={
        <Badge tone={report.verified ? 'success' : 'neutral'} dot>
          {t(report.verified ? 'verification.verified' : 'verification.notVerified')}
        </Badge>
      }
      bodyClassName="px-5 py-4"
    >
      <ul className="grid gap-x-6 gap-y-4 md:grid-cols-2">
        {report.sections.map((section) => (
          <li key={section.key} className="flex gap-3">
            <StateMark state={section.state} />
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                {t(`verification.section.${section.key}`)}
                <Badge tone={STATE_TONE[section.state]}>{t(`verification.state.${section.state}`)}</Badge>
              </p>
              <p className="mt-0.5 text-xs text-ink-muted">
                {t(`verification.fact.${section.key}`, Object.fromEntries(Object.entries(section.facts).map(([key, value]) => [key, formatNumber(value)])))}
              </p>
            </div>
          </li>
        ))}
      </ul>

      <h3 className="mb-2 mt-5 text-title-xs text-ink">{t('verification.certificates')}</h3>
      {certificates.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('verification.noCertificates')}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {certificates.map((row) => (
            <li key={row.id} className="rounded-md border border-border px-3 py-2">
              <Link to={`/documents?document=${row.id}`} className="text-sm font-semibold text-accent hover:underline">
                {row.standard}
              </Link>
              <p className="text-xxs text-ink-muted">
                {row.issuer}
                {row.expiresOn === null ? '' : ` · ${t('verification.validUntil', { date: formatCalendarDate(row.expiresOn) })}`}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-xxs text-ink-subtle">{t('verification.basis')}</p>
    </Card>
  );
}
