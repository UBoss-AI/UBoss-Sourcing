/**
 * The day at a glance.
 *
 * Two audiences, decided by the server from the session (`audience`):
 *
 *   - an AGENCY member sees their own agency's work: jobs by status, what is
 *     overdue against its deadline, the inspectors, and recent reports;
 *   - audit STAFF see the queues: cases, documents, rules and inspections,
 *     each a tile that opens the list it counts.
 *
 * Every figure is the server's count. Nothing is added up here except the
 * sum of two of the server's own case counts, and that sum says which two.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { EnumBadge, QueryBoundary, ResponsiveTable, CardField, StatTile } from '@/components/console';
import { Badge, Callout, Card, LinkButton, PageHeader } from '@/components/ui';
import { useCurrentUser } from '@/auth/session-context';
import { useI18n, type Translate } from '@/i18n/i18n-context';
import { consoleKeys, fetchDashboard } from '@/lib/console-api';
import type { AgencyDashboard, StaffDashboard } from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { formatCalendarDate, formatDateTime, formatNumber } from '@/lib/format';
import { agencyKindLabel, roleLabel } from '@/lib/labels';
import type { AuditRole } from '@/lib/types';

export function DashboardPage(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: consoleKeys.dashboard(), queryFn: fetchDashboard });

  return (
    <>
      <PageHeader title={t('screens.dashboard.title')} description={t('screens.dashboard.description')} />
      <QueryBoundary query={query}>
        {(data) =>
          data.audience === 'AGENCY' ? <AgencyView data={data.agency} /> : <StaffView data={data.staff} />
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

function StaffView({ data }: { data: StaffDashboard }): React.JSX.Element {
  const { t } = useI18n();
  const cases = (status: string): number => data.cases[status] ?? 0;
  const documents = (status: string): number => data.documents[status] ?? 0;

  const groups: {
    key: string;
    title: string;
    hint: string;
    tiles: { label: string; value: number; to: string; tone?: 'warning' | 'danger' | 'success'; sub?: string }[];
  }[] = [
    {
      key: 'cases',
      title: t('dashboard.staff.casesHeading'),
      hint: t('dashboard.staff.casesHint'),
      tiles: [
        { label: t('enum.caseStatus.REQUESTED'), value: cases('REQUESTED'), to: '/sellers?status=REQUESTED', tone: 'warning' },
        { label: t('enum.caseStatus.UNDER_REVIEW'), value: cases('UNDER_REVIEW'), to: '/sellers?status=UNDER_REVIEW' },
        { label: t('enum.caseStatus.REREVIEW_REQUIRED'), value: cases('REREVIEW_REQUIRED'), to: '/sellers?status=REREVIEW_REQUIRED', tone: 'warning' },
        { label: t('enum.caseStatus.CHANGES_REQUESTED'), value: cases('CHANGES_REQUESTED'), to: '/sellers?status=CHANGES_REQUESTED' },
        { label: t('enum.caseStatus.QUALIFIED'), value: cases('QUALIFIED'), to: '/sellers?status=QUALIFIED', tone: 'success' },
      ],
    },
    {
      key: 'documents',
      title: t('dashboard.staff.documentsHeading'),
      hint: t('dashboard.staff.documentsHint'),
      tiles: [
        { label: t('enum.documentStatus.SUBMITTED'), value: documents('SUBMITTED'), to: '/documents?status=SUBMITTED', tone: 'warning' },
        { label: t('enum.documentStatus.UNDER_REVIEW'), value: documents('UNDER_REVIEW'), to: '/documents?status=UNDER_REVIEW' },
        {
          label: t('dashboard.staff.expiring30'),
          value: data.documentsExpiringIn30Days,
          to: '/documents?expiring=30',
          tone: 'danger',
        },
        { label: t('enum.documentStatus.APPROVED'), value: documents('APPROVED'), to: '/documents?status=APPROVED', tone: 'success' },
      ],
    },
    {
      key: 'rules',
      title: t('dashboard.staff.rulesHeading'),
      hint: t('dashboard.staff.rulesHint'),
      tiles: [
        { label: t('enum.ruleStatus.IN_REVIEW'), value: data.rules.waitingForApproval, to: '/rules?status=IN_REVIEW', tone: 'warning' },
        { label: t('enum.ruleStatus.DRAFT'), value: data.rules.drafts, to: '/rules?status=DRAFT' },
        { label: t('enum.ruleStatus.APPROVED'), value: data.rules.approved, to: '/rules?status=APPROVED', tone: 'success' },
      ],
    },
    {
      key: 'inspections',
      title: t('dashboard.staff.inspectionsHeading'),
      hint: t('dashboard.staff.inspectionsHint'),
      tiles: [
        { label: t('dashboard.staff.jobsOpen'), value: data.inspections.open, to: '/jobs' },
        { label: t('dashboard.staff.jobsOverdue'), value: data.inspections.overdue, to: '/jobs?overdue=true', tone: 'danger' },
        { label: t('dashboard.staff.held'), value: data.inspections.held, to: '/jobs', tone: 'warning', sub: t('dashboard.staff.heldHint') },
        {
          label: t('dashboard.staff.subLots'),
          value: data.inspections.subLotsWaiting,
          to: '/jobs',
          tone: 'warning',
          sub: t('dashboard.staff.subLotsHint'),
        },
      ],
    },
  ];

  return (
    <div className="space-y-8">
      {data.rules.approved === 0 && (
        <Callout tone="warning" title={t('dashboard.staff.noRulesTitle')}>
          {t('dashboard.staff.noRulesBody')}
        </Callout>
      )}
      {groups.map((group) => (
        <section key={group.key} aria-labelledby={`dash-${group.key}`}>
          <div className="mb-3">
            <h2 id={`dash-${group.key}`} className="text-title-xs text-ink">
              {group.title}
            </h2>
            <p className="mt-0.5 text-xs text-ink-muted">{group.hint}</p>
          </div>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {group.tiles.map((tile) => (
              <li key={tile.label}>
                <Link to={tile.to} className="block h-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
                  <StatTile
                    label={tile.label}
                    value={formatNumber(tile.value)}
                    sub={tile.sub}
                    {...(tile.value > 0 && tile.tone !== undefined ? { tone: tile.tone } : {})}
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
