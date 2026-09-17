/**
 * Consignments, across every carrier.
 *
 * The carrier's own portal shows each of them only their own work. This shows
 * all of it, and the column that matters most is the one their screen does not
 * have: which carrier is holding it, and whether anybody is.
 *
 * "Waiting for a carrier" is the default view rather than "everything",
 * because an unassigned consignment is the only row on this screen that needs
 * somebody here to act. Everything else is somebody else's job and this list
 * is for watching it.
 *
 * Paging, filtering and searching all happen on the server. A list that pages
 * in the browser is a list that lies about its total the moment it exceeds one
 * page, and this one is expected to run to tens of thousands of rows.
 */
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import {
  Badge,
  Button,
  Card,
  Input,
  PageHeader,
  Select,
  SummaryTiles,
  Toolbar,
  ToolbarActions,
  ToolbarField,
  ToolbarToggle,
} from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { formatDateTime, formatNumber, humanise } from '@/lib/format';
import {
  fetchAdminShipments,
  fetchPartners,
  fetchTrackingFilters,
  shipmentStatusTone,
  slaKey,
  slaTone,
  statusLabelKey,
  trackingFiltersKey,
  type AdminShipmentRow,
  type ShipmentStatus,
} from '@/lib/logistics';

const PAGE_SIZE = 25;

/**
 * The statuses a filter offers, grouped the way an operations desk thinks
 * rather than as one flat list of twenty-seven. Somebody filtering for
 * "anything that has gone wrong" should not have to pick eight scattered
 * members out of an alphabetical list.
 */
const STATUS_GROUPS: readonly {
  labelKey:
    | 'logistics.statusGroup.waiting'
    | 'logistics.statusGroup.moving'
    | 'logistics.statusGroup.problem'
    | 'logistics.statusGroup.finished';
  statuses: readonly ShipmentStatus[];
}[] = [
  {
    labelKey: 'logistics.statusGroup.waiting',
    statuses: ['CREATED', 'AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTANCE_PENDING', 'ACCEPTED'],
  },
  {
    labelKey: 'logistics.statusGroup.moving',
    statuses: [
      'PICKUP_SCHEDULED',
      'READY_FOR_PICKUP',
      'PICKED_UP',
      'DISPATCHED',
      'AT_ORIGIN_HUB',
      'IN_TRANSIT',
      'AT_DESTINATION_HUB',
      'OUT_FOR_DELIVERY',
    ],
  },
  {
    labelKey: 'logistics.statusGroup.problem',
    statuses: [
      'DELIVERY_ATTEMPTED',
      'DELAYED',
      'ON_HOLD',
      'ADDRESS_ISSUE',
      'CUSTOMS_HOLD',
      'DAMAGED',
      'TEMPERATURE_EXCEPTION',
      'DELIVERY_FAILED',
    ],
  },
  {
    labelKey: 'logistics.statusGroup.finished',
    statuses: [
      'DELIVERED',
      'RETURN_REQUESTED',
      'RETURN_IN_TRANSIT',
      'RETURNED',
      'LOST',
      'CANCELLED',
    ],
  },
];

/** Module-level so the search debounce survives a re-render without a ref. */
let searchTimer = 0;

export function LogisticsShipmentsPage(): React.JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const status = params.get('status') ?? '';
  const partnerId = params.get('partnerId') ?? '';
  const unassignedOnly = params.get('unassignedOnly') === '1';
  const exceptionsOnly = params.get('exceptionsOnly') === '1';
  const customerProfileId = params.get('customerProfileId') ?? '';
  const sellerAccountId = params.get('sellerAccountId') ?? '';
  const warehouseId = params.get('warehouseId') ?? '';
  const driverProfileId = params.get('driverProfileId') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const search = params.get('search') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1'));

  /*
   * The carrier filter's options. Its own request rather than derived from the
   * rows on screen: a carrier with nothing on page one still has to be
   * selectable, which is exactly when somebody goes looking for them.
   */
  const partners = useQuery({
    queryKey: ['admin', 'logistics', 'partners', 'picker'],
    queryFn: () => fetchPartners(new URLSearchParams({ status: 'ACTIVE' })),
    staleTime: 5 * 60_000,
  });

  /*
   * The other five filters' options, in one request.
   *
   * Derived from the consignments that exist rather than from the tables
   * behind them: a seller list holding every approved business on the
   * marketplace would be mostly companies that have never shipped anything,
   * and scrolling it teaches an operator nothing. Reference data for a filter
   * bar, so it is cached for a while rather than re-read on every keystroke.
   */
  const options = useQuery({
    queryKey: trackingFiltersKey,
    queryFn: fetchTrackingFilters,
    staleTime: 5 * 60_000,
  });

  const query = useQuery({
    // Every input the server sees is in the key, so changing a filter
    // refetches rather than filtering a list the server already narrowed.
    queryKey: [
      'admin',
      'logistics',
      'shipments',
      {
        status,
        partnerId,
        unassignedOnly,
        exceptionsOnly,
        customerProfileId,
        sellerAccountId,
        warehouseId,
        driverProfileId,
        from,
        to,
        search,
        page,
      },
    ],
    queryFn: () => {
      const next = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (status.length > 0) next.set('status', status);
      if (partnerId.length > 0) next.set('partnerId', partnerId);
      if (unassignedOnly) next.set('unassignedOnly', 'true');
      if (exceptionsOnly) next.set('exceptionsOnly', 'true');
      if (customerProfileId.length > 0) next.set('customerProfileId', customerProfileId);
      if (sellerAccountId.length > 0) next.set('sellerAccountId', sellerAccountId);
      if (warehouseId.length > 0) next.set('warehouseId', warehouseId);
      if (driverProfileId.length > 0) next.set('driverProfileId', driverProfileId);
      /*
       * Dates arrive from a date input as a day; the server wants instants.
       *
       * The end of the range is exclusive on the server, so `to` is sent as
       * the START of the following day - without that, a range of one day
       * matches nothing, which is the commonest way a date filter is quietly
       * wrong. Both are built in the reader's own zone, because a day on a
       * date input is a day where the reader is standing.
       */
      if (from.length > 0) next.set('from', new Date(`${from}T00:00:00`).toISOString());
      if (to.length > 0) {
        const end = new Date(`${to}T00:00:00`);
        end.setDate(end.getDate() + 1);
        next.set('to', end.toISOString());
      }
      if (search.length > 0) next.set('search', search);
      return fetchAdminShipments(next);
    },
  });

  /** Whether anything is narrowing the list, so the Clear control can appear. */
  const isFiltered = [
    status,
    partnerId,
    customerProfileId,
    sellerAccountId,
    warehouseId,
    driverProfileId,
    from,
    to,
    search,
  ].some((value) => value.length > 0) || unassignedOnly || exceptionsOnly;

  const update = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value.length === 0) next.delete(key);
    else next.set(key, value);
    // A filter change invalidates the page number it was paired with.
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const columns: Column<AdminShipmentRow>[] = [
    {
      key: 'reference',
      header: t('logistics.shipments.column.reference'),
      nowrap: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{row.shipmentReference}</p>
          <p className="truncate text-xxs text-ink-subtle">{row.trackingNumber}</p>
        </div>
      ),
    },
    {
      key: 'route',
      header: t('logistics.shipments.column.route'),
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-ink">{row.receivingCompanyName}</p>
          <p className="truncate text-xxs text-ink-subtle">
            {row.sellerCompanyName} →{' '}
            {row.destinationCity === null
              ? row.destinationCountry
              : `${row.destinationCity}, ${row.destinationCountry}`}
          </p>
        </div>
      ),
    },
    {
      key: 'carrier',
      header: t('logistics.shipments.column.carrier'),
      render: (row) => (
        <div className="min-w-0">
          {row.assignedPartner === null ? (
            <Badge tone="warning" dot>
              {t('logistics.shipments.unassigned')}
            </Badge>
          ) : (
            <p className="truncate text-xs text-ink-muted">{row.assignedPartner.displayName}</p>
          )}

          {/* Who, across every carrier, is holding this parcel. The one
              column the carriers' own portals cannot have, and the reason an
              operator answering the telephone opens this screen rather than
              ringing round. */}
          {row.driver !== null && (
            <p className="truncate text-xxs text-ink-subtle">{row.driver.fullName}</p>
          )}
        </div>
      ),
    },
    {
      key: 'origin',
      header: t('logistics.shipments.column.origin'),
      secondary: true,
      tertiary: true,
      render: (row) =>
        row.originLocation === null ? (
          <span className="text-xxs text-ink-subtle">—</span>
        ) : (
          <span className="text-xs text-ink-muted">{row.originLocation.name}</span>
        ),
    },
    {
      key: 'packages',
      header: t('logistics.shipments.column.packages'),
      align: 'right',
      tertiary: true,
      render: (row) => (
        <span className="text-xs text-ink-muted">{formatNumber(row.packageCount)}</span>
      ),
    },
    {
      key: 'due',
      header: t('logistics.shipments.column.due'),
      secondary: true,
      nowrap: true,
      render: (row) => (
        <div>
          <p className="text-xs text-ink-muted">{formatDateTime(row.estimatedDeliveryAt)}</p>
          <p className="text-xxs text-ink-subtle">
            {t('logistics.shipments.pickup', { when: formatDateTime(row.expectedPickupAt) })}
          </p>
        </div>
      ),
    },
    {
      key: 'sla',
      header: t('logistics.shipments.column.sla'),
      align: 'center',
      secondary: true,
      render: (row) => (
        <Badge tone={slaTone(row.slaState)} dot>
          {t(slaKey(row.slaState))}
        </Badge>
      ),
    },
    {
      key: 'status',
      header: t('logistics.shipments.column.status'),
      align: 'center',
      render: (row) => (
        <div className="flex flex-col items-center gap-1">
          <Badge tone={shipmentStatusTone(row.status)} dot>
            {t(statusLabelKey(row.status))}
          </Badge>
          {/* A problem nobody has worked, which is a different question from
              the status: a parcel can be in transit and still have an address
              nobody can find. */}
          {row.openException !== null && (
            <span className="text-xxs font-medium text-danger">
              {humanise(row.openException.type)}
            </span>
          )}
        </div>
      ),
    },
  ];

  const summary = query.data?.summary;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('logistics.shipments.heading')}
        description={t('logistics.shipments.intro')}
      />

      {/*
        The tiles describe the FILTERED list, not the whole marketplace - a
        desk that has narrowed to one carrier and still sees everybody's totals
        is a desk reading the wrong number. Coloured only where there is
        something to act on: a warning tone over a zero teaches people to
        ignore the tone.
      */}
      {summary !== undefined && (
        <SummaryTiles
          items={[
            {
              label: t('logistics.shipments.tile.awaiting'),
              value: formatNumber(summary.awaitingAssignment),
              tone: summary.awaitingAssignment > 0 ? 'warning' : 'default',
            },
            {
              label: t('logistics.shipments.tile.inTransit'),
              value: formatNumber(summary.inTransit),
            },
            {
              label: t('logistics.shipments.tile.outForDelivery'),
              value: formatNumber(summary.outForDelivery),
            },
            {
              label: t('logistics.shipments.tile.delivered'),
              value: formatNumber(summary.delivered),
            },
            {
              label: t('logistics.shipments.tile.failed'),
              value: formatNumber(summary.failed),
              tone: summary.failed > 0 ? 'danger' : 'default',
            },
            {
              label: t('logistics.shipments.tile.exceptions'),
              value: formatNumber(summary.withOpenException),
              tone: summary.withOpenException > 0 ? 'danger' : 'default',
            },
          ]}
        />
      )}

      <Card>
        <Toolbar>
          <ToolbarField label={t('logistics.shipments.filter.status')} className="w-52">
            <Select
              value={status}
              onChange={(event) => {
                update('status', event.currentTarget.value);
              }}
            >
              <option value="">{t('logistics.shipments.filter.everyStatus')}</option>
              {STATUS_GROUPS.map((group) => (
                <optgroup key={group.labelKey} label={t(group.labelKey)}>
                  {group.statuses.map((value) => (
                    <option key={value} value={value}>
                      {t(statusLabelKey(value))}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </ToolbarField>

          <ToolbarField label={t('logistics.shipments.filter.carrier')} className="w-44">
            <Select
              value={partnerId}
              onChange={(event) => {
                update('partnerId', event.currentTarget.value);
              }}
            >
              <option value="">{t('logistics.shipments.filter.everyCarrier')}</option>
              {(partners.data?.partners ?? []).map((partner) => (
                <option key={partner.id} value={partner.id}>
                  {partner.displayName}
                </option>
              ))}
            </Select>
          </ToolbarField>

          {/*
            The four company-and-people axes.

            Each one is a question an operations desk arrives with - "what is
            going wrong for St Luke's", "is Northwind's stock stuck at one
            depot", "which of this carrier's drivers has our failures" - and
            each narrows on the server against an index. A desk that cannot ask
            on the axis it cares about ends up paging through everything.
          */}
          <ToolbarField label={t('logistics.shipments.filter.buyer')} className="w-44">
            <Select
              value={customerProfileId}
              onChange={(event) => {
                update('customerProfileId', event.currentTarget.value);
              }}
            >
              <option value="">{t('logistics.shipments.filter.everyBuyer')}</option>
              {(options.data?.customers ?? []).map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </Select>
          </ToolbarField>

          <ToolbarField label={t('logistics.shipments.filter.seller')} className="w-44">
            <Select
              value={sellerAccountId}
              onChange={(event) => {
                update('sellerAccountId', event.currentTarget.value);
              }}
            >
              <option value="">{t('logistics.shipments.filter.everySeller')}</option>
              {(options.data?.sellers ?? []).map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </Select>
          </ToolbarField>

          <ToolbarField label={t('logistics.shipments.filter.warehouse')} className="w-44">
            <Select
              value={warehouseId}
              onChange={(event) => {
                update('warehouseId', event.currentTarget.value);
              }}
            >
              <option value="">{t('logistics.shipments.filter.everyWarehouse')}</option>
              {(options.data?.warehouses ?? []).map((warehouse) => (
                <option key={warehouse.id} value={warehouse.id}>
                  {warehouse.name}
                </option>
              ))}
            </Select>
          </ToolbarField>

          <ToolbarField label={t('logistics.shipments.filter.driver')} className="w-48">
            <Select
              value={driverProfileId}
              onChange={(event) => {
                update('driverProfileId', event.currentTarget.value);
              }}
            >
              <option value="">{t('logistics.shipments.filter.everyDriver')}</option>
              {(options.data?.drivers ?? []).map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {/* Named with their carrier, because two carriers can employ
                      an Ilse Maes and a list of bare names is a list nobody
                      can choose from. */}
                  {driver.fullName} · {driver.partnerName}
                </option>
              ))}
            </Select>
          </ToolbarField>

          <ToolbarField label={t('logistics.shipments.filter.from')} className="w-40">
            <Input
              type="date"
              value={from}
              onChange={(event) => {
                update('from', event.currentTarget.value);
              }}
            />
          </ToolbarField>

          <ToolbarField label={t('logistics.shipments.filter.to')} className="w-40">
            <Input
              type="date"
              value={to}
              onChange={(event) => {
                update('to', event.currentTarget.value);
              }}
            />
          </ToolbarField>

          <ToolbarField label={t('common.search')} grow>
            <Input
              type="search"
              defaultValue={search}
              placeholder={t('logistics.shipments.searchPlaceholder')}
              onChange={(event) => {
                const value = event.currentTarget.value;
                window.clearTimeout(searchTimer);
                searchTimer = window.setTimeout(() => {
                  update('search', value.trim());
                }, 350);
              }}
            />
          </ToolbarField>

          <ToolbarToggle
            label={t('logistics.shipments.filter.unassignedOnly')}
            checked={unassignedOnly}
            onChange={(checked) => {
              update('unassignedOnly', checked ? '1' : '');
            }}
          />

          <ToolbarToggle
            label={t('logistics.shipments.filter.exceptionsOnly')}
            checked={exceptionsOnly}
            onChange={(checked) => {
              update('exceptionsOnly', checked ? '1' : '');
            }}
          />

          <ToolbarActions>
            {isFiltered && (
              <Button
                onClick={() => {
                  // Page included: clearing the filters and landing on page
                  // four of a list that now has one page is an empty screen
                  // with no explanation.
                  setParams(new URLSearchParams(), { replace: true });
                }}
              >
                {t('logistics.shipments.filter.clear')}
              </Button>
            )}

            <Button
              variant="secondary"
              onClick={() => {
                void query.refetch();
              }}
            >
              {t('common.refresh')}
            </Button>
          </ToolbarActions>
        </Toolbar>

        <DataTable
          caption={t('logistics.shipments.heading')}
          columns={columns}
          rows={query.data?.shipments ?? []}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          isRefreshing={query.isFetching && !query.isPending}
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
          minWidth="64rem"
          emptyTitle={t('logistics.shipments.emptyTitle')}
          emptyDescription={
            unassignedOnly
              ? t('logistics.shipments.emptyUnassigned')
              : t('logistics.shipments.emptyBody')
          }
          onRowClick={(row) => {
            void navigate(`/logistics/shipments/${row.id}`);
          }}
        />
      </Card>

      {query.data !== undefined && query.data.total > PAGE_SIZE && (
        <Pager
          page={page}
          limit={PAGE_SIZE}
          total={query.data.total}
          totalPages={query.data.pageCount}
          onPageChange={(next: number) => {
            update('page', String(next));
          }}
        />
      )}
    </div>
  );
}
