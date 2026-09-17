/**
 * Seller warehouses, on the same map and in the same table.
 *
 * The operator's own buildings are `inventory_locations` and a seller's are
 * `seller_locations`, and nothing here pretends otherwise: this is a second
 * view on one screen rather than a merged list, and every row names the
 * company that owns it.
 *
 * THE MAP AND THE TABLE SHOW THE SAME ROWS
 *
 * Not "the same query with different paging" - literally the same array. A map
 * that plots page one of four is a map that misrepresents where a seller ships
 * from, and that is the single question this view exists to answer. So the
 * server caps the answer and says when it cut it, and the panel passes that on
 * rather than quietly showing the first five hundred as though they were all.
 *
 * WHAT A WAREHOUSE WITH NO POSITION DOES
 *
 * It stays in the table and is named above the map. A place nobody has
 * geocoded is still a place holding stock, and dropping it would make the
 * count under the map disagree with the count in the table for a reason
 * nobody can see. The two cases are kept apart because the fix differs: an
 * address nobody has looked up is a job, and a stored position that cannot be
 * plotted is a value somebody has to correct.
 *
 * NO DELIVERY RINGS
 *
 * The operator's own warehouses carry a radius they promise to deliver within,
 * and the map draws it. A seller location has no such field, so none is drawn.
 * Inventing a circle would put a promise on the screen that the seller never
 * made and the marketplace cannot keep.
 */
import { Link } from 'react-router-dom';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import {
  Badge,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Select,
  Toolbar,
  ToolbarField,
  ToolbarToggle,
} from '@/components/ui';
import { formatDateTime, formatNumber } from '@/lib/format';
import { useI18n } from '@/i18n/i18n-context';
import { isPlaced, operationalLabelKey, operationalTone } from '@/lib/warehouses';
import type { CountryOption, MapConfig } from '@/lib/warehouses';
import { sellerAddressLine, type SellerWarehouse } from '@/lib/seller-warehouses';
import { PLAIN_LOOK, type MarkerLook } from './warehouse-marker';
import { WarehouseMap } from './WarehouseMap';

/**
 * How a seller's place is drawn.
 *
 * Plain where it can ship, danger where it cannot, and flagged when something
 * in it is below the seller's own reorder threshold. Deliberately the same
 * three signals the operator's own markers use, so a reader does not have to
 * learn a second legend for the second view - and colour is never the only
 * one: the status is written out in the table beside it.
 */
function sellerLook(warehouse: SellerWarehouse): MarkerLook {
  if (warehouse.operationalStatus === 'SUSPENDED') {
    return { tone: 'border-danger bg-danger-fill text-white', flagged: false };
  }

  return { ...PLAIN_LOOK, flagged: warehouse.stock.lowStockCount > 0 };
}

export function SellerWarehousePanel({
  warehouses,
  map,
  isTruncated,
  isLoading,
  isError,
  onRetry,
  selectedId,
  onSelect,
  countries,
  countryFilter,
  onCountryFilter,
  includeClosed,
  onIncludeClosed,
  /** Whether more than one company's buildings are on screen. */
  isCombined,
  emptyTitle,
  emptyDescription,
}: {
  warehouses: SellerWarehouse[];
  map: MapConfig;
  isTruncated: boolean;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  countries: CountryOption[];
  countryFilter: string;
  onCountryFilter: (code: string) => void;
  includeClosed: boolean;
  onIncludeClosed: (value: boolean) => void;
  isCombined: boolean;
  emptyTitle: string;
  emptyDescription: string;
}): React.JSX.Element {
  const { t } = useI18n();

  const placed = warehouses.filter(isPlaced);
  const unplaced = warehouses.filter(
    (warehouse) => !isPlaced(warehouse) && !warehouse.coordinatesInvalid,
  );
  const broken = warehouses.filter((warehouse) => warehouse.coordinatesInvalid);

  const columns: Column<SellerWarehouse>[] = [
    {
      key: 'name',
      header: t('sellerWarehouses.columnWarehouse'),
      render: (warehouse) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{warehouse.name}</p>
          <p className="truncate font-mono text-xxs text-ink-subtle">{warehouse.code}</p>
        </div>
      ),
    },
    {
      key: 'owner',
      header: t('sellerWarehouses.columnOwner'),
      render: (warehouse) => (
        <div className="min-w-0">
          {/* The link is the point of the column on a combined view: an
              operator who sees a name they do not recognise needs one click to
              the business behind it. */}
          {warehouse.owner.sellerAccountId === null ? (
            <p className="truncate text-sm text-ink">{warehouse.owner.name}</p>
          ) : (
            <Link
              to={`/sellers/${warehouse.owner.sellerAccountId}`}
              className="truncate text-sm text-accent underline-offset-2 hover:underline"
            >
              {warehouse.owner.name}
            </Link>
          )}
          {warehouse.owner.sellerCode !== null && (
            <p className="truncate font-mono text-xxs text-ink-subtle">
              {warehouse.owner.sellerCode}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'where',
      header: t('sellerWarehouses.columnWhere'),
      render: (warehouse) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-ink">{sellerAddressLine(warehouse)}</p>
          <p className="text-xxs text-ink-subtle">{warehouse.countryCode ?? '—'}</p>
        </div>
      ),
    },
    {
      key: 'status',
      header: t('sellerWarehouses.columnStatus'),
      render: (warehouse) => (
        <div className="flex flex-col items-start gap-1">
          <Badge tone={operationalTone(warehouse.operationalStatus)} dot>
            {t(operationalLabelKey(warehouse.operationalStatus))}
          </Badge>
          {/* The seller's own reason, which is what turns "closed" into
              something an operator can act on rather than ring up about. */}
          {warehouse.closedReason !== null && (
            <span className="text-xxs leading-snug text-ink-muted">{warehouse.closedReason}</span>
          )}
          {warehouse.coordinatesInvalid && (
            <span className="text-xxs font-medium text-warning">
              {t('sellerWarehouses.badPosition')}
            </span>
          )}
          {!warehouse.coordinatesInvalid && !isPlaced(warehouse) && (
            <span className="text-xxs text-ink-subtle">{t('sellerWarehouses.notPlaced')}</span>
          )}
        </div>
      ),
    },
    {
      key: 'handling',
      header: t('sellerWarehouses.columnHandling'),
      render: (warehouse) => {
        const marks = [
          warehouse.hasColdChain ? t('sellerWarehouses.coldChain') : null,
          warehouse.hasControlledStorage ? t('sellerWarehouses.controlled') : null,
          warehouse.hasSterileStorage ? t('sellerWarehouses.sterile') : null,
        ].filter((mark): mark is string => mark !== null);

        return marks.length === 0 ? (
          <span className="text-xs text-ink-subtle">—</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {marks.map((mark) => (
              <Badge key={mark} tone="neutral">
                {mark}
              </Badge>
            ))}
          </div>
        );
      },
    },
    {
      key: 'stock',
      header: t('sellerWarehouses.columnStock'),
      align: 'right',
      render: (warehouse) => (
        <div className="text-right">
          <p className="text-sm tabular-nums text-ink">
            {formatNumber(warehouse.stock.onHandQty)}
          </p>
          <p className="text-xxs tabular-nums text-ink-subtle">
            {t('sellerWarehouses.skuCount', { count: warehouse.stock.skuCount })}
          </p>
          {warehouse.stock.lowStockCount > 0 && (
            <p className="text-xxs font-medium text-warning">
              {t('sellerWarehouses.lowStock', { count: warehouse.stock.lowStockCount })}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'erp',
      header: t('sellerWarehouses.columnErp'),
      secondary: true,
      render: (warehouse) =>
        warehouse.erpLastSyncAt === null ? (
          // Never synced is the ordinary state for a seller with no ERP
          // connected, so it is a sentence rather than an error badge.
          <span className="text-xxs text-ink-subtle">{t('sellerWarehouses.neverSynced')}</span>
        ) : (
          <span className="text-xxs text-ink-muted">
            {formatDateTime(warehouse.erpLastSyncAt)}
          </span>
        ),
    },
    {
      key: 'locate',
      header: t('sellerWarehouses.columnAction'),
      align: 'right',
      /*
       * A real button, not just a clickable row.
       *
       * The row click below it is a convenience for a pointer; this is what a
       * keyboard and a screen reader use, and it is the only one of the two
       * that can be reached without a mouse. A place with no plottable
       * position has nothing to show, and the control says so rather than
       * being present and inert.
       */
      render: (warehouse) =>
        isPlaced(warehouse) ? (
          <button
            type="button"
            onClick={() => {
              onSelect(warehouse.id === selectedId ? null : warehouse.id);
            }}
            aria-pressed={warehouse.id === selectedId}
            className="rounded text-xs font-medium text-accent underline-offset-2 transition-colors hover:text-accent-hover hover:underline"
          >
            {warehouse.id === selectedId
              ? t('sellerWarehouses.clearOnMap')
              : t('sellerWarehouses.showOnMap')}
          </button>
        ) : (
          <span className="text-xxs text-ink-subtle">{t('sellerWarehouses.notOnMap')}</span>
        ),
    },
  ];

  if (isError) {
    return (
      <Card>
        <ErrorState error={new Error(t('sellerWarehouses.loadFailed'))} onRetry={onRetry} />
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <LoadingState label={t('common.loading')} />
      </Card>
    );
  }

  if (warehouses.length === 0) {
    return (
      <Card>
        <EmptyState title={emptyTitle} description={emptyDescription} />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {isTruncated && (
        <Callout tone="warning" title={t('sellerWarehouses.truncatedTitle')}>
          {t('sellerWarehouses.truncatedBody')}
        </Callout>
      )}

      <Toolbar>
        <ToolbarField label={t('warehouses.column.country')}>
          <Select
            value={countryFilter}
            onChange={(event) => {
              onCountryFilter(event.target.value);
            }}
          >
            <option value="">{t('warehouses.anyCountry')}</option>
            {countries.map((country) => (
              <option key={country.code} value={country.code}>
                {country.name}
              </option>
            ))}
          </Select>
        </ToolbarField>

        <ToolbarToggle
          checked={includeClosed}
          onChange={onIncludeClosed}
          label={t('sellerWarehouses.showClosed')}
        />
      </Toolbar>

      <Card bodyClassName="p-0">
        <div className="h-[22rem] w-full overflow-hidden rounded-md">
          <WarehouseMap
            warehouses={placed}
            look={sellerLook}
            map={map}
            selectedId={selectedId}
            // A marker click selects its row in the table below - the other
            // half of the same gesture the table performs on the map.
            onSelect={onSelect}
          />
        </div>

        {/* What the map is NOT showing, said under the map rather than left to
            be inferred from a count that does not add up. */}
        {(unplaced.length > 0 || broken.length > 0) && (
          <p className="border-t border-border px-4 py-2 text-xxs leading-relaxed text-ink-muted">
            {unplaced.length > 0 && (
              <span>{t('sellerWarehouses.unplacedNote', { count: unplaced.length })}</span>
            )}
            {unplaced.length > 0 && broken.length > 0 && <span> · </span>}
            {broken.length > 0 && (
              <span className="text-warning">
                {t('sellerWarehouses.brokenNote', { count: broken.length })}
              </span>
            )}
          </p>
        )}
      </Card>

      <DataTable
        caption={t('sellerWarehouses.tableCaption')}
        // The owner column is dropped when every row has the same owner: a
        // column repeating one company name down a page is a column carrying
        // no information, and the company is already named above the table.
        columns={isCombined ? columns : columns.filter((column) => column.key !== 'owner')}
        rows={warehouses}
        rowKey={(warehouse) => warehouse.id}
        // A convenience for a pointer only - the "show on map" button in each
        // row is the real control, and the one a keyboard reaches.
        onRowClick={(warehouse) => {
          if (!isPlaced(warehouse)) return;
          onSelect(warehouse.id === selectedId ? null : warehouse.id);
        }}
        rowClassName={(warehouse) =>
          warehouse.id === selectedId ? 'bg-accent-soft/40' : undefined
        }
      />
    </div>
  );
}
