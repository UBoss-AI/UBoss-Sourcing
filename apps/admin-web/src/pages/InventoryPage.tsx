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
import { Badge, Button, Card, Field, Input, Textarea, PageHeader, Select } from '@/components/ui';
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
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
          >
            {formError}
          </div>
        )}

        <dl className="grid grid-cols-3 gap-px rounded-md border border-border bg-border text-center">
          {[
            ['On hand', row.onHandQty],
            ['Reserved', row.reservedQty],
            ['Available', row.availableQty],
          ].map(([label, value]) => (
            <div key={String(label)} className="bg-surface px-3 py-2">
              <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                {label}
              </dt>
              <dd className="mt-0.5 text-sm font-semibold tabular text-ink">
                {formatNumber(Number(value))}
              </dd>
            </div>
          ))}
        </dl>

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
              hint="Negative to remove stock, positive to add it. Use a receipt for deliveries."
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

            <p className="text-sm text-ink-muted">
              On hand would become{' '}
              <span className={projected < 0 ? 'font-semibold text-danger' : 'font-semibold text-ink'}>
                {formatNumber(projected)}
              </span>
              {projected < 0 && ' — the server will refuse a negative balance.'}
            </p>

            <Field
              label="Reason"
              hint="Recorded in the ledger against your name. Be specific."
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

  const stockColumns: Column<InventoryRow>[] = [
    {
      key: 'product',
      header: 'Product',
      render: (row) => (
        <div>
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
      key: 'location',
      header: 'Location',
      secondary: true,
      render: (row) => row.location.name,
    },
    { key: 'onHand', header: 'On hand', align: 'right', render: (row) => formatNumber(row.onHandQty) },
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
      render: (row) =>
        row.isLowStock ? (
          <Badge tone="warning">at {formatNumber(row.reorderThreshold)}</Badge>
        ) : (
          formatNumber(row.reorderThreshold)
        ),
    },
    {
      key: 'valuation',
      header: 'Value',
      align: 'right',
      secondary: true,
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
      render: (row) => <span className="whitespace-nowrap">{formatDateTime(row.createdAt)}</span>,
    },
    {
      key: 'type',
      header: 'Type',
      render: (row) => <Badge tone={movementTone(row.type)}>{humanise(row.type)}</Badge>,
    },
    {
      key: 'product',
      header: 'Product',
      render: (row) => (
        <div>
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
      render: (row) => row.actorEmail ?? humanise(row.actorType),
    },
  ];

  return (
    <>
      <PageHeader
        title="Inventory"
        description="On hand is what exists. Available is what a customer can buy."
      />

      <div className="space-y-5">
        <Card>
          <div className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
            <label className="min-w-56 flex-1">
              <span className="mb-1 block text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                Search
              </span>
              <Input
                type="search"
                value={searchText}
                placeholder="Product name or SKU"
                onChange={(event) => {
                  setSearchText(event.target.value);
                }}
              />
            </label>

            <label className="flex items-center gap-2 pb-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={lowStockOnly}
                onChange={(event) => {
                  setSearchParams((current) => {
                    const next = new URLSearchParams(current);
                    if (event.target.checked) next.set('lowStockOnly', 'true');
                    else next.delete('lowStockOnly');
                    next.delete('page');
                    return next;
                  });
                }}
                className="h-4 w-4 rounded border-border-strong text-accent"
              />
              Low stock only
            </label>
          </div>

          <DataTable
            caption="Stock levels"
            columns={stockColumns}
            rows={inventory.data?.inventory}
            rowKey={(row) => row.balanceId}
            isLoading={inventory.isPending}
            error={inventory.isError ? inventory.error : undefined}
            onRetry={() => {
              void inventory.refetch();
            }}
            emptyTitle={lowStockOnly ? 'Nothing is running low' : 'No stock records yet'}
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
          description="Every change to stock, with who made it and why. Append-only."
        >
          <DataTable
            caption="Stock movements"
            columns={movementColumns}
            rows={movements.data?.movements}
            rowKey={(row) => row.id}
            isLoading={movements.isPending}
            error={movements.isError ? movements.error : undefined}
            emptyTitle="No movements yet"
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
