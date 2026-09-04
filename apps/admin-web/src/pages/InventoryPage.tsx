/**
 * Inventory.
 *
 * Two numbers matter and they are not the same one:
 *
 *   - **On hand** is what is physically there.
 *   - **Available** is on hand minus what carts and unpaid orders have already
 *     reserved. It is what a customer can actually buy.
 *
 * Showing only one of them is how oversell arguments start, so both are always
 * visible with the reservation between them.
 *
 * The stock column exists because "available: 0" in a column of numbers is not
 * a signal — it is a digit. Out of stock and low are named in words, given
 * their own colour, and an out-of-stock row carries a tinted ground so it can
 * be found without reading the page.
 *
 * Receiving and adjusting are separate actions on purpose. A receipt is stock
 * arriving and takes a reference; an adjustment is a correction and takes a
 * reason. The ledger keeps them apart, and so does this screen — an
 * adjustment logged as a receipt destroys the audit trail's usefulness.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  SummaryTiles,
  Textarea,
  Toolbar,
  ToolbarActions,
  ToolbarField,
  ToolbarToggle,
} from '@/components/ui';
import { api } from '@/lib/api';
import { applyApiErrors, nullIfBlank } from '@/lib/forms';
import { formatDateTime, formatMoney, formatNumber, humanise } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import type { BadgeTone } from '@/components/ui';
import type { Money, Pagination } from '@/lib/types';

interface InventoryRow {
  balanceId: string;
  productId: string;
  productName: string;
  sku: string;
  variantId: string | null;
  variantName: string | null;
  location: { id: string; code: string; name: string };
  onHandQty: number;
  reservedQty: number;
  availableQty: number;
  reorderThreshold: number;
  isLowStock: boolean;
  unitPrice: Money;
  valuation: Money;
  updatedAt: string;
}

interface MovementRow {
  id: string;
  type: string;
  product: { id: string; name: string; sku: string };
  variant: { id: string; name: string; sku: string } | null;
  location: { id: string; code: string };
  quantityDelta: number;
  resultingOnHand: number;
  reason: string | null;
  actorEmail: string | null;
  actorType: string;
  createdAt: string;
}

interface Location {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
}

function movementTone(type: string): BadgeTone {
  if (type === 'RECEIPT' || type === 'RETURN') return 'success';
  if (type === 'ADJUSTMENT') return 'warning';
  if (type === 'SHIPMENT' || type === 'DAMAGE') return 'danger';
  return 'neutral';
}

/**
 * The three states a stock line can be in, in the order they matter.
 *
 * `isLowStock` is the server's judgement against the product's own reorder
 * threshold, so it is not recomputed here. Nothing available is its own state
 * and a worse one: low means order more soon, none means the storefront is
 * already turning customers away.
 */
function stockState(row: InventoryRow): { label: string; tone: BadgeTone } {
  if (row.availableQty <= 0) return { label: 'Out of stock', tone: 'danger' };
  if (row.isLowStock) return { label: 'Low', tone: 'warning' };
  return { label: 'In stock', tone: 'success' };
}

// ---------------------------------------------------------------------------

const receiptSchema = z.object({
  quantity: z.coerce.number().int().min(1, 'Receive at least 1.').max(10_000_000),
  reference: z.string().trim().max(128),
  note: z.string().trim().max(512),
  locationId: z.string(),
});

const adjustmentSchema = z.object({
  quantityDelta: z.coerce
    .number()
    .int()
    .min(-10_000_000)
    .max(10_000_000)
    .refine((value) => value !== 0, 'An adjustment of zero changes nothing.'),
  reason: z.string().trim().min(1, 'Say why. This is the audit trail.').max(512),
  locationId: z.string(),
});

type ReceiptForm = z.output<typeof receiptSchema>;
type AdjustmentForm = z.output<typeof adjustmentSchema>;

function StockMovementDialog({
  mode,
  row,
  locations,
  onClose,
}: {
  mode: 'receive' | 'adjust';
  row: InventoryRow;
  locations: Location[];
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [formError, setFormError] = useState<string | null>(null);

  const receiptForm = useForm<ReceiptForm>({
    resolver: zodResolver(receiptSchema),
    defaultValues: { quantity: 1, reference: '', note: '', locationId: row.location.id },
  });

  const adjustForm = useForm<AdjustmentForm>({
    resolver: zodResolver(adjustmentSchema),
    defaultValues: { quantityDelta: 0, reason: '', locationId: row.location.id },
  });

  const invalidate = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['inventory'] });
    await queryClient.invalidateQueries({ queryKey: ['movements'] });
    await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  const receive = useMutation({
    mutationFn: (values: ReceiptForm) =>
      api.post('/admin/inventory/receipts', {
        productId: row.productId,
        variantId: row.variantId,
        locationId: values.locationId,
        quantity: values.quantity,
        reference: nullIfBlank(values.reference),
        note: nullIfBlank(values.note),
      }),
    onSuccess: async () => {
      toast.success('Stock received.');
      await invalidate();
      onClose();
    },
    onError: (error) => {
      setFormError(applyApiErrors(error, receiptForm.setError, ['quantity', 'reference', 'note']));
    },
  });

  const adjust = useMutation({
    mutationFn: (values: AdjustmentForm) =>
      api.post('/admin/inventory/adjustments', {
        productId: row.productId,
        variantId: row.variantId,
        locationId: values.locationId,
        quantityDelta: values.quantityDelta,
        reason: values.reason,
      }),
    onSuccess: async () => {
      toast.success('Stock adjusted.');
      await invalidate();
      onClose();
    },
    onError: (error) => {
      setFormError(applyApiErrors(error, adjustForm.setError, ['quantityDelta', 'reason']));
    },
  });

  const isReceipt = mode === 'receive';
  const isPending = isReceipt ? receive.isPending : adjust.isPending;

  const submit = (): void => {
    if (isReceipt) void receiptForm.handleSubmit((values) => receive.mutateAsync(values))();
    else void adjustForm.handleSubmit((values) => adjust.mutateAsync(values))();
  };

  const delta = adjustForm.watch('quantityDelta');
  // The delta is a coerced number, but an empty input yields NaN, and NaN
  // renders as "NaN" in the projection line.
  const projected = row.onHandQty + (Number.isFinite(delta) ? delta : 0);

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={isReceipt ? 'Receive stock' : 'Adjust stock'}
      description={`${row.productName}${row.variantName === null ? '' : ` — ${row.variantName}`} · ${row.sku}`}
      footer={
        <>
          <Button onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button variant="primary" isLoading={isPending} onClick={submit}>
            {isReceipt ? 'Receive stock' : 'Apply adjustment'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {formError !== null && (
          <Callout tone="danger" role="alert">
            {formError}
          </Callout>
        )}

        <SummaryTiles
          items={[
            { label: 'On hand', value: formatNumber(row.onHandQty) },
            { label: 'Reserved', value: formatNumber(row.reservedQty) },
            {
              label: 'Available',
              value: formatNumber(row.availableQty),
              tone: row.availableQty <= 0 ? 'danger' : row.isLowStock ? 'warning' : 'default',
            },
          ]}
        />

        {locations.length > 1 && (
          <Field label="Location">
            {({ inputId }) => (
              <Select
                id={inputId}
                {...(isReceipt ? receiptForm.register('locationId') : adjustForm.register('locationId'))}
              >
                {locations.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name} ({location.code})
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        {isReceipt ? (
          <>
            <Field
              label="Quantity received"
              error={receiptForm.formState.errors.quantity?.message}
              required
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  type="number"
                  min={1}
                  className="tabular"
                  aria-describedby={describedBy}
                  invalid={receiptForm.formState.errors.quantity !== undefined}
                  {...receiptForm.register('quantity')}
                />
              )}
            </Field>

            <Field
              label="Reference"
              hint="Purchase order, delivery note or invoice number."
              error={receiptForm.formState.errors.reference?.message}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  placeholder="PO-4471"
                  aria-describedby={describedBy}
                  {...receiptForm.register('reference')}
                />
              )}
            </Field>

            <Field label="Note" error={receiptForm.formState.errors.note?.message}>
              {({ inputId, describedBy }) => (
                <Textarea id={inputId} rows={2} aria-describedby={describedBy} {...receiptForm.register('note')} />
              )}
            </Field>
          </>
        ) : (
          <>
            <Field
              label="Change"
              hint="Negative to remove stock, positive to add it. Use a receipt for deliveries — the ledger keeps corrections and arrivals apart."
              error={adjustForm.formState.errors.quantityDelta?.message}
              required
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  type="number"
                  className="tabular"
                  aria-describedby={describedBy}
                  invalid={adjustForm.formState.errors.quantityDelta !== undefined}
                  {...adjustForm.register('quantityDelta')}
                />
              )}
            </Field>

            {/* The consequence, read before the button rather than after it. */}
            <Callout tone={projected < 0 ? 'danger' : 'neutral'}>
              On hand would become{' '}
              <span className={projected < 0 ? 'font-semibold text-danger' : 'font-semibold text-ink'}>
                {formatNumber(projected)}
              </span>
              {projected < 0 && ' — the server will refuse a negative balance.'}
            </Callout>

            <Field
              label="Reason"
              hint="Recorded in the ledger against your name, permanently. Be specific."
              error={adjustForm.formState.errors.reason?.message}
              required
            >
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  rows={2}
                  placeholder="Damaged in transit"
                  aria-describedby={describedBy}
                  invalid={adjustForm.formState.errors.reason !== undefined}
                  {...adjustForm.register('reason')}
                />
              )}
            </Field>
          </>
        )}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

export function InventoryPage(): React.JSX.Element {
  const { can } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();

  const page = Number(searchParams.get('page') ?? '1');
  const q = searchParams.get('q') ?? '';
  const lowStockOnly = searchParams.get('lowStockOnly') === 'true';
  const [searchText, setSearchText] = useState(q);

  const [dialog, setDialog] = useState<{ mode: 'receive' | 'adjust'; row: InventoryRow } | null>(
    null,
  );

  useEffect(() => {
    setSearchText(q);
  }, [q]);

  useEffect(() => {
    if (searchText === q) return undefined;

    const timer = window.setTimeout(() => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (searchText === '') next.delete('q');
          else next.set('q', searchText);
          next.delete('page');
          return next;
        },
        { replace: true },
      );
    }, 300);

    return () => {
      window.clearTimeout(timer);
    };
  }, [searchText, q, setSearchParams]);

  const locations = useQuery({
    queryKey: ['inventory-locations'],
    queryFn: () => api.get<{ locations: Location[] }>('/admin/inventory/locations'),
  });

  const inventory = useQuery({
    queryKey: ['inventory', { page, q, lowStockOnly }],
    queryFn: () =>
      api.get<{ inventory: InventoryRow[]; pagination: Pagination }>('/admin/inventory', {
        query: {
          page,
          limit: 25,
          q: q === '' ? undefined : q,
          lowStockOnly: lowStockOnly ? 'true' : undefined,
        },
      }),
  });

  const movements = useQuery({
    queryKey: ['movements'],
    queryFn: () =>
      api.get<{ movements: MovementRow[]; pagination: Pagination }>('/admin/inventory/movements', {
        query: { limit: 25 },
      }),
  });

  const canReceive = can(Permission.INVENTORY_RECEIVE);
  const canAdjust = can(Permission.INVENTORY_ADJUST);

  // Only meaningful while the filter is on, because only then is the total the
  // count of low-stock lines. Inventing a figure from the current page would
  // be a number that changes when you turn the page.
  const lowStockTotal = lowStockOnly ? inventory.data?.pagination.total : undefined;

  const stockColumns: Column<InventoryRow>[] = [
    {
      key: 'product',
      header: 'Product',
      render: (row) => (
        <div className="min-w-48">
          <p className="font-medium text-ink">
            {row.productName}
            {row.variantName !== null && (
              <span className="text-ink-muted"> — {row.variantName}</span>
            )}
          </p>
          <p className="font-mono text-xxs text-ink-subtle">{row.sku}</p>
        </div>
      ),
    },
    {
      key: 'stock',
      header: 'Stock',
      render: (row) => {
        const state = stockState(row);
        return (
          <Badge dot tone={state.tone}>
            {state.label}
          </Badge>
        );
      },
    },
    {
      key: 'location',
      header: 'Location',
      secondary: true,
      nowrap: true,
      render: (row) => <span className="text-ink-muted">{row.location.name}</span>,
    },
    {
      key: 'onHand',
      header: 'On hand',
      align: 'right',
      render: (row) => formatNumber(row.onHandQty),
    },
    {
      key: 'reserved',
      header: 'Reserved',
      align: 'right',
      render: (row) =>
        row.reservedQty === 0 ? (
          <span className="text-ink-subtle">—</span>
        ) : (
          formatNumber(row.reservedQty)
        ),
    },
    {
      key: 'available',
      header: 'Available',
      align: 'right',
      render: (row) => (
        <span
          className={
            row.availableQty <= 0
              ? 'font-semibold text-danger'
              : row.isLowStock
                ? 'font-semibold text-warning'
                : 'font-medium text-ink'
          }
        >
          {formatNumber(row.availableQty)}
        </span>
      ),
    },
    {
      key: 'threshold',
      header: 'Reorder at',
      align: 'right',
      secondary: true,
      tertiary: true,
      render: (row) => <span className="text-ink-muted">{formatNumber(row.reorderThreshold)}</span>,
    },
    {
      key: 'valuation',
      header: 'Value',
      align: 'right',
      secondary: true,
      nowrap: true,
      render: (row) => formatMoney(row.valuation),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => (
        <div className="flex justify-end gap-1">
          {canReceive && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDialog({ mode: 'receive', row });
              }}
            >
              Receive
              <span className="sr-only"> stock for {row.sku}</span>
            </Button>
          )}
          {canAdjust && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDialog({ mode: 'adjust', row });
              }}
            >
              Adjust
              <span className="sr-only"> stock for {row.sku}</span>
            </Button>
          )}
        </div>
      ),
    },
  ];

  const movementColumns: Column<MovementRow>[] = [
    {
      key: 'when',
      header: 'When',
      nowrap: true,
      render: (row) => <span className="text-ink-muted">{formatDateTime(row.createdAt)}</span>,
    },
    {
      key: 'type',
      header: 'Type',
      render: (row) => (
        <Badge dot tone={movementTone(row.type)}>
          {humanise(row.type)}
        </Badge>
      ),
    },
    {
      key: 'product',
      header: 'Product',
      render: (row) => (
        <div className="min-w-40">
          <p className="text-ink">{row.product.name}</p>
          <p className="font-mono text-xxs text-ink-subtle">{row.product.sku}</p>
        </div>
      ),
    },
    {
      key: 'delta',
      header: 'Change',
      align: 'right',
      render: (row) => (
        <span className={row.quantityDelta < 0 ? 'font-semibold text-danger' : 'font-semibold text-success'}>
          {row.quantityDelta > 0 ? '+' : ''}
          {formatNumber(row.quantityDelta)}
        </span>
      ),
    },
    {
      key: 'result',
      header: 'On hand after',
      align: 'right',
      secondary: true,
      render: (row) => formatNumber(row.resultingOnHand),
    },
    {
      key: 'reason',
      header: 'Reason',
      render: (row) => row.reason ?? <span className="text-ink-subtle">—</span>,
    },
    {
      key: 'actor',
      header: 'By',
      secondary: true,
      tertiary: true,
      render: (row) => (
        <span className="text-ink-muted">{row.actorEmail ?? humanise(row.actorType)}</span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Inventory"
        description="On hand is what exists. Available is what a customer can buy — on hand less whatever carts and unpaid orders have already reserved."
      />

      <div className="space-y-5">
        <Card>
          <Toolbar>
            <ToolbarField label="Search" grow>
              <Input
                type="search"
                value={searchText}
                placeholder="Product name or SKU"
                onChange={(event) => {
                  setSearchText(event.target.value);
                }}
              />
            </ToolbarField>

            <ToolbarToggle
              label="Needs reordering only"
              checked={lowStockOnly}
              onChange={(checked) => {
                setSearchParams((current) => {
                  const next = new URLSearchParams(current);
                  if (checked) next.set('lowStockOnly', 'true');
                  else next.delete('lowStockOnly');
                  next.delete('page');
                  return next;
                });
              }}
            />

            {lowStockTotal !== undefined && lowStockTotal > 0 && (
              <ToolbarActions>
                <p className="text-xs font-medium text-warning">
                  {formatNumber(lowStockTotal)} line{lowStockTotal === 1 ? '' : 's'} at or below the
                  reorder point
                </p>
              </ToolbarActions>
            )}
          </Toolbar>

          <DataTable
            caption="Stock levels"
            columns={stockColumns}
            rows={inventory.data?.inventory}
            rowKey={(row) => row.balanceId}
            isLoading={inventory.isPending}
            isRefreshing={inventory.isFetching && !inventory.isPending}
            error={inventory.isError ? inventory.error : undefined}
            loadingLabel="Loading stock levels"
            minWidth="70rem"
            // Nothing available is the state that costs a sale today. The row
            // says so in words as well - the tint is the second signal, not
            // the only one.
            rowClassName={(row) =>
              row.availableQty <= 0 ? 'bg-danger-soft/60 hover:bg-danger-soft' : undefined
            }
            onRetry={() => {
              void inventory.refetch();
            }}
            emptyTitle={lowStockOnly ? 'Nothing needs reordering' : 'No stock records yet'}
            emptyDescription={
              lowStockOnly
                ? 'Every tracked product is above its reorder threshold.'
                : 'A stock record appears once a product is received into a location.'
            }
          />

          {inventory.data !== undefined && (
            <Pager
              page={inventory.data.pagination.page}
              limit={inventory.data.pagination.limit}
              total={inventory.data.pagination.total}
              totalPages={inventory.data.pagination.totalPages}
              onPageChange={(next) => {
                setSearchParams((current) => {
                  const params = new URLSearchParams(current);
                  params.set('page', String(next));
                  return params;
                });
              }}
            />
          )}
        </Card>

        <Card
          title="Movement ledger"
          description="Every change to stock, with who made it and why. Append-only — the twenty-five most recent."
        >
          <DataTable
            caption="Stock movements"
            columns={movementColumns}
            rows={movements.data?.movements}
            rowKey={(row) => row.id}
            isLoading={movements.isPending}
            error={movements.isError ? movements.error : undefined}
            loadingLabel="Loading the ledger"
            minWidth="60rem"
            onRetry={() => {
              void movements.refetch();
            }}
            emptyTitle="No movements yet"
            emptyDescription="Receipts, adjustments and shipments all land here as they happen."
          />
        </Card>
      </div>

      {dialog !== null && (
        <StockMovementDialog
          mode={dialog.mode}
          row={dialog.row}
          locations={locations.data?.locations ?? []}
          onClose={() => {
            setDialog(null);
          }}
        />
      )}
    </>
  );
}
