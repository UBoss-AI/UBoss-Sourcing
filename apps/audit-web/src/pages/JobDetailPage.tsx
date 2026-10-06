/**
 * The inspection workspace: one job, for everybody who may read it.
 *
 * Read from GET /audit/jobs/:id, which answers per audience - an agency
 * member gets the job with their own allowed actions, audit staff get it
 * with the timeline and the sub-lot releases. Agency writes go to
 * /audit/agency/jobs/:id/...; every one carries an idempotency key, because
 * this screen is used on a phone on a factory floor where a request that
 * timed out may well have arrived.
 *
 * Built for that phone first: one column, sections in the order the work is
 * done, large targets for the answers an inspector taps most. On a wide
 * screen a short list of links at the top jumps between sections.
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import { EnumBadge, QueryBoundary } from '@/components/console';
import { Card, PageHeader } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { consoleKeys, fetchJob } from '@/lib/console-api';
import type { JobDetail } from '@/lib/console-types';
import { ChecklistSection } from './job/ChecklistSection';
import { CoordinatorSection } from './job/CoordinatorSection';
import { DefectsSection } from './job/DefectsSection';
import { EvidenceSection } from './job/EvidenceSection';
import { InspectorSection } from './job/InspectorSection';
import { JobOverview } from './job/JobOverview';
import { LabSamplesSection } from './job/LabSamplesSection';
import { QuantitiesSection } from './job/QuantitiesSection';
import { ReportSection } from './job/ReportSection';
import { SamplingSection } from './job/SamplingSection';
import { SubLotCard, TimelineCard } from './job/StaffSections';
import { SECTION_IDS, workspaceModeFor } from './job/workspace-mode';

export function JobDetailPage(): React.JSX.Element {
  const { t } = useI18n();
  const { id = '' } = useParams();
  const query = useQuery({ queryKey: consoleKeys.job(id), queryFn: () => fetchJob(id) });

  if (query.isSuccess) return <Workspace detail={query.data} jobId={id} />;

  return (
    <>
      <PageHeader
        back={{ to: '/jobs', label: t('screens.jobDetail.back') }}
        title={t('screens.jobDetail.title')}
        description={t('screens.jobDetail.description')}
      />
      <Card>
        <QueryBoundary query={query} loadingLabel={t('job.loading')}>
          {() => null}
        </QueryBoundary>
      </Card>
    </>
  );
}

function Anchor({ id, children }: { id: string; children: ReactNode }): React.JSX.Element {
  return (
    <section id={id} className="scroll-mt-6">
      {children}
    </section>
  );
}

function Workspace({ detail, jobId }: { detail: JobDetail; jobId: string }): React.JSX.Element {
  const { t } = useI18n();
  const { can, canAny } = useSession();
  const mode = workspaceModeFor(detail, can, canAny);
  const { job, extras } = detail;
  const props = { detail, jobId, mode };
  const findingsStarted = !['REQUESTED', 'ACCEPTED', 'DECLINED', 'INSPECTOR_ASSIGNED', 'CANCELLED'].includes(job.status);

  const nav: { id: string; label: TranslationKey; show: boolean }[] = [
    { id: SECTION_IDS.overview, label: 'job.nav.overview', show: true },
    { id: SECTION_IDS.coordinate, label: 'job.nav.coordinate', show: mode.coordinator },
    { id: SECTION_IDS.inspector, label: 'job.nav.inspector', show: mode.namedInspector && job.status === 'INSPECTOR_ASSIGNED' },
    { id: SECTION_IDS.checklist, label: 'job.nav.checklist', show: true },
    { id: SECTION_IDS.sampling, label: 'job.nav.sampling', show: findingsStarted || mode.staff },
    { id: SECTION_IDS.quantities, label: 'job.nav.quantities', show: findingsStarted || mode.staff },
    { id: SECTION_IDS.defects, label: 'job.nav.defects', show: findingsStarted || mode.staff },
    { id: SECTION_IDS.lab, label: 'job.nav.lab', show: findingsStarted || mode.staff },
    { id: SECTION_IDS.evidence, label: 'job.nav.evidence', show: true },
    { id: SECTION_IDS.report, label: 'job.nav.report', show: true },
    { id: SECTION_IDS.subLots, label: 'job.nav.subLots', show: mode.staff },
    { id: SECTION_IDS.timeline, label: 'job.nav.timeline', show: mode.staff },
  ];

  return (
    <>
      <PageHeader
        back={{ to: '/jobs', label: t('screens.jobDetail.back') }}
        title={job.jobNumber}
        description={t('job.headerDescription', { seller: detail.requirement.sellerName, order: detail.requirement.sellerOrderNumber })}
        meta={
          <div className="flex flex-wrap items-center gap-1.5">
            <EnumBadge family="jobStatus" value={job.status} />
            <EnumBadge family="jobKind" value={job.kind} dot={false} />
            <EnumBadge family="stage" value={extras.stage} dot={false} />
            <EnumBadge family="scopeMethod" value={extras.scopeMethod} dot={false} />
          </div>
        }
      />

      <nav aria-label={t('job.nav.label')} className="mb-5 hidden lg:block">
        <ul className="flex flex-wrap gap-1.5">
          {nav
            .filter((entry) => entry.show)
            .map((entry) => (
              <li key={entry.id}>
                <a
                  href={`#${entry.id}`}
                  className="inline-flex rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-ink-muted transition-colors hover:border-border-hover hover:text-ink"
                >
                  {t(entry.label)}
                </a>
              </li>
            ))}
        </ul>
      </nav>

      {mode.staff && (
        <p className="mb-4 text-xs text-ink-muted">{t('job.staffReadOnly')}</p>
      )}

      <div className="space-y-5">
        <JobOverview detail={detail} />

        {detail.audience === 'AGENCY' && mode.coordinator && (
          <Anchor id={SECTION_IDS.coordinate}>
            <CoordinatorSection detail={detail} jobId={jobId} />
          </Anchor>
        )}

        {detail.audience === 'AGENCY' && mode.namedInspector && (
          <Anchor id={SECTION_IDS.inspector}>
            <InspectorSection detail={detail} jobId={jobId} />
          </Anchor>
        )}

        <Anchor id={SECTION_IDS.checklist}>
          <ChecklistSection {...props} />
        </Anchor>

        {(findingsStarted || mode.staff) && (
          <>
            <Anchor id={SECTION_IDS.sampling}>
              <SamplingSection {...props} />
            </Anchor>
            <Anchor id={SECTION_IDS.quantities}>
              <QuantitiesSection {...props} />
            </Anchor>
            <Anchor id={SECTION_IDS.defects}>
              <DefectsSection {...props} />
            </Anchor>
            <Anchor id={SECTION_IDS.lab}>
              <LabSamplesSection {...props} />
            </Anchor>
          </>
        )}

        <Anchor id={SECTION_IDS.evidence}>
          <EvidenceSection {...props} />
        </Anchor>

        <Anchor id={SECTION_IDS.report}>
          <ReportSection {...props} />
        </Anchor>

        {detail.audience === 'STAFF' && (
          <>
            <Anchor id={SECTION_IDS.subLots}>
              <SubLotCard detail={detail} jobId={jobId} />
            </Anchor>
            <Anchor id={SECTION_IDS.timeline}>
              <TimelineCard detail={detail} />
            </Anchor>
          </>
        )}

      </div>
    </>
  );
}
