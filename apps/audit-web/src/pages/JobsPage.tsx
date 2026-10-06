/**
 * Inspection jobs: an agency sees its own (an inspector only the jobs they are
 * named on), audit staff oversee every agency's.
 *
 * The filters live in the address, so a dashboard tile can open the list
 * already narrowed ("overdue", "awaiting quality review") and a filtered list
 * can be bookmarked or sent to a colleague. Which jobs come back is the
 * server's decision from the session; the agency filter is only offered to
 * staff, and the server ignores it for anybody else.
 */
import { useEffect, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { CardField, EnumBadge, QueryBoundary, ResponsiveTable } from '@/components/console';
import type { Column } from '@/components/DataTable';
import {
  Badge,
  Button,
  Card,
  Input,
  PageHeader,
  Select,
  Toolbar,
  ToolbarActions,
  ToolbarField,
  ToolbarToggle,
} from '@/components/ui';
import { useCurrentUser, useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, fetchJobs, fetchTeam, type JobFilters } from '@/lib/console-api';
import { INSPECTION_STAGES, JOB_STATUSES, type JobRow } from '@/lib/console-types';
import { enumLabel, placeLine } from '@/lib/enum-labels';
import { formatDateTime, formatNumber } from '@/lib/format';
import { agencyKindLabel } from '@/lib/labels';
import { Permission } from '@/lib/permissions';
import type { AgencyKind } from '@/lib/types';
import { useDebounced } from '@/lib/use-debounced';

export function JobsPage(): React.JSX.Element {
  const { t } = useI18n();
  const session = useCurrentUser();
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const isStaff = session.member.kind === 'STAFF';

  const status = params.get('status') ?? '';
  const stage = params.get('stage') ?? '';
  const agencyId = params.get('agency') ?? '';
  const overdue = params.get('overdue') === 'true';

  // The search box is typed into freely; the address follows once typing pauses.
  const [search, setSearch] = useState(params.get('search') ?? '');
  const settled = useDebounced(search.trim());

  const update = (changes: Record<string, string | null>): void => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [name, value] of Object.entries(changes)) {
          if (value === null || value === '') next.delete(name);
          else next.set(name, value);
        }
        return next;
      },
      { replace: true },
    );
  };

  useEffect(() => {
    if ((params.get('search') ?? '') !== settled) update({ search: settled });
    // Only the settled text drives the address; `params` changing must not loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);

  const filters: JobFilters = {
    ...(status === '' ? {} : { status }),
    ...(stage === '' ? {} : { stage }),
    ...(agencyId === '' || !isStaff ? {} : { agencyId }),
    ...(settled === '' ? {} : { search: settled }),
    ...(overdue ? { overdue: true } : {}),
  };

  const jobs = useQuery({
    queryKey: consoleKeys.jobs({ ...filters }),
    queryFn: () => fetchJobs(filters),
    placeholderData: keepPreviousData,
  });

  const team = useQuery({
    queryKey: consoleKeys.team(),
    queryFn: fetchTeam,
    enabled: isStaff && can(Permission.TEAM_READ),
  });

  const filtered = status !== '' || stage !== '' || agencyId !== '' || overdue || search !== '';
  const ownKind = session.member.agency?.kind;

  return (
    <>
      <PageHeader title={t('screens.jobs.title')} description={t('screens.jobs.description')} />

      <Card>
        <Toolbar>
          <ToolbarField label={t('common.search')} grow>
            <Input
              type="search"
              value={search}
              placeholder={t('jobs.searchPlaceholder')}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </ToolbarField>
          <ToolbarField label={t('common.status')}>
            <Select
              value={status}
              onChange={(event) => {
                update({ status: event.target.value });
              }}
            >
              <option value="">{t('common.all')}</option>
              {JOB_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {enumLabel(t, 'jobStatus', value)}
                </option>
              ))}
            </Select>
          </ToolbarField>
          <ToolbarField label={t('jobs.stage')}>
            <Select
              value={stage}
              onChange={(event) => {
                update({ stage: event.target.value });
              }}
            >
              <option value="">{t('common.all')}</option>
              {INSPECTION_STAGES.map((value) => (
                <option key={value} value={value}>
                  {enumLabel(t, 'stage', value)}
                </option>
              ))}
            </Select>
          </ToolbarField>
          {isStaff && team.data !== undefined && team.data.agencies.length > 0 && (
            <ToolbarField label={t('jobs.agency')}>
              <Select
                value={agencyId}
                onChange={(event) => {
                  update({ agency: event.target.value });
                }}
              >
                <option value="">{t('common.all')}</option>
                {team.data.agencies.map((agency) => (
                  <option key={agency.id} value={agency.id}>
                    {agency.name}
                  </option>
                ))}
              </Select>
            </ToolbarField>
          )}
          <ToolbarToggle
            label={t('jobs.overdueOnly')}
            checked={overdue}
            onChange={(checked) => {
              update({ overdue: checked ? 'true' : null });
            }}
          />
          {filtered && (
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

        <QueryBoundary query={jobs}>
          {(data) => (
            <JobsTable
              rows={data.jobs}
              isStaff={isStaff}
              ownKind={ownKind}
              filtered={filtered}
              isRefreshing={jobs.isFetching && jobs.isPlaceholderData}
            />
          )}
        </QueryBoundary>
      </Card>
    </>
  );
}

function JobsTable({
  rows,
  isStaff,
  ownKind,
  filtered,
  isRefreshing,
}: {
  rows: JobRow[];
  isStaff: boolean;
  ownKind: AgencyKind | undefined;
  filtered: boolean;
  isRefreshing: boolean;
}): React.JSX.Element {
  const { t } = useI18n();

  const agencyCell = (row: JobRow): React.JSX.Element => {
    const kind = row.agencyKind ?? ownKind;
    return (
      <div className="min-w-0">
        <p className="truncate">{row.agencyName ?? '—'}</p>
        {kind !== undefined && <p className="text-xs text-ink-muted">{agencyKindLabel(t, kind)}</p>}
      </div>
    );
  };

  const jobLink = (row: JobRow): React.JSX.Element => (
    <Link to={`/jobs/${encodeURIComponent(row.id)}`} className="font-medium text-accent hover:underline">
      {row.jobNumber}
    </Link>
  );

  const columns: Column<JobRow>[] = [
    {
      key: 'job',
      header: t('jobs.column.job'),
      nowrap: true,
      render: (row) => (
        <div className="space-y-1">
          {jobLink(row)}
          {row.kind === 'REINSPECTION' && (
            <div>
              <EnumBadge family="jobKind" value={row.kind} dot={false} />
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'seller',
      header: t('jobs.column.seller'),
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate">{row.sellerName}</p>
          <p className="text-xs text-ink-muted">
            {row.sellerOrderNumber}
            {row.lotReference !== undefined && row.lotReference !== null && row.lotReference !== '' && (
              <> · {t('jobs.lot', { lot: row.lotReference })}</>
            )}
          </p>
        </div>
      ),
    },
    {
      key: 'stage',
      header: t('jobs.column.stageMethod'),
      secondary: true,
      render: (row) => (
        <div className="space-y-0.5 text-xs">
          <p className="text-ink">{enumLabel(t, 'stage', row.stage)}</p>
          <p className="text-ink-muted">{enumLabel(t, 'scopeMethod', row.scopeMethod)}</p>
        </div>
      ),
    },
    { key: 'status', header: t('common.status'), render: (row) => <EnumBadge family="jobStatus" value={row.status} /> },
    {
      key: 'scheduled',
      header: t('jobs.column.scheduled'),
      nowrap: true,
      render: (row) => (
        <div className="text-xs">
          <p className="text-ink">{formatDateTime(row.scheduledFor)}</p>
          <p className="max-w-56 truncate text-ink-muted">{placeLine(row.inspectionPoint) ?? enumLabel(t, 'inspectionPointType', row.inspectionPointType)}</p>
        </div>
      ),
    },
    ...(isStaff
      ? [{ key: 'agency', header: t('jobs.column.agency'), tertiary: true, render: agencyCell } satisfies Column<JobRow>]
      : []),
    {
      key: 'lot',
      header: t('jobs.column.lotSize'),
      align: 'right',
      tertiary: true,
      render: (row) => formatNumber(row.lotSize),
    },
    {
      key: 'sla',
      header: t('jobs.column.deadline'),
      render: (row) =>
        row.slaState === 'ON_TIME' ? (
          <span className="text-xs text-ink-muted">{formatDateTime(row.status === 'REQUESTED' ? row.acceptDueAt : row.reportDueAt)}</span>
        ) : (
          <EnumBadge family="slaState" value={row.slaState} />
        ),
    },
  ];

  return (
    <ResponsiveTable
      caption={t('screens.jobs.title')}
      rows={rows}
      rowKey={(row) => row.id}
      columns={columns}
      minWidth="56rem"
      isRefreshing={isRefreshing}
      emptyTitle={filtered ? t('jobs.emptyFiltered') : t('jobs.empty')}
      emptyDescription={filtered ? t('jobs.emptyFilteredHint') : t('jobs.emptyHint')}
      rowClassName={(row) => (row.slaState === 'ON_TIME' ? undefined : 'bg-danger-soft/40')}
      card={(row) => (
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              {jobLink(row)}
              <p className="truncate text-sm text-ink">{row.sellerName}</p>
              <p className="text-xs text-ink-muted">{row.sellerOrderNumber}</p>
            </div>
            <EnumBadge family="jobStatus" value={row.status} />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone="neutral">{enumLabel(t, 'stage', row.stage)}</Badge>
            <Badge tone="neutral">{enumLabel(t, 'scopeMethod', row.scopeMethod)}</Badge>
            {row.kind === 'REINSPECTION' && <EnumBadge family="jobKind" value={row.kind} dot={false} />}
            {row.slaState !== 'ON_TIME' && <EnumBadge family="slaState" value={row.slaState} />}
          </div>
          <CardField label={t('jobs.column.scheduled')}>{formatDateTime(row.scheduledFor)}</CardField>
          {isStaff && (
            <CardField label={t('jobs.column.agency')}>
              {row.agencyName ?? '—'}
              {row.agencyKind !== undefined && <> · {agencyKindLabel(t, row.agencyKind)}</>}
            </CardField>
          )}
          <CardField label={t('jobs.column.lotSize')}>{formatNumber(row.lotSize)}</CardField>
        </div>
      )}
    />
  );
}
