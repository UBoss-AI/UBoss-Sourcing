/**
 * Warehouses.
 *
 * Until this screen existed, `inventory_locations` could only be changed with
 * an INSERT: every balance, movement and reservation in the system carried a
 * `locationId`, and nothing in the panel could open a second warehouse or say
 * where the first one was. This is where a business with more than one building
 * describes them.
 *
 * The map, the detail panel and the table are one screen rather than three,
 * and none of them is decoration. The map answers "where is our stock, and
 * which of it can ship today" - a question nobody can answer from a column of
 * coordinates. The panel answers "tell me everything about that one". The
 * table answers both for the reader who cannot see the map at all, and it is
 * what the search and the filters actually narrow.
 *
 * **Nothing on this screen is hard-coded.** Every warehouse, every country in
 * the pickers and the tile source behind the map come from the API. That is
 * not a style preference: this software is bought and run by other companies,
 * so where the warehouses are is never a fact the frontend gets to assert.
 *
 * The search and the filters live in the URL rather than in component state,
 * the same way the Dashboard's reporting window does. Somebody who wants to
 * send a colleague "the Greek warehouse that is running limited" sends the
 * address bar.
 *
 * Four rules the screen states rather than leaving in this comment, because
 * they are the sort of thing people discover by being refused:
 *
 *   - **A warehouse that has been used is never deleted, only retired.** Every
 *     movement ever booked against it points at the row, so deleting it would
 *     orphan the ledger that explains where stock went. Delete is offered as
 *     well, and it only ever removes a warehouse nothing was booked against -
 *     the duplicate created with a typo, the site that never opened. The
 *     server decides which of the two a warehouse is, and says so.
 *   - **Retiring is refused while it still holds stock**, and the refusal says
 *     how many units.
 *   - **The default warehouse cannot be retired or demoted.** Stock received
 *     with no warehouse named lands there, so the way to change it is to
 *     promote another one - which demotes the old one in the same write.
 *   - **Active and operational are different questions.** A warehouse closed
 *     for a roof repair is thoroughly active and cannot ship a thing, which is
 *     what the operational status is for and what `isActive` could never say.
 *
 * What this screen deliberately does not do is show a valuation per warehouse.
 * Product prices in this system are per currency, so adding up the SKUs in a
 * building would put rupees and euros in one total. Units are what a warehouse
 * holds.
 */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { ConfirmDialog } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  ErrorState,
  Input,
  PageHeader,
  Select,
  SummaryTiles,
  Toolbar,
  ToolbarActions,
  ToolbarField,
  ToolbarToggle,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { cx } from '@/lib/cx';
import { formatNumber } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import {
  OPERATIONAL_STATUSES,
  addressLine,
  erpLabelKey,
  erpTone,
  formatCoordinates,
  isPlaced,
  operationalLabelKey,
  operationalTone,
  supportsDeliveryCoverage,
  warehouseState,
} from '@/lib/warehouses';
import type {
  CountriesResponse,
  OperationalStatus,
  Warehouse,
  WarehousesResponse,
} from '@/lib/warehouses';
import {
  NOT_PLACED,
  COVERAGE_EXIT_MS,
  coverageQueryKey,
  fetchDeliveryCoverage,
} from '@/lib/delivery-coverage';
import { useLingering } from '@/lib/use-lingering';
import { translateKey, useI18n } from '@/i18n/i18n-context';
import { WarehouseDetailPanel } from './warehouse/WarehouseDetailPanel';
import { WarehouseFormDialog } from './warehouse/WarehouseFormDialog';
import { WarehouseMap } from './warehouse/WarehouseMap';
import { DeliveryCoveragePanel } from './warehouse/DeliveryCoveragePanel';

/**
 * How long the search box waits before asking the server.
 *
 * The search runs on the server - it matches the country's *name* as well as
 * the warehouse's, which the browser could not do from the rows it holds - so
 * every keystroke would otherwise be a request. 300ms is long enough to
 * swallow a typed word and short enough that nobody waits for it.
 */
const SEARCH_DEBOUNCE_MS = 300;

function isOperationalStatus(value: string): value is OperationalStatus {
  return (OPERATIONAL_STATUSES as readonly string[]).includes(value);
}

export function WarehousesPage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [searchParams, setSearchParams] = useSearchParams();

  const search = searchParams.get('q') ?? '';
  const statusFilter = searchParams.get('status') ?? '';
  const countryFilter = searchParams.get('country') ?? '';
  const showRetired = searchParams.get('retired') !== 'false';

  // What is in the box, which runs ahead of what is in the URL by up to the
  // debounce. Seeded from the URL, so a pasted link fills the box too.
  const [searchDraft, setSearchDraft] = useState(search);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * The warehouse whose delivery coverage is open, if any.
   *
   * Deliberately not `selectedId`. Selecting a warehouse opens its record and
   * is a decision somebody made; coverage follows the pointer and is a
   * question somebody is asking in passing. Tying the two together would mean
   * a camera flight every time a row was clicked in the table, and no way to
   * read the record of a warehouse without the map tilting.
   *
   * Not in the URL either, for the same reason: it is a hover, and twelve
   * history entries because somebody moved the mouse across five markers is
   * how a back button stops working.
   */
  const [coverageId, setCoverageId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Warehouse | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [confirmRetire, setConfirmRetire] = useState<Warehouse | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Warehouse | null>(null);

  const canWrite = can(Permission.INVENTORY_LOCATION_WRITE);

  /** Write one parameter, dropping it when it goes back to its default. */
  const setParam = (key: string, value: string | null): void => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
        return next;
      },
      // Filtering is not a navigation. Twelve entries in the back stack
      // because somebody tried four filters is how a back button stops
      // working.
      { replace: true },
    );
  };

  useEffect(() => {
    if (searchDraft.trim() === search) return undefined;

    const timer = setTimeout(() => {
      setParam('q', searchDraft.trim());
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
    // `setParam` closes over `setSearchParams`, which react-router keeps
    // stable; listing it would re-arm the timer on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchDraft, search]);

  const query = useQuery({
    // Every input the server sees is in the key, so changing a filter refetches
    // rather than filtering a list the server already narrowed.
    queryKey: ['warehouses', { search, statusFilter, countryFilter, showRetired }],
    queryFn: () =>
      api.get<WarehousesResponse>('/admin/inventory/warehouses', {
        query: {
          includeInactive: showRetired ? 'true' : 'false',
          ...(search === '' ? {} : { q: search }),
          ...(statusFilter === '' ? {} : { status: statusFilter }),
          ...(countryFilter === '' ? {} : { countryCode: countryFilter }),
        },
      }),
  });

  /**
   * The countries, for the filter.
   *
   * Its own query with its own cache lifetime: it is reference data that does
   * not change while somebody is trying filters, and refetching it with every
   * search would be one request per keystroke for a list of member states.
   */
  const countries = useQuery({
    queryKey: ['warehouse-countries'],
    queryFn: () => api.get<CountriesResponse>('/admin/inventory/warehouse-countries'),
    staleTime: 10 * 60 * 1000,
  });

  /**
   * The radius this deployment promises, from the server.
   *
   * The fallback only ever applies before the first response lands, when there
   * is no map drawn and nothing to ask coverage about. It is not a default
   * this frontend gets to have an opinion about.
   */
  const radiusKm = query.data?.coverage.radiusKm ?? 100;

  const mapConfig = query.data?.map ?? { provider: 'NONE' as const };
  const canShowCoverage = supportsDeliveryCoverage(mapConfig);

  /**
   * One query for the ring and the flaps.
   *
   * `enabled` is what makes hovering cheap: nothing is requested until a
   * warehouse is actually being pointed at, and React Query then keeps the
   * answer, so moving back and forth between two markers costs two requests
   * rather than twenty. A warehouse's coordinates are the only input, and they
   * change only when somebody edits it - hence a stale time long enough to
   * cover a session of looking around and an invalidation on save, which the
   * existing `invalidate` already performs for every warehouse query.
   */
  const coverageQuery = useQuery({
    queryKey: coverageQueryKey(coverageId ?? '', radiusKm),
    queryFn: () => fetchDeliveryCoverage(coverageId ?? '', radiusKm),
    enabled: coverageId !== null && canShowCoverage,
    staleTime: 5 * 60 * 1000,
    // A warehouse with no coordinates will not grow any by being asked twice,
    // and a retry would keep the spinner up for seconds before saying so.
    retry: (attempt, error) =>
      attempt < 1 && !(error instanceof ApiError && error.code === NOT_PLACED),
  });

  const coverageWarehouse =
    coverageId === null
      ? null
      : (query.data?.warehouses.find((warehouse) => warehouse.id === coverageId) ?? null);

  /**
   * Two failures, because they have two fixes.
   *
   * A warehouse with no coordinates is something the reader can put right, and
   * the panel says how. Anything else is a request that did not come back, and
   * the panel says to try again. Collapsing them into one message would tell
   * half the readers to retry something that will never work.
   */
  const coverageFailure =
    coverageQuery.error === null
      ? null
      : coverageQuery.error instanceof ApiError && coverageQuery.error.code === NOT_PLACED
        ? ('notPlaced' as const)
        : ('error' as const);

  /**
   * What the flap panel is showing, kept alive while it leaves.
   *
   * The panel is unmounted by nobody pointing at a warehouse any more, and an
   * unmounted element fades out of nothing - so this holds the last answer
   * for the length of the exit and hands the panel an `isLeaving` to fade on.
   *
   * A snapshot of all four values rather than the id alone, because they do
   * not survive the id going away: `coverageQuery` is keyed on the warehouse
   * being pointed at, so the moment that is null the query is disabled and
   * `data` is undefined and `isPending` is true again. Lingering on the id
   * would fade out a spinner instead of the countries that were being read.
   */
  const coveragePanel = useLingering(
    coverageId !== null && coverageWarehouse !== null
      ? {
          warehouseName: coverageWarehouse.name,
          coverage: coverageQuery.data ?? null,
          isLoading: coverageQuery.isPending,
          failure: coverageFailure,
        }
      : null,
    COVERAGE_EXIT_MS,
  );

  const warehouses = query.data?.warehouses ?? [];
  const placed = warehouses.filter(isPlaced);
  const unplaced = warehouses.filter(
    (warehouse) => !isPlaced(warehouse) && !warehouse.coordinatesInvalid,
  );
  const broken = warehouses.filter((warehouse) => warehouse.coordinatesInvalid);

  const selected = warehouses.find((warehouse) => warehouse.id === selectedId) ?? null;

  /**
   * A marker was clicked or a row was opened.
   *
   * On a device with no pointer this is the *only* gesture available, so it
   * has to open the coverage as well - there is no hover to do it and no
   * "moving away" to close it, which is why the panel grows a close button
   * there. Where there is a pointer, hovering already handles coverage and a
   * click must not also fly the camera: somebody clicking a row to read an
   * address has not asked to be taken anywhere.
   */
  const selectWarehouse = (id: string | null): void => {
    setSelectedId(id);

    if (!canShowCoverage) return;
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    setCoverageId(id);
  };
  const isFiltered = search !== '' || statusFilter !== '' || countryFilter !== '';

  const clearFilters = (): void => {
    setSearchDraft('');
    setSearchParams({}, { replace: true });
  };

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['warehouses'] });
    // The receipt and adjustment dialogs read their own list of locations, and
    // a warehouse opened here has to appear in them without a reload.
    await queryClient.invalidateQueries({ queryKey: ['inventory-locations'] });
  };

  const setActive = useMutation({
    mutationFn: (input: { id: string; isActive: boolean }) =>
      api.patch(`/admin/inventory/warehouses/${input.id}`, { isActive: input.isActive }),
    onSuccess: async (_result, input) => {
      toast.success(input.isActive ? t('warehouses.restored') : t('warehouses.retired'));
      setConfirmRetire(null);
      await invalidate();
    },
    onError: (error) => {
      // The server's message names the count in the way - how many units are
      // still held, how many reservations are live - which is the whole answer
      // to "so what do I do about it".
      toast.error(error instanceof ApiError ? error.message : t('warehouses.couldNotSave'));
      setConfirmRetire(null);
    },
  });

  /**
   * Remove the row, for a warehouse nothing was ever booked against.
   *
   * The server is what decides whether this one qualifies, and it is the only
   * thing that can: the movement ledger and the scheduled orders pointing at a
   * warehouse are not in the list this screen holds. So the refusal is the
   * feature - it names what is in the way and says to retire instead, and the
   * toast shows that sentence rather than a generic failure.
   */
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/admin/inventory/warehouses/${id}`),
    onSuccess: async (_result, id) => {
      toast.success(t('warehouses.deleted'));
      setConfirmDelete(null);
      // The panel described a warehouse that no longer exists. Closing it is
      // not tidiness - leaving it open would show a stale record beside a
      // table the row has gone from.
      setSelectedId((current) => (current === id ? null : current));
      // A warehouse that has just been retired or deleted must not leave a
      // ring on the map for a record that is gone.
      setCoverageId((current) => (current === id ? null : current));
      await invalidate();
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : t('warehouses.couldNotDelete'));
      setConfirmDelete(null);
    },
  });

  const totals = {
    warehouses: warehouses.length,
    onHand: warehouses.reduce((sum, warehouse) => sum + warehouse.stock.onHandQty, 0),
    lowStock: warehouses.reduce((sum, warehouse) => sum + warehouse.stock.lowStockCount, 0),
  };

  const columns: Column<Warehouse>[] = [
    {
      key: 'warehouse',
      header: t('warehouses.column.warehouse'),
      render: (row) => {
        const address = addressLine(row);

        return (
          <div className="min-w-48">
            <p className="font-medium text-ink">{row.name}</p>
            <p className="font-mono text-xxs text-ink-subtle">{row.code}</p>
            {address.length > 0 && <p className="mt-0.5 text-xxs text-ink-muted">{address}</p>}
          </div>
        );
      },
    },
    {
      key: 'country',
      header: t('warehouses.column.country'),
      nowrap: true,
      secondary: true,
      render: (row) =>
        row.countryName === null ? (
          <span className="text-xxs text-ink-subtle">—</span>
        ) : (
          <span className="text-ink-muted">{row.countryName}</span>
        ),
    },
    {
      key: 'operational',
      header: t('warehouses.column.operational'),
      nowrap: true,
      render: (row) => (
        <Badge tone={operationalTone(row.operationalStatus)}>
          {translateKey(t, operationalLabelKey(row.operationalStatus))}
        </Badge>
      ),
    },
    {
      key: 'state',
      header: t('warehouses.column.state'),
      nowrap: true,
      secondary: true,
      render: (row) => {
        const state = warehouseState(row);
        return <Badge tone={state.tone}>{translateKey(t, state.labelKey)}</Badge>;
      },
    },
    {
      key: 'position',
      header: t('warehouses.column.position'),
      nowrap: true,
      secondary: true,
      tertiary: true,
      render: (row) =>
        isPlaced(row) ? (
          <span className="font-mono text-xxs text-ink-muted">
            {formatCoordinates(row.latitude, row.longitude)}
          </span>
        ) : row.coordinatesInvalid ? (
          <span className="text-xxs font-medium text-danger">
            {t('warehouses.positionInvalidShort')}
          </span>
        ) : (
          // Named rather than left as a dash: "not on the map" is a state
          // somebody can fix, and a dash is a state nobody notices.
          <span className="text-xxs text-ink-subtle">{t('warehouses.notPlaced')}</span>
        ),
    },
    {
      key: 'onHand',
      header: t('warehouses.column.onHand'),
      align: 'right',
      render: (row) => (
        <div>
          <p className="font-medium text-ink">{formatNumber(row.stock.onHandQty)}</p>
          {row.stock.reservedQty > 0 && (
            <p className="text-xxs text-ink-subtle">
              {t('warehouses.reserved', { count: row.stock.reservedQty })}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'lowStock',
      header: t('warehouses.column.lowStock'),
      align: 'right',
      secondary: true,
      tertiary: true,
      render: (row) =>
        row.stock.lowStockCount === 0 ? (
          <span className="text-xxs text-ink-subtle">—</span>
        ) : (
          // Straight into Inventory filtered to this warehouse: a count that
          // cannot be acted on is a count people stop reading.
          <Link
            to={`/inventory?locationId=${row.id}&lowStockOnly=true`}
            className="font-medium text-warning underline underline-offset-2 hover:no-underline"
          >
            {formatNumber(row.stock.lowStockCount)}
          </Link>
        ),
    },
    {
      key: 'erp',
      header: t('warehouses.column.erp'),
      nowrap: true,
      secondary: true,
      render: (row) => (
        <Badge tone={erpTone(row.erp.status)}>{translateKey(t, erpLabelKey(row.erp.status))}</Badge>
      ),
    },
    {
      key: 'actions',
      header: t('warehouses.column.action'),
      align: 'right',
      render: (row) => {
        // Opening the details is a read, so everybody who can see the screen
        // gets it. Only the edits sit behind the write permission.
        const details = (
          <Button
            size="sm"
            variant={row.id === selectedId ? 'primary' : 'secondary'}
            onClick={() => {
              // A toggle, so pressing it again closes the panel rather than
              // leaving the reader with no way back.
              setSelectedId((current) => (current === row.id ? null : row.id));
            }}
          >
            {t('warehouses.viewDetails')}
          </Button>
        );

        if (!canWrite) return <div className="flex justify-end gap-2">{details}</div>;

        return (
          <div className="flex justify-end gap-2">
            {details}
            <Button
              size="sm"
              onClick={() => {
                setEditing(row);
                setIsCreating(false);
              }}
            >
              {t('warehouses.edit')}
            </Button>

            {row.isActive ? (
              <Button
                size="sm"
                variant="danger"
                // The default cannot be retired, and the server refuses it.
                // Not offering the button says so before somebody presses it.
                disabled={row.isDefault}
                onClick={() => {
                  setConfirmRetire(row);
                }}
              >
                {t('warehouses.retire')}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() => {
                  setActive.mutate({ id: row.id, isActive: true });
                }}
              >
                {t('warehouses.restore')}
              </Button>
            )}

            {/* Delete removes the row itself, and only for a warehouse
                nothing was ever booked against. Disabled on the two states
                this screen can already see are disqualifying - the default,
                and a warehouse with stock records - so that the common
                refusals are visible before somebody presses anything. The
                movement ledger and the scheduled orders are not in the list
                here, so the server still has the last word and its message
                names whichever of those is in the way. */}
            <Button
              size="sm"
              variant="danger"
              disabled={row.isDefault || row.stock.skuCount > 0}
              title={
                row.isDefault
                  ? t('warehouses.deleteBlockedDefault')
                  : row.stock.skuCount > 0
                    ? t('warehouses.deleteBlockedStock')
                    : undefined
              }
              onClick={() => {
                setConfirmDelete(row);
              }}
            >
              {t('warehouses.delete')}
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader title={t('warehouses.title')} description={t('warehouses.description')} />

      <SummaryTiles
        className="mt-5"
        items={[
          { label: t('warehouses.tile.count'), value: formatNumber(totals.warehouses) },
          { label: t('warehouses.tile.onHand'), value: formatNumber(totals.onHand) },
          {
            label: t('warehouses.tile.lowStock'),
            value: formatNumber(totals.lowStock),
            // Coloured only when there is something to act on. A warning tone
            // over a zero teaches people to ignore the tone.
            tone: totals.lowStock > 0 ? 'warning' : 'default',
          },
        ]}
      />

      <Card className="mt-5">
        {query.isError ? (
          // One error region for the whole card, with the retry on it. Two
          // retries - one over the map and one over the table - for a single
          // failed request is a screen that looks broken twice.
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : (
          <>
            <div className="space-y-4 px-5 py-4">
              {/* No map background configured is the default, not a fault, so
                  this is neutral and addressed to whoever runs the deployment
                  - the person reading the panel cannot fix it. It names both
                  ways out, because either is a valid choice and this software
                  does not get to prefer one on the operator's behalf. */}
              {query.data?.map.provider === 'NONE' && placed.length > 0 && (
                <Callout tone="neutral" title={t('warehouses.noTilesTitle')}>
                  {t('warehouses.noTilesBody')}
                </Callout>
              )}

              {/* Coordinates that exist and cannot be drawn. The database's
                  CHECK constraints make this unreachable through the API, so
                  it means a row that predates them, an import, or a manual SQL
                  fix - and a warehouse silently missing from the map is the
                  worst possible outcome, so it is named and counted. */}
              {broken.length > 0 && (
                <Callout tone="danger" title={t('warehouses.invalidCoordinatesTitle')}>
                  {t('warehouses.invalidCoordinatesBody', {
                    count: broken.length,
                    codes: broken.map((warehouse) => warehouse.code).join(', '),
                  })}
                </Callout>
              )}

              {/* Map and details side by side on a desktop; stacked on a
                  tablet, where 1024px of width is not enough for both and the
                  map is the half that needs the room. */}
              <div
                className={cx(
                  'grid grid-cols-1 gap-4',
                  selected !== null && 'lg:grid-cols-[minmax(0,1fr)_22rem]',
                )}
              >
                <div className="min-w-0">
                  {placed.length > 0 ? (
                    <WarehouseMap
                      warehouses={placed}
                      // Which map library the browser loads is decided here,
                      // from the operator's settings. Until the first response
                      // lands there is nothing to draw anyway - `placed` is
                      // empty - so the NONE default is a safe stand-in rather
                      // than a guess that could load the wrong one.
                      map={mapConfig}
                      selectedId={selectedId}
                      onSelect={selectWarehouse}
                      coverageId={coverageId}
                      coverage={coverageQuery.data ?? null}
                      // Only handed over where the provider can draw the ring.
                      // Undefined rather than a no-op, because the map reads it
                      // to decide whether to attach hover listeners at all.
                      onPointAt={canShowCoverage ? setCoverageId : undefined}
                      overlay={
                        coveragePanel === null ? undefined : (
                          <DeliveryCoveragePanel
                            warehouseName={coveragePanel.value.warehouseName}
                            radiusKm={radiusKm}
                            coverage={coveragePanel.value.coverage}
                            isLoading={coveragePanel.value.isLoading}
                            failure={coveragePanel.value.failure}
                            // Still on screen, on its way out. The map has
                            // already put the camera back; this is the panel
                            // catching up rather than vanishing mid-sentence.
                            isLeaving={coveragePanel.isLeaving}
                            // The close button exists only where there is no
                            // pointer to move away. See `selectWarehouse`.
                            onClose={
                              window.matchMedia('(hover: hover) and (pointer: fine)').matches
                                ? undefined
                                : () => {
                                    setCoverageId(null);
                                  }
                            }
                          />
                        )
                      }
                    />
                  ) : (
                    !query.isPending && (
                      // Nothing to draw is its own state, and which of the two
                      // reasons it is matters: a filter that matched nothing is
                      // fixed by clearing the filter, and no coordinates at all
                      // is fixed by editing a warehouse.
                      <div className="rounded-lg border border-dashed border-border bg-surface-sunken px-6 py-10 text-center">
                        <p className="text-sm font-medium text-ink">
                          {isFiltered && warehouses.length === 0
                            ? t('warehouses.mapNoMatchTitle')
                            : t('warehouses.mapEmptyTitle')}
                        </p>
                        <p className="mx-auto mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">
                          {isFiltered && warehouses.length === 0
                            ? t('warehouses.mapNoMatchBody')
                            : t('warehouses.mapEmptyBody')}
                        </p>
                        {isFiltered && (
                          <Button className="mt-4" size="sm" onClick={clearFilters}>
                            {t('warehouses.clearFilters')}
                          </Button>
                        )}
                      </div>
                    )
                  )}
                </div>

                {selected !== null && (
                  <WarehouseDetailPanel
                    warehouse={selected}
                    onClose={() => {
                      setSelectedId(null);
                      setCoverageId(null);
                    }}
                    // The keyboard and screen-reader path to the coverage. The
                    // map is aria-hidden, so a marker cannot be focused and
                    // hovering is not a gesture a keyboard has - this button
                    // is how the answer is reachable without a pointer.
                    // Absent for a warehouse with no position and on a
                    // provider that cannot draw the ring, rather than present
                    // and inert.
                    {...(canShowCoverage && isPlaced(selected)
                      ? {
                          coverage: {
                            isOpen: coverageId === selected.id,
                            onToggle: () => {
                              setCoverageId((current) =>
                                current === selected.id ? null : selected.id,
                              );
                            },
                          },
                        }
                      : {})}
                    {...(canWrite
                      ? {
                          onEdit: () => {
                            setEditing(selected);
                            setIsCreating(false);
                          },
                        }
                      : {})}
                  />
                )}
              </div>

              {unplaced.length > 0 && (
                <p className="text-xs leading-relaxed text-ink-muted">
                  {t('warehouses.unplacedCount', { count: unplaced.length })}
                </p>
              )}
            </div>

            <Toolbar>
              <ToolbarField label={t('warehouses.searchLabel')}>
                {/* `type="search"` so a browser offers its own clear button,
                    and the shared Input skin so it lines up with the two
                    selects beside it. */}
                <Input
                  type="search"
                  className="sm:w-64"
                  placeholder={t('warehouses.searchPlaceholder')}
                  value={searchDraft}
                  onChange={(event) => {
                    setSearchDraft(event.target.value);
                  }}
                />
              </ToolbarField>

              <ToolbarField label={t('warehouses.column.operational')}>
                <Select
                  className="w-48"
                  value={statusFilter}
                  onChange={(event) => {
                    const next = event.target.value;
                    setParam('status', isOperationalStatus(next) ? next : null);
                  }}
                >
                  <option value="">{t('warehouses.anyStatus')}</option>
                  {OPERATIONAL_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {translateKey(t, operationalLabelKey(status))}
                    </option>
                  ))}
                </Select>
              </ToolbarField>

              <ToolbarField label={t('warehouses.column.country')}>
                <Select
                  className="w-48"
                  value={countryFilter}
                  onChange={(event) => {
                    setParam('country', event.target.value);
                  }}
                >
                  <option value="">{t('warehouses.anyCountry')}</option>
                  {(countries.data?.countries ?? []).map((country) => (
                    <option key={country.code} value={country.code}>
                      {country.name}
                    </option>
                  ))}
                </Select>
              </ToolbarField>

              <ToolbarToggle
                label={t('warehouses.showRetired')}
                checked={showRetired}
                onChange={(next) => {
                  setParam('retired', next ? null : 'false');
                }}
              />

              <ToolbarActions>
                {isFiltered && (
                  <Button size="sm" onClick={clearFilters}>
                    {t('warehouses.clearFilters')}
                  </Button>
                )}

                {canWrite && (
                  <Button
                    variant="primary"
                    onClick={() => {
                      setEditing(null);
                      setIsCreating(true);
                    }}
                  >
                    {t('warehouses.add')}
                  </Button>
                )}
              </ToolbarActions>
            </Toolbar>

            <DataTable
              caption={t('warehouses.title')}
              columns={columns}
              rows={warehouses}
              rowKey={(row) => row.id}
              isLoading={query.isPending}
              isRefreshing={query.isFetching && !query.isPending}
              loadingLabel={t('warehouses.loading')}
              minWidth="76rem"
              emptyTitle={isFiltered ? t('warehouses.noMatchTitle') : t('warehouses.emptyTitle')}
              emptyDescription={
                isFiltered ? t('warehouses.noMatchDescription') : t('warehouses.emptyDescription')
              }
              // A ground tint only, and every fact it hints at is also in words
              // in the row - the state badge says "Retired", and the selected
              // row has the button that selected it.
              rowClassName={(row) =>
                cx(row.id === selectedId && 'bg-accent-soft', !row.isActive && 'opacity-60')
              }
            />
          </>
        )}
      </Card>

      {(isCreating || editing !== null) && (
        <WarehouseFormDialog
          editing={editing}
          onClose={() => {
            setIsCreating(false);
            setEditing(null);
          }}
          onSaved={(warehouse, wasCreated) => {
            toast.success(wasCreated ? t('warehouses.created') : t('warehouses.updated'));
            setIsCreating(false);
            setEditing(null);
            // Selected, so a warehouse that was just placed is the one the map
            // brings to the front and the panel describes.
            setSelectedId(warehouse.id);
            void invalidate();
          }}
        />
      )}

      <ConfirmDialog
        isOpen={confirmRetire !== null}
        title={t('warehouses.retireTitle')}
        body={
          confirmRetire === null
            ? ''
            : t('warehouses.retireBody', {
                name: confirmRetire.name,
                count: confirmRetire.stock.onHandQty,
              })
        }
        confirmLabel={t('warehouses.retire')}
        isDangerous
        isWorking={setActive.isPending}
        onClose={() => {
          setConfirmRetire(null);
        }}
        onConfirm={() => {
          if (confirmRetire !== null) {
            setActive.mutate({ id: confirmRetire.id, isActive: false });
          }
        }}
      />

      {/* Its own dialog rather than a shared one with a swapped verb. The two
          acts are not variations of each other: retiring is reversible from
          this screen and keeps everything, deleting is neither, and a reader
          skimming a confirmation deserves to be told which one they are
          about to do. */}
      <ConfirmDialog
        isOpen={confirmDelete !== null}
        title={t('warehouses.deleteTitle')}
        body={
          confirmDelete === null ? '' : t('warehouses.deleteBody', { name: confirmDelete.name })
        }
        confirmLabel={t('warehouses.delete')}
        isDangerous
        isWorking={remove.isPending}
        onClose={() => {
          setConfirmDelete(null);
        }}
        onConfirm={() => {
          if (confirmDelete !== null) {
            remove.mutate(confirmDelete.id);
          }
        }}
      />
    </>
  );
}
