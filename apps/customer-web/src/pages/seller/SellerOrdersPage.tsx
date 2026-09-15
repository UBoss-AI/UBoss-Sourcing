/**
 * Your part of the orders buyers have placed.
 *
 * A buyer places one order; a seller sees a GROUP over the lines that belong to
 * them, with its own number and its own dispatch deadline. What is NOT here is
 * as important as what is: no buyer email, no phone number, no payment
 * reference, and no other seller's lines. A marketplace that hands over the
 * buyer's contact details has handed over its own customer relationship.
 *
 * Overdue is shown first and shown loudly, because it is the one number on the
 * page that is costing the seller something right now.
 */
import { useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
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
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import {
  fetchLocations,
  fetchSellerOrders,
  formatMinor,
  nextActions,
  orderLabelKey,
  transitionOrder,
  type SellerOrderRow,
  type SellerOrderStatus,
} from '@/lib/seller';
import { ApprovalRequiredNotice, type SellerOutletContext } from './SellerLayout';

/**
 * The status tabs, in the order a seller works through them.
 *
 * `''` is every order and has a label of its own; the rest reuse the status
 * spellings from the catalogue, so a tab and the badge on the row beneath it
 * can never disagree about what "READY_FOR_DISPATCH" is called. "Returns" is
 * the exception: the tab holds a queue, the badge describes one order.
 */
const TABS = [
  { key: '', labelKey: 'seller.orders.tab.all' },
  { key: 'NEW', labelKey: 'seller.orderStatus.NEW' },
  { key: 'ACCEPTED', labelKey: 'seller.orderStatus.ACCEPTED' },
  { key: 'PROCESSING', labelKey: 'seller.orderStatus.PROCESSING' },
  { key: 'READY_FOR_DISPATCH', labelKey: 'seller.orderStatus.READY_FOR_DISPATCH' },
  { key: 'SHIPPED', labelKey: 'seller.orderStatus.SHIPPED' },
  { key: 'DELIVERED', labelKey: 'seller.orderStatus.DELIVERED' },
  { key: 'RETURN_REQUESTED', labelKey: 'seller.orders.tab.returns' },
  { key: 'CANCELLED', labelKey: 'seller.orderStatus.CANCELLED' },
] as const;

export function SellerOrdersPage(): React.JSX.Element {
  const { t } = useI18n();
  const seller = useOutletContext<SellerOutletContext>();

  // The gate before any hook — see the note in SellerListingsPage.
  if (!seller.isTrading) {
    return (
      <>
        <PageHeader title={t('seller.orders.title')} />
        <ApprovalRequiredNotice seller={seller} />
      </>
    );
  }

  return <OrdersBody />;
}

function OrdersBody(): React.JSX.Element {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [acting, setActing] = useState<{ row: SellerOrderRow; to: SellerOrderStatus } | null>(null);

  const status = params.get('status') ?? '';
  const overdueOnly = params.get('overdueOnly') === 'true';

  const query = useQuery({
    queryKey: ['seller', 'orders', status, overdueOnly],
    queryFn: () => {
      const next = new URLSearchParams({ pageSize: '50' });
      if (status.length > 0) next.set('status', status);
      if (overdueOnly) next.set('overdueOnly', 'true');
      return fetchSellerOrders(next);
    },
    // Orders arrive while the page is open. A seller watching this list during
    // a busy morning should see one land without pressing anything.
    refetchInterval: 60_000,
  });

  const update = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value.length === 0) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-5">
      <PageHeader title={t('seller.orders.title')} description={t('seller.orders.intro')} />

      <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        <div
          role="tablist"
          aria-label={t('seller.orders.tablist')}
          className="flex min-w-max gap-1 border-b border-border"
        >
          {TABS.map((tab) => {
            const isActive = tab.key === status;
            const count = tab.key === '' ? null : (query.data?.counts[tab.key] ?? 0);

            return (
              <button
                key={tab.key}
                role="tab"
                type="button"
                aria-selected={isActive}
                onClick={() => {
                  update('status', tab.key);
                }}
                className={cx(
                  'flex items-center gap-2 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-brand text-brand'
                    : 'border-transparent text-ink-muted hover:border-border-strong hover:text-ink',
                )}
              >
                {t(tab.labelKey)}
                {count !== null && count > 0 && (
                  <span
                    className={cx(
                      'tabular rounded-full px-1.5 py-0.5 text-xxs font-semibold',
                      isActive ? 'bg-brand-soft text-brand' : 'bg-surface-sunken text-ink-muted',
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <button
        type="button"
        aria-pressed={overdueOnly}
        onClick={() => {
          update('overdueOnly', overdueOnly ? '' : 'true');
        }}
        className={cx(
          'h-9 rounded-full border px-4 text-xs font-medium transition-colors',
          overdueOnly
            ? 'border-danger/40 bg-danger-soft text-danger'
            : 'border-border-strong bg-surface text-ink-muted hover:bg-surface-hover',
        )}
      >
        {t('seller.orders.overdueOnly')}
      </button>

      {query.isPending && <LoadingState label={t('seller.orders.loading')} />}

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
              overdueOnly ? t('seller.orders.emptyLateTitle') : t('seller.orders.emptyTitle')
            }
            description={
              overdueOnly ? t('seller.orders.emptyLateBody') : t('seller.orders.emptyBody')
            }
          />
        </Card>
      )}

      {query.data !== undefined && query.data.rows.length > 0 && (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border-subtle">
            {query.data.rows.map((row) => (
              <li key={row.id} className="px-4 py-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {/*
                        The order number is the way in. Everything a seller
                        needs to actually pack the box — the lines, the address,
                        the shipment form — is on the detail screen, and this
                        list is triage.
                      */}
                      <Link
                        to={`/seller/orders/${row.id}`}
                        className="text-sm font-semibold text-ink hover:text-brand"
                      >
                        {row.sellerOrderNumber}
                      </Link>
                      <Badge tone={orderTone(row.status)}>{t(orderLabelKey(row.status))}</Badge>
                      {row.isOverdue && (
                        <Badge tone="danger">{t('seller.orders.pastDispatch')}</Badge>
                      )}
                    </div>
                    <p className="mt-1 text-xxs text-ink-subtle">
                      {t('seller.orders.itemCount', { count: row.itemCount })}{' '}
                      {t('seller.orders.acrossLines', { count: row.lineCount })}
                      {row.locationName !== null &&
                        ` · ${t('seller.orders.fromPlace', { place: row.locationName })}`}
                      {row.placedAt !== null &&
                        ` · ${t('seller.orders.placedOn', {
                          date: new Date(row.placedAt).toLocaleDateString(),
                        })}`}
                    </p>
                    {row.dispatchDueAt !== null && (
                      <p
                        className={cx(
                          'mt-0.5 text-xxs',
                          row.isOverdue ? 'font-medium text-danger' : 'text-ink-muted',
                        )}
                      >
                        {t('seller.orders.dispatchBy', {
                          when: new Date(row.dispatchDueAt).toLocaleString(),
                        })}
                      </p>
                    )}
                  </div>

                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <div className="text-right">
                      <p className="tabular text-sm font-semibold text-ink">
                        {formatMinor(row.sellerNetMinor, row.currency)}
                      </p>
                      <p className="text-xxs text-ink-subtle">
                        {t('seller.orders.yourShareOf', {
                          total: formatMinor(row.goodsTotalMinor, row.currency),
                        })}
                      </p>
                    </div>

                    <div className="flex gap-2">
                      {nextActions(row.status).map((action) => (
                        <Button
                          key={action.to}
                          size="sm"
                          variant={action.isPrimary ? 'primary' : 'secondary'}
                          onClick={() => {
                            setActing({ row, to: action.to });
                          }}
                        >
                          {t(action.labelKey)}
                        </Button>
                      ))}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {acting !== null && (
        <TransitionDialog
          row={acting.row}
          to={acting.to}
          onClose={() => {
            setActing(null);
          }}
        />
      )}
    </div>
  );
}

function TransitionDialog({
  row,
  to,
  onClose,
}: {
  row: SellerOrderRow;
  to: SellerOrderStatus;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const [reason, setReason] = useState('');
  const [locationId, setLocationId] = useState('');

  const locations = useQuery({
    queryKey: ['seller', 'locations'],
    queryFn: fetchLocations,
    enabled: to === 'ACCEPTED',
  });

  // Both come from the server's own rules: cancelling and disputing require a
  // reason, and accepting requires a place to ship from or the order has no
  // dispatch deadline and can never be late.
  const needsReason = to === 'CANCELLED' || to === 'DISPUTED';
  const needsLocation = to === 'ACCEPTED';

  const mutation = useMutation({
    mutationFn: () =>
      transitionOrder(row.id, {
        status: to,
        reason: reason.trim().length === 0 ? null : reason.trim(),
        locationId: locationId.length === 0 ? null : locationId,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['seller', 'orders'] });
      await client.invalidateQueries({ queryKey: ['seller', 'dashboard'] });
      toast.success(t('seller.orders.updated', { order: row.sellerOrderNumber }));
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('seller.orders.updateFailed')));
    },
  });

  const operational = (locations.data?.locations ?? []).filter(
    (location) => location.isOperational && location.isPickupLocation,
  );

  const canSubmit =
    (!needsReason || reason.trim().length > 0) && (!needsLocation || locationId.length > 0);

  return (
    <Modal
      isOpen
      title={`${t(orderLabelKey(to))} — ${row.sellerOrderNumber}`}
      onClose={onClose}
    >
      <div className="space-y-4">
        {needsLocation && (
          <Field
            label={t('seller.orders.whichLocation')}
            hint={t('seller.orders.whichLocationHint')}
            required
          >
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={locationId}
                onChange={(event) => {
                  setLocationId(event.currentTarget.value);
                }}
              >
                <option value="">{t('seller.orders.chooseLocation')}</option>
                {operational.map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name} ({location.code})
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}

        {needsLocation && operational.length === 0 && !locations.isPending && (
          <p className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-ink">
            {t('seller.orders.noDispatchLocation')}
          </p>
        )}

        {needsReason && (
          <Field
            label={t('seller.orders.why')}
            hint={t('seller.orders.whyHint')}
            required
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={reason}
                onChange={(event) => {
                  setReason(event.currentTarget.value);
                }}
              />
            )}
          </Field>
        )}

        {to === 'CANCELLED' && (
          <p className="text-xxs leading-relaxed text-ink-muted">
            {t('seller.orders.rejectNote')}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant={to === 'CANCELLED' ? 'danger' : 'primary'}
            isLoading={mutation.isPending}
            disabled={!canSubmit}
            onClick={() => {
              mutation.mutate();
            }}
          >
            {t('seller.orders.confirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function orderTone(
  status: SellerOrderStatus,
): 'neutral' | 'brand' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'NEW':
      return 'warning';
    case 'ACCEPTED':
    case 'PROCESSING':
    case 'READY_FOR_DISPATCH':
      return 'brand';
    case 'SHIPPED':
    case 'DELIVERED':
      return 'success';
    case 'CANCELLED':
    case 'DISPUTED':
      return 'danger';
    default:
      return 'neutral';
  }
}
