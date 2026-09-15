/**
 * Stock, by product and by place.
 *
 * The row is the pair, not the product: a seller holding the same catheter in
 * Antwerp and in Leeds has two numbers to keep, two reorder levels and
 * possibly two batch numbers, and collapsing them into "487 units" loses the
 * only thing that decides which warehouse an order ships from.
 *
 * Adjusting stock asks for a reason, because the server insists on one - an
 * adjustment with no reason is how stock quietly disappears and nobody can say
 * when. The idempotency key is generated once per attempt, so a retry after a
 * timeout cannot move the same units twice.
 */
import { useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
} from '@/components/ui';
import { Modal } from '@/components/Modal';
import { useI18n } from '@/i18n/i18n-context';
import { newIdempotencyKey } from '@/lib/api';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { fetchInventory, recordStockMovement, type InventoryRow } from '@/lib/seller';
import { ApprovalRequiredNotice, type SellerOutletContext } from './SellerLayout';

export function SellerInventoryPage(): React.JSX.Element {
  const { t } = useI18n();
  const seller = useOutletContext<SellerOutletContext>();

  // The gate before any hook — see the note in SellerListingsPage.
  if (!seller.isTrading) {
    return (
      <>
        <PageHeader title={t('seller.inventory.title')} />
        <ApprovalRequiredNotice seller={seller} />
      </>
    );
  }

  return <InventoryBody />;
}

function InventoryBody(): React.JSX.Element {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [adjusting, setAdjusting] = useState<InventoryRow | null>(null);

  const lowOnly = params.get('lowOnly') === 'true';
  const search = params.get('search') ?? '';

  const query = useQuery({
    queryKey: ['seller', 'inventory', lowOnly, search],
    queryFn: () => {
      const next = new URLSearchParams({ pageSize: '100' });
      if (lowOnly) next.set('lowOnly', 'true');
      if (search.length > 0) next.set('search', search);
      return fetchInventory(next);
    },
  });

  const update = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value.length === 0) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('seller.inventory.title')}
        description={t('seller.inventory.intro')}
      />

      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="inventory-search">
          {t('seller.inventory.searchLabel')}
        </label>
        <input
          id="inventory-search"
          type="search"
          defaultValue={search}
          placeholder={t('seller.inventory.searchPlaceholder')}
          onChange={(event) => {
            const value = event.currentTarget.value;
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
              update('search', value.trim());
            }, 350);
          }}
          className="h-10 min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-subtle sm:max-w-sm"
        />

        <button
          type="button"
          aria-pressed={lowOnly}
          onClick={() => {
            update('lowOnly', lowOnly ? '' : 'true');
          }}
          className={cx(
            'h-10 rounded-full border px-4 text-xs font-medium transition-colors',
            lowOnly
              ? 'border-warning/40 bg-warning-soft text-warning'
              : 'border-border-strong bg-surface text-ink-muted hover:bg-surface-hover',
          )}
        >
          {t('seller.inventory.lowOnly')}
        </button>
      </div>

      {query.isPending && <LoadingState label={t('seller.inventory.loading')} />}

      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}

      {query.data !== undefined && query.data.rows.length === 0 && (
        <Card>
          <EmptyState
            title={
              lowOnly
                ? t('seller.inventory.emptyLowTitle')
                : t('seller.inventory.emptyTitle')
            }
            description={
              lowOnly
                ? t('seller.inventory.emptyLowBody')
                : t('seller.inventory.emptyBody')
            }
          />
        </Card>
      )}

      {query.data !== undefined && query.data.rows.length > 0 && (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle bg-surface-sunken text-left">
                  <th scope="col" className="px-4 py-2.5 text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                    {t('seller.inventory.column.product')}
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                    {t('seller.inventory.column.location')}
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                    {t('seller.inventory.column.available')}
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                    {t('seller.inventory.column.held')}
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                    {t('seller.inventory.column.batch')}
                  </th>
                  <th scope="col" className="px-4 py-2.5 text-right text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                    {t('seller.inventory.column.adjust')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {query.data.rows.map((row) => (
                  <tr
                    key={`${row.offerId}-${row.locationId}`}
                    className="border-b border-border-subtle last:border-b-0 hover:bg-surface-hover"
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink">{row.productName}</p>
                      <p className="text-xxs text-ink-subtle">{row.sellerSku}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-ink">{row.locationName}</p>
                      <p className="text-xxs text-ink-subtle">{row.locationCode}</p>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <p
                        className={cx(
                          'tabular font-medium',
                          row.availableQuantity <= 0
                            ? 'text-danger'
                            : row.isLow
                              ? 'text-warning'
                              : 'text-ink',
                        )}
                      >
                        {row.availableQuantity}
                      </p>
                      {row.isLow && row.availableQuantity > 0 && (
                        <Badge tone="warning">{t('seller.inventory.low')}</Badge>
                      )}
                      {row.reorderThreshold > 0 && (
                        <p className="text-xxs text-ink-subtle">
                          {t('seller.inventory.reorderAt', { count: row.reorderThreshold })}
                        </p>
                      )}
                    </td>
                    <td className="tabular px-4 py-3 text-right text-ink-muted">
                      {row.reservedQuantity}
                    </td>
                    <td className="px-4 py-3">
                      {row.batchNumber === null ? (
                        <span className="text-xxs text-ink-subtle">—</span>
                      ) : (
                        <>
                          <p className="text-xxs text-ink">{row.batchNumber}</p>
                          {row.expiresOn !== null && (
                            <p className="text-xxs text-ink-subtle">
                              {t('seller.inventory.expires', { date: row.expiresOn })}
                            </p>
                          )}
                        </>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        size="sm"
                        onClick={() => {
                          setAdjusting(row);
                        }}
                      >
                        {t('seller.inventory.adjust')}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {adjusting !== null && (
        <AdjustDialog
          row={adjusting}
          onClose={() => {
            setAdjusting(null);
          }}
        />
      )}
    </div>
  );
}

let timer = 0;

function AdjustDialog({
  row,
  onClose,
}: {
  row: InventoryRow;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const [type, setType] = useState<'RECEIPT' | 'ADJUSTMENT'>('RECEIPT');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');

  // Generated once per dialog, not per attempt. A retry after a timeout must
  // carry the SAME key, or the server treats it as a second movement and the
  // stock moves twice.
  const [idempotencyKey] = useState(() => newIdempotencyKey());

  const mutation = useMutation({
    mutationFn: () =>
      recordStockMovement({
        offerId: row.offerId,
        locationId: row.locationId,
        type,
        // A receipt adds; an adjustment can go either way, so its sign comes
        // from what the seller typed.
        quantityDelta: type === 'RECEIPT' ? Math.abs(Number(quantity)) : Number(quantity),
        reason: reason.trim().length === 0 ? null : reason.trim(),
        idempotencyKey,
      }),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ['seller', 'inventory'] });
      toast.success(
        t('seller.inventory.updated', { count: result.balance, place: row.locationName }),
      );
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('seller.inventory.updateFailed')));
    },
  });

  const parsed = Number(quantity);
  const isValid =
    quantity.trim().length > 0 &&
    Number.isInteger(parsed) &&
    parsed !== 0 &&
    (type !== 'ADJUSTMENT' || reason.trim().length > 0);

  return (
    <Modal
      isOpen
      title={t('seller.inventory.adjustTitle', { product: row.productName })}
      onClose={onClose}
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-muted">
          {row.reservedQuantity > 0
            ? t('seller.inventory.holdsWithReserved', {
                place: row.locationName,
                count: row.availableQuantity,
                reserved: row.reservedQuantity,
              })
            : t('seller.inventory.holds', {
                place: row.locationName,
                count: row.availableQuantity,
              })}
        </p>

        <Field label={t('seller.inventory.whatHappened')}>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={type}
              onChange={(event) => {
                setType(event.currentTarget.value as 'RECEIPT' | 'ADJUSTMENT');
              }}
            >
              <option value="RECEIPT">{t('seller.inventory.received')}</option>
              <option value="ADJUSTMENT">{t('seller.inventory.correction')}</option>
            </Select>
          )}
        </Field>

        <Field
          label={
            type === 'RECEIPT'
              ? t('seller.inventory.howManyArrived')
              : t('seller.inventory.changeBy')
          }
          {...(type === 'RECEIPT' ? {} : { hint: t('seller.inventory.changeByHint') })}
          required
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              type="number"
              step={1}
              value={quantity}
              onChange={(event) => {
                setQuantity(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        {type === 'ADJUSTMENT' && (
          <Field
            label={t('seller.inventory.why')}
            hint={t('seller.inventory.whyHint')}
            required
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={reason}
                placeholder={t('seller.inventory.whyPlaceholder')}
                onChange={(event) => {
                  setReason(event.currentTarget.value);
                }}
              />
            )}
          </Field>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant="primary"
            isLoading={mutation.isPending}
            disabled={!isValid}
            onClick={() => {
              mutation.mutate();
            }}
          >
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
