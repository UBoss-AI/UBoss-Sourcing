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
  Input,
  PageHeader,
  Select,
  Toolbar,
  ToolbarActions,
  ToolbarField,
  ToolbarToggle,
} from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { formatDateTime, formatNumber } from '@/lib/format';
import {
  fetchAdminShipments,
  fetchPartners,
  shipmentStatusTone,
  slaKey,
  slaTone,
  statusLabelKey,
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

  const query = useQuery({
    queryKey: ['admin', 'logistics', 'shipments', status, partnerId, unassignedOnly, search, page],
    queryFn: () => {
      const next = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (status.length > 0) next.set('status', status);
      if (partnerId.length > 0) next.set('partnerId', partnerId);
      if (unassignedOnly) next.set('unassignedOnly', 'true');
      if (search.length > 0) next.set('search', search);
      return fetchAdminShipments(next);
    },
  });

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
      render: (row) =>
        row.assignedPartner === null ? (
          <Badge tone="warning" dot>
            {t('logistics.shipments.unassigned')}
          </Badge>
        ) : (
          <span className="text-xs text-ink-muted">{row.assignedPartner.displayName}</span>
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
        <Badge tone={shipmentStatusTone(row.status)} dot>
          {t(statusLabelKey(row.status))}
        </Badge>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('logistics.shipments.heading')}
        description={t('logistics.shipments.intro')}
      />

      <Toolbar>
        <ToolbarField label={t('logistics.shipments.filter.status')}>
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

        <ToolbarField label={t('logistics.shipments.filter.carrier')}>
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

        <ToolbarActions>
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
