/**
 * The shipment list.
 *
 * A table from `lg` up and a stack of cards below it — not a table with a
 * horizontal scrollbar. A dispatcher on a phone in a yard is reading one
 * consignment at a time, and fifteen columns squeezed into 390px is fifteen
 * columns nobody can read.
 *
 * FILTERS LIVE IN THE URL
 *
 * So a dispatcher can send "look at these" to a colleague, and so the browser's
 * Back button does what it looks like it does. It also means the dashboard's
 * tiles can link straight to a filtered view — `/shipments?slaState=BREACHED`
 * is the whole implementation of "click the number to see them".
 *
 * Paging, sorting and filtering are all SERVER-SIDE. The portal never receives
 * a row it is not entitled to and never receives more than it asked for, which
 * is what makes "the export respects the filters" true by construction rather
 * than by the export remembering to re-apply them.
 */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  PageHeader,
  Select,
  Toolbar,
  ToolbarActions,
  ToolbarField,
  ToolbarToggle,
} from '@/components/ui';
import { DataTable, Pager, type Column } from '@/components/DataTable';
import { useI18n, type Translate } from '@/i18n/i18n-context';
import { useDebounced } from '@/lib/use-debounced';
import { downloadFile } from '@/lib/api';
import { formatDate, formatRelative } from '@/lib/format';
import {
  driversKey,
  fetchDrivers,
  fetchShipments,
  shipmentsKey,
  type ShipmentQuery,
} from '@/lib/logistics';
import { Permission } from '@/lib/permissions';
import { useSession } from '@/auth/session-context';
import { STATUS_GROUPS, formatDuration, slaTone, statusTone } from '@/lib/shipment-display';
import type { ShipmentRow, ShipmentStatus } from '@/lib/types';

const PAGE_SIZE = 25;

export function ShipmentsPage(): React.JSX.Element {
  const { t } = useI18n();
  const { canAny } = useSession();
  const [params, setParams] = useSearchParams();

  const [search, setSearch] = useState(params.get('search') ?? '');
  const debouncedSearch = useDebounced(search, 300);

  const statusFilter = params.get('status');
  const slaFilter = params.get('slaState');
  const driverFilter = params.get('driverProfileId');
  const problemsOnly = params.get('hasException') === '1';
  const page = Number(params.get('page') ?? '1');
  const paramString = params.toString();

  /*
   * The fleet, for the driver filter.
   *
   * Only for somebody who may read it - a driver signing in on a phone holds
   * no DRIVER_READ and has no business being handed the depot's roster. The
   * whole list, because a carrier's fleet is counted in tens; the shipment
   * list next to it is the one that has to page.
   */
  const drivers = useQuery({
    queryKey: driversKey,
    queryFn: fetchDrivers,
    enabled: canAny(Permission.DRIVER_READ),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const query = useMemo<ShipmentQuery>(() => {
    const trimmed = debouncedSearch.trim();

    return {
      ...(trimmed.length > 0 ? { search: trimmed } : {}),
      ...(statusFilter === null ? {} : { status: [statusFilter as ShipmentStatus] }),
      ...(slaFilter === null ? {} : { slaState: [slaFilter] }),
      ...(driverFilter === null ? {} : { driverProfileId: driverFilter }),
      ...(problemsOnly ? { hasException: true } : {}),
      page: Number.isFinite(page) && page > 0 ? page : 1,
      pageSize: PAGE_SIZE,
    };
  }, [debouncedSearch, statusFilter, slaFilter, driverFilter, problemsOnly, page]);

  const shipments = useQuery({
    queryKey: shipmentsKey(query),
    queryFn: () => fetchShipments(query),
    // The table stays on screen while the next page loads, rather than
    // collapsing to a spinner and throwing the scroll position back to the top.
    placeholderData: keepPreviousData,
  });

  function setFilter(key: string, value: string): void {
    const next = new URLSearchParams(params);

    if (value === '') next.delete(key);
    else next.set(key, value);

    // Any filter change resets to page one. Staying on page four of a result
    // set that now has two shows an empty table and reads as broken.
    next.delete('page');
    setParams(next, { replace: true });
  }

  const hasFilters =
    statusFilter !== null ||
    slaFilter !== null ||
    driverFilter !== null ||
    problemsOnly ||
    search.trim().length > 0;
  const columns = useColumns(t);

  return (
    <>
      <PageHeader
        title={t('shipments.heading')}
        actions={
          canAny(Permission.SHIPMENT_EXPORT) ? (
            <Button
              variant="secondary"
              onClick={() => {
                void downloadFile(
                  `/logistics/shipments/export${paramString === '' ? '' : `?${paramString}`}`,
                  'shipments.csv',
                );
              }}
            >
              {t('shipments.export')}
            </Button>
          ) : undefined
        }
      />

      <Card>
        <Toolbar>
          <ToolbarField label={t('shipments.search')} grow>
            <Input
              type="search"
              value={search}
              placeholder={t('shipments.search')}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </ToolbarField>

          <ToolbarField label={t('shipments.column.status')}>
            <Select
              value={statusFilter ?? ''}
              onChange={(event) => {
                setFilter('status', event.target.value);
              }}
            >
              <option value="">{t('common.none')}</option>
              {STATUS_GROUPS.map((group) => (
                <optgroup key={group.labelKey} label={t(group.labelKey)}>
                  {group.statuses.map((entry) => (
                    <option key={entry} value={entry}>
                      {t(`status.${entry}` as never)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </ToolbarField>

          <ToolbarField label={t('shipments.column.sla')}>
            <Select
              value={slaFilter ?? ''}
              onChange={(event) => {
                setFilter('slaState', event.target.value);
              }}
            >
              <option value="">{t('common.none')}</option>
              {(['ON_TRACK', 'AT_RISK', 'BREACHED'] as const).map((entry) => (
                <option key={entry} value={entry}>
                  {t(`sla.${entry}` as never)}
                </option>
              ))}
            </Select>
          </ToolbarField>

          {/* Absent for a driver, who holds no DRIVER_READ - their own round
              is the whole of what they see, and a filter over the depot's
              roster would be a list of colleagues they have no reason for. */}
          {canAny(Permission.DRIVER_READ) ? (
            <ToolbarField label={t('drivers.driverName')}>
              <Select
                value={driverFilter ?? ''}
                onChange={(event) => {
                  setFilter('driverProfileId', event.target.value);
                }}
              >
                <option value="">{t('common.none')}</option>
                {(drivers.data?.drivers ?? []).map((driver) => (
                  <option key={driver.id} value={driver.id}>
                    {driver.fullName}
                  </option>
                ))}
              </Select>
            </ToolbarField>
          ) : null}

          <ToolbarToggle
            label={t('shipments.problemsOnly')}
            checked={problemsOnly}
            onChange={(checked) => {
              setFilter('hasException', checked ? '1' : '');
            }}
          />

          {hasFilters ? (
            <ToolbarActions>
              <Button
                variant="ghost"
                onClick={() => {
                  setSearch('');
                  setParams(new URLSearchParams(), { replace: true });
                }}
              >
                {t('shipments.clearFilters')}
              </Button>
            </ToolbarActions>
          ) : null}
        </Toolbar>

        {/* --- Cards, below `lg` ------------------------------------------ */}
        <div className="lg:hidden">
          {shipments.isLoading ? (
            <LoadingState />
          ) : shipments.isError ? (
            <ErrorState
              error={shipments.error}
              onRetry={() => {
                void shipments.refetch();
              }}
            />
          ) : (shipments.data?.rows.length ?? 0) === 0 ? (
            <EmptyState
              title={hasFilters ? t('shipments.noResults') : t('shipments.emptyTitle')}
              {...(hasFilters ? {} : { description: t('shipments.emptyBody') })}
            />
          ) : (
            <ul className="space-y-3 p-4">
              {shipments.data?.rows.map((row) => (
                <li key={row.id}>
                  <ShipmentCard row={row} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* --- The table, from `lg` up ------------------------------------ */}
        <div className="hidden lg:block">
          <DataTable
            caption={t('shipments.heading')}
            columns={columns}
            rows={shipments.data?.rows}
            rowKey={(row) => row.id}
            isLoading={shipments.isLoading}
            isRefreshing={shipments.isFetching && !shipments.isLoading}
            error={shipments.isError ? shipments.error : undefined}
            onRetry={() => {
              void shipments.refetch();
            }}
            emptyTitle={hasFilters ? t('shipments.noResults') : t('shipments.emptyTitle')}
            {...(hasFilters ? {} : { emptyDescription: t('shipments.emptyBody') })}
            minWidth="56rem"
          />
        </div>

        {shipments.data === undefined ? null : (
          <Pager
            page={shipments.data.page}
            limit={shipments.data.pageSize}
            total={shipments.data.total}
            totalPages={shipments.data.pageCount}
            onPageChange={(next) => {
              const updated = new URLSearchParams(params);
              updated.set('page', String(next));
              setParams(updated, { replace: true });
            }}
          />
        )}
      </Card>
    </>
  );
}

/**
 * The columns.
 *
 * `secondary` and `tertiary` are what a narrow desktop drops first: the driver
 * and the last-update time are context, the reference and the status are
 * identity. Below `lg` none of this renders at all - the cards above take
 * over.
 */
function useColumns(t: Translate): Column<ShipmentRow>[] {
  return useMemo(
    () => [
      {
        key: 'reference',
        header: t('shipments.column.reference'),
        nowrap: true,
        render: (row) => (
          <Link to={`/shipments/${row.id}`} className="font-medium text-brand hover:underline">
            {row.shipmentReference}
            {row.orderReference === null ? null : (
              <span className="ml-2 text-xxs font-normal text-ink-subtle">
                {row.orderReference}
              </span>
            )}
          </Link>
        ),
      },
      {
        key: 'receiver',
        header: t('shipments.column.receiver'),
        render: (row) => (
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{row.receivingCompanyName}</span>
            {row.requiresColdChain ? <Badge tone="brand">{t('shipment.coldChain')}</Badge> : null}
            {row.isDangerousGoods ? (
              <Badge tone="danger">{t('shipment.dangerousGoods')}</Badge>
            ) : null}
          </span>
        ),
      },
      {
        key: 'destination',
        header: t('shipments.column.destination'),
        secondary: true,
        render: (row) => (
          <span className="text-ink-muted">
            {row.destinationCity ?? '—'}, {row.destinationCountry}
          </span>
        ),
      },
      {
        key: 'status',
        header: t('shipments.column.status'),
        nowrap: true,
        render: (row) => (
          <Badge tone={statusTone(row.status)} dot>
            {t(`status.${row.status}` as never)}
          </Badge>
        ),
      },
      {
        key: 'sla',
        header: t('shipments.column.sla'),
        nowrap: true,
        render: (row) => <SlaCell row={row} t={t} />,
      },
      {
        key: 'delivery',
        header: t('shipments.column.delivery'),
        align: 'right',
        nowrap: true,
        secondary: true,
        render: (row) => formatDate(row.estimatedDeliveryAt),
      },
      {
        key: 'driver',
        header: t('shipments.column.driver'),
        tertiary: true,
        render: (row) => <span className="text-ink-muted">{row.assignedDriverName ?? '—'}</span>,
      },
      {
        key: 'lastEvent',
        header: t('shipments.column.lastEvent'),
        tertiary: true,
        nowrap: true,
        render: (row) => <span className="text-ink-muted">{formatRelative(row.lastEventAt)}</span>,
      },
    ],
    [t],
  );
}

/**
 * The SLA cell.
 *
 * Badge plus a figure, never a colour alone: "At risk · 40m" tells somebody
 * who cannot distinguish amber from red exactly as much as it tells anybody
 * else, which is the whole of the accessibility rule on this screen.
 */
function SlaCell({ row, t }: { row: ShipmentRow; t: Translate }): React.JSX.Element {
  const sla = row.sla;

  const detail =
    sla.state === 'BREACHED' && sla.minutesLate > 0
      ? formatDuration(sla.minutesLate)
      : sla.minutesRemaining !== null
        ? formatDuration(sla.minutesRemaining)
        : null;

  return (
    <span className="inline-flex items-center gap-2">
      <Badge tone={slaTone(sla.state)} dot>
        {t(`sla.${sla.state}` as never)}
      </Badge>
      {detail === null ? null : <span className="tabular text-xxs text-ink-subtle">{detail}</span>}
    </span>
  );
}

/** One consignment, for a phone. */
function ShipmentCard({ row }: { row: ShipmentRow }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Link
      to={`/shipments/${row.id}`}
      className="block rounded-lg border border-border bg-surface p-4 shadow-card transition-shadow hover:border-border-hover hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{row.receivingCompanyName}</p>
          <p className="mt-0.5 truncate text-xs text-ink-subtle">
            {row.shipmentReference}
            {row.destinationCity === null ? '' : ` · ${row.destinationCity}`}
          </p>
        </div>
        <Badge tone={statusTone(row.status)} dot>
          {t(`status.${row.status}` as never)}
        </Badge>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
        <span>
          {t('shipments.column.packages')}: <span className="tabular">{row.packageCount}</span>
        </span>
        {row.estimatedDeliveryAt === null ? null : (
          <span className="tabular">{formatDate(row.estimatedDeliveryAt)}</span>
        )}
        {row.lastEventAt === null ? null : <span>{formatRelative(row.lastEventAt)}</span>}
      </div>

      {row.sla.state === 'AT_RISK' || row.sla.state === 'BREACHED' || row.openExceptionCount > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {row.sla.state === 'AT_RISK' || row.sla.state === 'BREACHED' ? (
            <Badge tone={slaTone(row.sla.state)} dot>
              {t(`sla.${row.sla.state}` as never)}
            </Badge>
          ) : null}
          {row.openExceptionCount > 0 ? (
            <Badge tone="warning">
              {t('dashboard.exceptions')}: {row.openExceptionCount}
            </Badge>
          ) : null}
        </div>
      ) : null}
    </Link>
  );
}
