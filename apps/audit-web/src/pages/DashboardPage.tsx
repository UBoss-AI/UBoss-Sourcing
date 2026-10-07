/**
 * The day at a glance.
 *
 * Two audiences, decided by the server from the session (`audience`):
 *
 *   - an AGENCY member sees their own agency's work: jobs by status, what is
 *     overdue against its deadline, the inspectors, and recent reports;
 *   - audit STAFF see the queues as charts: key figures, a ring each for
 *     cases, documents and rules, and bars for inspection work and the
 *     categories still waiting for rules. Every slice, bar and figure opens
 *     the list it counts.
 *
 * Every figure is the server's count. The only arithmetic here is adding the
 * server's per-status counts together (a ring's total, "open cases", "closed")
 * and the share of stocked categories with approved rules; each sum names the
 * statuses it adds.
 */
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { EnumBadge, QueryBoundary, ResponsiveTable, CardField, StatTile } from '@/components/console';
import { BarListCard, KpiTile, type BarRow } from '@/components/dashboard/charts';
import { BentoCell, BentoGrid, ConsoleGround, ConsoleHeader } from '@/components/dashboard/console';
import { ModernDonutCard } from '@/components/dashboard/ModernDonutCard';
import { Badge, Button, Callout, Card, LinkButton, PageHeader } from '@/components/ui';
import { useCurrentUser } from '@/auth/session-context';
import { useI18n, type Translate } from '@/i18n/i18n-context';
import { consoleKeys, fetchCoverage, fetchDashboard } from '@/lib/console-api';
import type { AgencyDashboard, StaffDashboard } from '@/lib/console-types';
import type { DonutSegmentInput } from '@/lib/donut';
import { enumLabel } from '@/lib/enum-labels';
import { formatCalendarDate, formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import { agencyKindLabel, roleLabel } from '@/lib/labels';
import type { AuditRole } from '@/lib/types';

export function DashboardPage(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: consoleKeys.dashboard(),
    queryFn: fetchDashboard,
    // A minute, and only while the tab is in front: the same cadence as the
    // Admin Panel's dashboard. Anything tighter is load for no gain.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  // The staff view draws its own header inside the chart ground.
  if (query.data?.audience === 'STAFF') {
    return (
      <StaffView
        data={query.data.staff}
        updatedAt={query.dataUpdatedAt}
        refreshing={query.isFetching}
        onRefresh={() => {
          void query.refetch();
        }}
      />
    );
  }

  return (
    <>
      <PageHeader title={t('screens.dashboard.title')} description={t('screens.dashboard.description')} />
      <QueryBoundary query={query}>
        {(data) =>
          // Staff data returned above; this branch only ever draws an agency.
          data.audience === 'AGENCY' ? <AgencyView data={data.agency} /> : null
        }
      </QueryBoundary>
    </>
  );
}

// ---------------------------------------------------------------------------
// Agency
// ---------------------------------------------------------------------------

function AgencyView({ data }: { data: AgencyDashboard }): React.JSX.Element {
  const { t } = useI18n();
  const session = useCurrentUser();
  const kind = session.member.agency?.kind;

  const tiles: { label: string; value: number; status?: string; overdue?: boolean; tone?: 'warning' | 'danger' | 'success' }[] = [
    { label: t('dashboard.agency.offered'), value: data.counts.offered, status: 'REQUESTED', tone: 'warning' },
    { label: t('dashboard.agency.toAssign'), value: data.counts.toAssign, status: 'ACCEPTED' },
    { label: t('dashboard.agency.assigned'), value: data.counts.assigned, status: 'INSPECTOR_ASSIGNED' },
    { label: t('dashboard.agency.inProgress'), value: data.counts.inProgress, status: 'IN_PROGRESS' },
    { label: t('dashboard.agency.awaitingQa'), value: data.counts.awaitingQa, status: 'REPORT_SUBMITTED', tone: 'warning' },
    { label: t('dashboard.agency.completed'), value: data.counts.completed, status: 'COMPLETED', tone: 'success' },
    { label: t('dashboard.agency.overdue'), value: data.counts.overdue, overdue: true, tone: 'danger' },
  ];

  return (
    <div className="space-y-6">
      <Card bodyClassName="px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-title-sm text-ink">{data.agency.name}</p>
          {kind !== undefined && <Badge tone="neutral">{agencyKindLabel(t, kind)}</Badge>}
          <span className="text-sm text-ink-muted">
            {t('dashboard.agency.capacity', { capacity: formatNumber(data.agency.dailyCapacity) })}
          </span>
        </div>
        {data.agency.independenceStatement !== null && data.agency.independenceStatement !== '' && (
          <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-muted">
            <span className="font-medium text-ink">{t('dashboard.agency.independence')}</span>{' '}
            {data.agency.independenceStatement}
          </p>
        )}
      </Card>

      <section aria-labelledby="agency-jobs-heading">
        <h2 id="agency-jobs-heading" className="mb-3 text-title-xs text-ink">
          {t('dashboard.agency.jobsHeading')}
        </h2>
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
          {tiles.map((tile) => {
            const to =
              tile.overdue === true ? '/jobs?overdue=true' : `/jobs?status=${encodeURIComponent(tile.status ?? '')}`;
            return (
              <li key={tile.label}>
                <Link to={to} className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                  <StatTile
                    label={tile.label}
                    value={formatNumber(tile.value)}
                    {...(tile.value > 0 && tile.tone !== undefined ? { tone: tile.tone } : {})}
                  />
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title={t('dashboard.agency.reportsHeading')} description={t('dashboard.agency.reportsHint')}>
          <ResponsiveTable
            caption={t('dashboard.agency.reportsHeading')}
            rows={data.reports.slice(0, 10)}
            rowKey={(row) => row.id}
            emptyTitle={t('dashboard.agency.noReports')}
            columns={[
              {
                key: 'job',
                header: t('dashboard.column.job'),
                render: (row) => (
                  <Link to={`/jobs/${encodeURIComponent(row.jobId)}`} className="font-medium text-accent hover:underline">
                    {row.jobNumber}
                  </Link>
                ),
              },
              { key: 'revision', header: t('dashboard.column.revision'), align: 'right', render: (row) => formatNumber(row.revision) },
              { key: 'status', header: t('common.status'), render: (row) => <EnumBadge family="reportStatus" value={row.status} /> },
              {
                key: 'result',
                header: t('dashboard.column.result'),
                render: (row) => (row.result === null ? '—' : <EnumBadge family="reportResult" value={row.result} />),
              },
              {
                key: 'when',
                header: t('dashboard.column.when'),
                secondary: true,
                nowrap: true,
                render: (row) => formatDateTime(row.signedAt ?? row.returnedAt ?? row.submittedAt),
              },
            ]}
            card={(row) => (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Link to={`/jobs/${encodeURIComponent(row.jobId)}`} className="font-medium text-accent hover:underline">
                    {row.jobNumber}
                  </Link>
                  <EnumBadge family="reportStatus" value={row.status} />
                </div>
                <CardField label={t('dashboard.column.result')}>{enumLabel(t, 'reportResult', row.result)}</CardField>
                <CardField label={t('dashboard.column.when')}>
                  {formatDateTime(row.signedAt ?? row.returnedAt ?? row.submittedAt)}
                </CardField>
              </div>
            )}
          />
        </Card>

        {data.inspectors.length > 0 && <InspectorsCard data={data} />}
      </div>
    </div>
  );
}

function InspectorsCard({ data }: { data: AgencyDashboard }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Card
      title={t('dashboard.agency.peopleHeading')}
      description={t('dashboard.agency.peopleHint')}
      actions={
        <LinkButton to="/team" size="sm" variant="ghost">
          {t('dashboard.agency.openTeam')}
        </LinkButton>
      }
    >
      <ResponsiveTable
        caption={t('dashboard.agency.peopleHeading')}
        rows={data.inspectors}
        rowKey={(row) => row.id}
        columns={[
          { key: 'name', header: t('dashboard.column.name'), render: (row) => <span className="font-medium">{row.fullName}</span> },
          { key: 'role', header: t('dashboard.column.role'), render: (row) => roleText(t, row.role) },
          { key: 'status', header: t('common.status'), render: (row) => <EnumBadge family="memberStatus" value={row.status} /> },
          {
            key: 'identity',
            header: t('dashboard.column.identity'),
            secondary: true,
            render: (row) =>
              row.identityVerifiedAt === null ? (
                <Badge tone="warning">{t('dashboard.identity.notVerified')}</Badge>
              ) : (
                <Badge tone="success">{t('dashboard.identity.verified')}</Badge>
              ),
          },
          {
            key: 'credentials',
            header: t('dashboard.column.credentialExpiry'),
            secondary: true,
            nowrap: true,
            render: (row) => formatCalendarDate(row.credentialExpiresAt),
          },
        ]}
        card={(row) => (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-ink">{row.fullName}</span>
              <EnumBadge family="memberStatus" value={row.status} />
            </div>
            <CardField label={t('dashboard.column.role')}>{roleText(t, row.role)}</CardField>
            <CardField label={t('dashboard.column.identity')}>
              {row.identityVerifiedAt === null ? t('dashboard.identity.notVerified') : t('dashboard.identity.verified')}
            </CardField>
          </div>
        )}
      />
    </Card>
  );
}

function roleText(t: Translate, role: string): string {
  return roleLabel(t, role as AuditRole);
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------

/**
 * The audit team's dashboard, drawn as charts.
 *
 * Key figures across the top, one ring per queue (cases, documents, rules),
 * and ranked bars for the two things that are compared rather than shared
 * out: inspection work, and the categories still waiting for rules. Every
 * slice, bar and figure opens the list it counts.
 *
 * Every total is the server's. The rings are handed the sum of every status
 * the server returned, so a status this screen does not break out shows as a
 * shortfall under the ring rather than silently shrinking 100%.
 */
const CASES_CLOSED = ['REJECTED', 'WITHDRAWN', 'SUSPENDED', 'EXPIRED'] as const;
const DOCUMENTS_CLOSED = ['REJECTED', 'SUSPENDED', 'EXPIRED'] as const;
const CASES_OPEN = ['REQUESTED', 'UNDER_REVIEW', 'REREVIEW_REQUIRED', 'CHANGES_REQUESTED'] as const;

// The lattice aligns cells to the top; here each row's cards are compared
// side by side, so they share a height.
const STRETCH = 'self-stretch';

const sum = (counts: Record<string, number>, keys?: readonly string[]): number =>
  (keys ?? Object.keys(counts)).reduce((total, key) => total + (counts[key] ?? 0), 0);

function StaffView({
  data,
  updatedAt,
  refreshing,
  onRefresh,
}: {
  data: StaffDashboard;
  updatedAt: number;
  refreshing: boolean;
  onRefresh: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const coverage = useQuery({ queryKey: consoleKeys.coverage(), queryFn: fetchCoverage });

  const caseCount = (status: string): number => data.cases[status] ?? 0;
  const documentCount = (status: string): number => data.documents[status] ?? 0;
  const openCases = sum(data.cases, CASES_OPEN);
  const toReview = documentCount('SUBMITTED') + documentCount('UNDER_REVIEW');

  // Only categories that hold products: an empty category has no seller to qualify.
  const stocked = (coverage.data?.categories ?? []).filter((row) => row.products > 0);
  const covered = stocked.filter((row) => !row.needsReview).length;
  const missing = stocked
    .filter((row) => row.needsReview)
    .sort((a, b) => b.products - a.products || a.name.localeCompare(b.name))
    .slice(0, 8);

  const updatedIso = new Date(updatedAt).toISOString();

  const donutLabels = {
    status: t('common.status'),
    value: t('dashboard.staff.chart.number'),
    share: t('dashboard.staff.chart.share'),
    viewAsTable: t('dashboard.staff.chart.viewAsTable'),
    clearFilter: t('common.clearFilters'),
    filteredBy: t('dashboard.staff.chart.filteredBy'),
    empty: t('common.nothingHereYet'),
    error: t('common.theRequestFailed'),
    retry: t('dashboard.staff.chart.tryAgain'),
    loading: t('common.loading'),
    remainder: t('dashboard.staff.chart.remainder'),
    clampNote: t('dashboard.staff.chart.clampNote'),
  };

  // A slice leads to its list. The ring's "selection" is that navigation, so
  // nothing on this page is ever left filtered.
  const open = (segments: readonly DonutSegmentInput[]) => (id: string | null) => {
    const to = segments.find((segment) => segment.id === id)?.to;
    if (to !== undefined) void navigate(to);
  };

  const caseSegments: DonutSegmentInput[] = [
    { id: 'REQUESTED', label: t('enum.caseStatus.REQUESTED'), value: caseCount('REQUESTED'), step: 1, to: '/sellers?status=REQUESTED' },
    { id: 'UNDER_REVIEW', label: t('enum.caseStatus.UNDER_REVIEW'), value: caseCount('UNDER_REVIEW'), step: 3, to: '/sellers?status=UNDER_REVIEW' },
    { id: 'CHANGES_REQUESTED', label: t('enum.caseStatus.CHANGES_REQUESTED'), value: caseCount('CHANGES_REQUESTED'), step: 5, to: '/sellers?status=CHANGES_REQUESTED' },
    { id: 'REREVIEW_REQUIRED', label: t('enum.caseStatus.REREVIEW_REQUIRED'), value: caseCount('REREVIEW_REQUIRED'), step: 'warning', to: '/sellers?status=REREVIEW_REQUIRED' },
    { id: 'QUALIFIED', label: t('enum.caseStatus.QUALIFIED'), value: caseCount('QUALIFIED'), step: 'success', to: '/sellers?status=QUALIFIED' },
    {
      id: 'CLOSED',
      label: t('dashboard.staff.chart.casesClosed'),
      detail: t('dashboard.staff.chart.casesClosedDetail'),
      value: sum(data.cases, CASES_CLOSED),
      step: 'neutral',
      to: '/sellers',
    },
  ];

  const documentSegments: DonutSegmentInput[] = [
    { id: 'SUBMITTED', label: t('enum.documentStatus.SUBMITTED'), value: documentCount('SUBMITTED'), step: 1, to: '/documents?status=SUBMITTED' },
    { id: 'UNDER_REVIEW', label: t('enum.documentStatus.UNDER_REVIEW'), value: documentCount('UNDER_REVIEW'), step: 3, to: '/documents?status=UNDER_REVIEW' },
    { id: 'CHANGES_REQUESTED', label: t('enum.documentStatus.CHANGES_REQUESTED'), value: documentCount('CHANGES_REQUESTED'), step: 5, to: '/documents?status=CHANGES_REQUESTED' },
    { id: 'DRAFT', label: t('enum.documentStatus.DRAFT'), value: documentCount('DRAFT'), step: 6, to: '/documents?status=DRAFT' },
    { id: 'APPROVED', label: t('enum.documentStatus.APPROVED'), value: documentCount('APPROVED'), step: 'success', to: '/documents?status=APPROVED' },
    {
      id: 'CLOSED',
      label: t('dashboard.staff.chart.documentsClosed'),
      detail: t('dashboard.staff.chart.documentsClosedDetail'),
      value: sum(data.documents, DOCUMENTS_CLOSED),
      step: 'neutral',
      to: '/documents',
    },
  ];

  const ruleSegments: DonutSegmentInput[] = [
    { id: 'IN_REVIEW', label: t('enum.ruleStatus.IN_REVIEW'), value: data.rules.waitingForApproval, step: 1, to: '/rules?status=IN_REVIEW' },
    { id: 'DRAFT', label: t('enum.ruleStatus.DRAFT'), value: data.rules.drafts, step: 3, to: '/rules?status=DRAFT' },
    { id: 'APPROVED', label: t('enum.ruleStatus.APPROVED'), value: data.rules.approved, step: 'success', to: '/rules?status=APPROVED' },
  ];

  const inspectionRows: BarRow[] = [
    { id: 'open', label: t('dashboard.staff.jobsOpen'), value: data.inspections.open, to: '/jobs' },
    { id: 'overdue', label: t('dashboard.staff.jobsOverdue'), value: data.inspections.overdue, to: '/jobs?overdue=true', tone: 'danger' },
    { id: 'held', label: t('dashboard.staff.held'), value: data.inspections.held, to: '/jobs', tone: 'warning' },
    { id: 'subLots', label: t('dashboard.staff.subLots'), value: data.inspections.subLotsWaiting, to: '/jobs', tone: 'warning' },
  ];

  const coverageRows: BarRow[] = missing.map((row) => ({ id: row.categoryId, label: row.name, value: row.products, to: '/rules' }));

  const donut = (title: string, hint: string, center: string, unit: string, segments: DonutSegmentInput[], total: number) => (
    <ModernDonutCard
      className="h-full"
      title={title}
      description={hint}
      total={total}
      centerLabel={center}
      unitLabel={unit}
      segments={segments}
      selectedSegment={null}
      onSegmentSelect={open(segments)}
      labels={donutLabels}
    />
  );

  return (
    <ConsoleGround>
      <ConsoleHeader
        title={t('screens.dashboard.title')}
        subtitle={t('dashboard.staff.subtitle')}
        lastUpdatedLabel={t('dashboard.staff.updated', { when: formatRelative(updatedIso) })}
        lastUpdatedAt={updatedIso}
      >
        <Button variant="secondary" size="sm" onClick={onRefresh} disabled={refreshing}>
          {t('common.refresh')}
        </Button>
      </ConsoleHeader>

      {data.rules.approved === 0 && (
        <div className="mb-4">
          <Callout tone="warning" title={t('dashboard.staff.noRulesTitle')}>
            {t('dashboard.staff.noRulesBody')}
          </Callout>
        </div>
      )}

      {/* Key figures: two to a row on a phone, all six in one row on a wide screen. */}
      <ul className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-6">
        <li>
          <KpiTile
            label={t('dashboard.staff.kpi.openCases')}
            value={formatNumber(openCases)}
            sub={t('dashboard.staff.kpi.openCasesSub')}
            to="/sellers"
            {...(openCases > 0 ? { tone: 'warning' as const } : {})}
          />
        </li>
        <li>
          <KpiTile
            label={t('dashboard.staff.kpi.documents')}
            value={formatNumber(toReview)}
            sub={t('dashboard.staff.kpi.documentsSub')}
            to="/documents?status=SUBMITTED"
            {...(toReview > 0 ? { tone: 'warning' as const } : {})}
          />
        </li>
        <li>
          <KpiTile
            label={t('dashboard.staff.expiring30')}
            value={formatNumber(data.documentsExpiringIn30Days)}
            sub={t('dashboard.staff.kpi.expiringSub')}
            to="/documents?expiring=30"
            {...(data.documentsExpiringIn30Days > 0 ? { tone: 'danger' as const } : {})}
          />
        </li>
        <li>
          <KpiTile
            label={t('dashboard.staff.kpi.rules')}
            value={formatNumber(data.rules.approved)}
            sub={t('dashboard.staff.kpi.rulesSub', {
              waiting: formatNumber(data.rules.waitingForApproval),
              drafts: formatNumber(data.rules.drafts),
            })}
            to="/rules"
            {...(data.rules.approved > 0 ? { tone: 'success' as const } : {})}
          />
        </li>
        <li>
          <KpiTile
            label={t('dashboard.staff.kpi.coverage')}
            value={stocked.length === 0 ? '—' : `${String(Math.round((covered / stocked.length) * 100))}%`}
            sub={
              stocked.length === 0
                ? t('dashboard.staff.kpi.coverageNone')
                : t('dashboard.staff.kpi.coverageSub', { covered: formatNumber(covered), total: formatNumber(stocked.length) })
            }
            meter={stocked.length === 0 ? undefined : (covered / stocked.length) * 100}
            to="/rules"
          />
        </li>
        <li>
          <KpiTile
            label={t('dashboard.staff.jobsOverdue')}
            value={formatNumber(data.inspections.overdue)}
            sub={t('dashboard.staff.kpi.overdueSub')}
            to="/jobs?overdue=true"
            {...(data.inspections.overdue > 0 ? { tone: 'danger' as const } : {})}
          />
        </li>
      </ul>

      <BentoGrid>
        {/* --- The queues, as rings ---------------------------------------- */}
        <BentoCell span={3} spanMd={3} className={STRETCH}>
          {donut(
            t('dashboard.staff.casesHeading'),
            t('dashboard.staff.casesHint'),
            t('dashboard.staff.chart.casesCenter'),
            t('dashboard.staff.chart.casesUnit'),
            caseSegments,
            sum(data.cases),
          )}
        </BentoCell>
        <BentoCell span={3} spanMd={3} className={STRETCH}>
          {donut(
            t('dashboard.staff.documentsHeading'),
            t('dashboard.staff.documentsHint'),
            t('dashboard.staff.chart.documentsCenter'),
            t('dashboard.staff.chart.documentsUnit'),
            documentSegments,
            sum(data.documents),
          )}
        </BentoCell>
        <BentoCell span={3} spanMd={3} className={STRETCH}>
          {donut(
            t('dashboard.staff.rulesHeading'),
            t('dashboard.staff.rulesHint'),
            t('dashboard.staff.chart.rulesCenter'),
            t('dashboard.staff.chart.rulesUnit'),
            ruleSegments,
            data.rules.approved + data.rules.waitingForApproval + data.rules.drafts,
          )}
        </BentoCell>

        {/* --- Compared, not shared out: bars ------------------------------ */}
        <BentoCell span={3} spanMd={3} className={STRETCH}>
          <BarListCard
            title={t('dashboard.staff.inspectionsHeading')}
            description={t('dashboard.staff.inspectionsHint')}
            rows={inspectionRows}
            actions={
              <LinkButton to="/jobs" size="sm" variant="ghost">
                {t('dashboard.staff.openList')}
              </LinkButton>
            }
          />
        </BentoCell>
        <BentoCell span={6} spanMd={3} className={STRETCH}>
          <BarListCard
            title={t('dashboard.staff.coverageTitle')}
            description={t('dashboard.staff.coverageHint')}
            rows={coverageRows}
            empty={coverage.isLoading ? t('common.loading') : t('dashboard.staff.coverageEmpty')}
            actions={
              <LinkButton to="/rules" size="sm" variant="ghost">
                {t('dashboard.staff.openList')}
              </LinkButton>
            }
          />
        </BentoCell>
      </BentoGrid>
    </ConsoleGround>
  );
}
