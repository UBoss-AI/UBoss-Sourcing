/**
 * Order detail.
 *
 * The single rule this page is organised around: **the server decides what may
 * happen next.** `availableTransitions` comes back with every order, and the
 * buttons are generated from it. This page contains no copy of the state
 * machine, so it cannot offer a move the backend would refuse, and it cannot
 * fall behind when the machine changes.
 *
 * Two things it will never offer:
 *   - A way to mark an order paid. Only a signature-verified provider event
 *     does that. The payment panel reports; it does not edit.
 *   - CONFIRMED as a manual transition. The server reserves that for itself,
 *     so it never appears in `availableTransitions` for a human.
 *
 * The two facts somebody opens this page for — where the order is, and whether
 * it has been paid — are badges beside the title, so they are read before the
 * page is scrolled.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  ErrorState,
  Field,
  LoadingState,
  PageHeader,
  Textarea,
} from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { cx } from '@/lib/cx';
import { formatDateTime, formatMoney, formatNumber, humanise } from '@/lib/format';
import { orderStatusTone, paymentStatusTone, transitionLabel } from '@/lib/orders';
import { Permission } from '@/lib/permissions';
import type { AvailableTransition, OrderDetail, OrderTotals } from '@/lib/orders';
import type { Money } from '@/lib/types';
import { InvoicePanel } from '@/pages/order/InvoicePanel';
import { useI18n } from '@/i18n/i18n-context';

/** The same three-way reading of the totals the order queue shows. */
function paymentState(totals: OrderTotals): { label: string; tone: BadgeTone } {
  const paid = BigInt(totals.paid.minor);
  const due = BigInt(totals.grandTotal.minor);
  const refunded = BigInt(totals.refunded.minor);

  if (refunded > 0n)
    return { label: refunded >= paid ? 'Refunded' : 'Part refunded', tone: 'danger' };
  if (paid <= 0n) return { label: 'Unpaid', tone: 'neutral' };
  if (paid >= due) return { label: 'Paid', tone: 'success' };
  return { label: 'Part paid', tone: 'warning' };
}

function AddressBlock({
  title,
  address,
}: {
  title: string;
  address: OrderDetail['shippingAddress'];
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div>
      <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{title}</h3>
      {address === null ? (
        <p className="mt-1 text-sm text-ink-muted">{t('orderDetail.notProvided')}</p>
      ) : (
        <address className="mt-1 text-sm not-italic leading-relaxed text-ink">
          {address.contactName !== null && <div className="font-medium">{address.contactName}</div>}
          <div>{address.line1}</div>
          {address.line2 !== null && <div>{address.line2}</div>}
          <div>
            {address.city}
            {address.state !== null && `, ${address.state}`} {address.postalCode}
          </div>
          <div>{address.country}</div>
          {address.contactPhone !== null && (
            <div className="mt-1 text-ink-muted">{address.contactPhone}</div>
          )}
        </address>
      )}
    </div>
  );
}

function TransitionDialog({
  order,
  transition,
  onClose,
}: {
  order: OrderDetail;
  transition: AvailableTransition;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();

  const queryClient = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () =>
      api.post(`/admin/orders/${order.id}/transition`, {
        to: transition.to,
        reason: reason.trim() === '' ? undefined : reason.trim(),
      }),
    onSuccess: async () => {
      toast.success(`Order moved to ${humanise(transition.to)}.`);
      await queryClient.invalidateQueries({ queryKey: ['order', order.id] });
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      onClose();
    },
    onError: (apiError) => {
      // The state machine's refusal explains itself - "an order cannot ship
      // before it is packed" - and that is more use than a generic failure.
      setError(apiError instanceof ApiError ? apiError.message : 'The order could not be moved.');
    },
  });

  const needsReason = transition.requiresReason && reason.trim() === '';

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={transitionLabel(transition.to)}
      description={`${order.orderNumber} · currently ${humanise(order.status)}`}
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            {t('orderDetail.cancel')}
          </Button>
          <Button
            variant={transition.to === 'CANCELLED' ? 'danger' : 'primary'}
            disabled={needsReason}
            isLoading={mutation.isPending}
            onClick={() => {
              mutation.mutate();
            }}
          >
            {transitionLabel(transition.to)}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {transition.to === 'CANCELLED' && (
          <Callout tone="warning" title={t('orderDetail.cancellingDoesNotMoveMoney')}>
            {t('orderDetail.anyReservedStockGoesBack')}
          </Callout>
        )}

        {error !== null && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}

        <Field
          label={t('orderDetail.reason')}
          hint={
            transition.requiresReason
              ? 'Required. Recorded on the order timeline against your name.'
              : 'Optional. Recorded on the order timeline.'
          }
          required={transition.requiresReason}
        >
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              rows={3}
              value={reason}
              aria-describedby={describedBy}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}

function InternalNote({ order }: { order: OrderDetail }): React.JSX.Element {
  const { t } = useI18n();

  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const [note, setNote] = useState(order.internalNote ?? '');

  useEffect(() => {
    setNote(order.internalNote ?? '');
  }, [order.internalNote]);

  const save = useMutation({
    mutationFn: () =>
      api.patch(`/admin/orders/${order.id}/note`, {
        internalNote: note.trim() === '' ? null : note,
      }),
    onSuccess: async () => {
      toast.success('Note saved.');
      await queryClient.invalidateQueries({ queryKey: ['order', order.id] });
    },
    onError: () => {
      toast.error('The note could not be saved.');
    },
  });

  const canWrite = can(Permission.ORDER_NOTE_WRITE);
  const isDirty = note !== (order.internalNote ?? '');

  return (
    <Card
      title={t('orderDetail.internalNote')}
      description={t('orderDetail.staffOnlyCustomersNeverSee')}
    >
      <div className="space-y-2 px-5 py-4">
        <label htmlFor="internal-note" className="sr-only">
          {t('orderDetail.internalNote')}
        </label>
        <Textarea
          id="internal-note"
          rows={3}
          value={note}
          disabled={!canWrite}
          placeholder={
            canWrite ? 'Anything the next person handling this order should know.' : undefined
          }
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
        {canWrite && (
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              isLoading={save.isPending}
              disabled={!isDirty}
              onClick={() => {
                save.mutate();
              }}
            >
              {t('orderDetail.saveNote')}
            </Button>
            {isDirty && (
              <span role="status" className="text-xs font-medium text-warning">
                {t('orderDetail.unsaved')}
              </span>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

export function OrderDetailPage(): React.JSX.Element {
  const { t } = useI18n();

  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [transitionFor, setTransitionFor] = useState<AvailableTransition | null>(null);
  const [approvalComment, setApprovalComment] = useState('');

  const query = useQuery({
    queryKey: ['order', id],
    queryFn: () => api.get<{ order: OrderDetail }>(`/admin/orders/${String(id)}`),
    enabled: id !== undefined,
  });

  const decide = useMutation({
    mutationFn: (approved: boolean) =>
      api.post(`/admin/orders/${String(id)}/approval`, {
        approved,
        comment: approvalComment.trim() === '' ? undefined : approvalComment.trim(),
      }),
    onSuccess: async (_result, approved) => {
      toast.success(approved ? 'Order approved.' : 'Order rejected.');
      setApprovalComment('');
      await queryClient.invalidateQueries({ queryKey: ['order', id] });
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiError ? error.message : 'The decision could not be recorded.',
      );
    },
  });

  if (query.isPending) {
    return (
      <>
        <PageHeader
          title={t('orderDetail.order')}
          back={{ to: '/orders', label: 'Back to orders' }}
        />
        <Card>
          <LoadingState label={t('orderDetail.loadingTheOrder')} />
        </Card>
      </>
    );
  }

  if (query.isError) {
    return (
      <>
        <PageHeader
          title={t('orderDetail.order')}
          back={{ to: '/orders', label: 'Back to orders' }}
        />
        <Card>
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        </Card>
      </>
    );
  }

  const order = query.data.order;
  const isAwaitingApproval = order.status === 'PENDING_APPROVAL';
  const canApprove = can(Permission.ORDER_APPROVE);
  const payment = paymentState(order.totals);
  const isSettled = BigInt(order.totals.paid.minor) >= BigInt(order.totals.grandTotal.minor);

  // Forward moves and the way out are two different kinds of decision, so they
  // are two groups rather than one column of identical buttons.
  const forwardTransitions = order.availableTransitions.filter((step) => step.to !== 'CANCELLED');
  const exitTransitions = order.availableTransitions.filter((step) => step.to === 'CANCELLED');

  return (
    <>
      <PageHeader
        title={order.orderNumber}
        back={{ to: '/orders', label: 'Back to orders' }}
        description={`Placed ${formatDateTime(order.placedAt ?? order.createdAt)} · ${humanise(order.source)} · ${formatNumber(order.items.length)} line${order.items.length === 1 ? '' : 's'}`}
        meta={
          <>
            <Badge dot tone={orderStatusTone(order.status)}>
              {humanise(order.status)}
            </Badge>
            <Badge dot tone={payment.tone}>
              {payment.label}
            </Badge>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-5">
          {isAwaitingApproval && (
            <Card
              title={t('orderDetail.waitingForApproval')}
              description={t('orderDetail.thisOrderExceedsTheCustomer')}
              tone="danger"
            >
              <div className="space-y-3 px-5 py-4">
                {canApprove ? (
                  <>
                    <Field
                      label={t('orderDetail.comment')}
                      hint={t('orderDetail.optionalRecordedWithTheDecision')}
                    >
                      {({ inputId, describedBy }) => (
                        <Textarea
                          id={inputId}
                          rows={2}
                          value={approvalComment}
                          aria-describedby={describedBy}
                          onChange={(event) => {
                            setApprovalComment(event.target.value);
                          }}
                        />
                      )}
                    </Field>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="primary"
                        isLoading={decide.isPending && decide.variables}
                        onClick={() => {
                          decide.mutate(true);
                        }}
                      >
                        {t('orderDetail.approveOrder')}
                      </Button>
                      <Button
                        variant="danger"
                        isLoading={decide.isPending && !decide.variables}
                        onClick={() => {
                          decide.mutate(false);
                        }}
                      >
                        {t('orderDetail.rejectOrder')}
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-ink-muted">
                    {t('orderDetail.aFinanceApproverOrBusiness')}
                  </p>
                )}
              </div>
            </Card>
          )}

          <Card title={t('orderDetail.items')}>
            <div
              className="overflow-x-auto"
              role="region"
              aria-label={t('orderDetail.orderItems')}
              tabIndex={0}
            >
              <table className="w-full min-w-[36rem] border-collapse text-sm">
                <caption className="sr-only">
                  Items on order {order.orderNumber} — {order.items.length} line
                  {order.items.length === 1 ? '' : 's'}
                </caption>
                {/* Same header treatment as every DataTable in the panel: a
                    tinted band with a heavier rule beneath it. */}
                <thead className="bg-surface-sunken">
                  <tr className="border-b border-border-strong/40">
                    <th
                      scope="col"
                      className="px-4 py-2.5 text-left text-xxs font-semibold uppercase tracking-wider text-ink-muted"
                    >
                      {t('orderDetail.product')}
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-2.5 text-right text-xxs font-semibold uppercase tracking-wider text-ink-muted"
                    >
                      {t('orderDetail.qty')}
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-2.5 text-right text-xxs font-semibold uppercase tracking-wider text-ink-muted"
                    >
                      {t('orderDetail.unitPrice')}
                    </th>
                    <th
                      scope="col"
                      className="hidden px-4 py-2.5 text-right text-xxs font-semibold uppercase tracking-wider text-ink-muted lg:table-cell"
                    >
                      {t('orderDetail.tax')}
                    </th>
                    <th
                      scope="col"
                      className="px-4 py-2.5 text-right text-xxs font-semibold uppercase tracking-wider text-ink-muted"
                    >
                      {t('orderDetail.lineTotal')}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {order.items.map((item) => (
                    <tr key={item.id} className="transition-colors hover:bg-surface-hover">
                      <td className="px-4 py-2.5">
                        <Link
                          to={`/products/${item.productId}`}
                          className="font-medium text-ink hover:text-accent hover:underline"
                        >
                          {item.name}
                        </Link>
                        {item.variantName !== null && (
                          <span className="text-ink-muted"> — {item.variantName}</span>
                        )}
                        <p className="font-mono text-xxs text-ink-subtle">{item.sku}</p>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular">
                        {formatNumber(item.quantity)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right tabular">
                        {formatMoney(item.unitPrice)}
                      </td>
                      <td className="hidden whitespace-nowrap px-4 py-2.5 text-right tabular lg:table-cell">
                        {formatMoney(item.tax)}
                        <span className="ml-1 text-xxs text-ink-subtle">
                          ({item.taxRatePercent}%)
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right font-medium tabular">
                        {formatMoney(item.lineTotal)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* The totals sit on the sunken ground so they read as a summary of
                the table above rather than as one more row of it. */}
            <dl className="space-y-1.5 border-t border-border bg-surface-sunken px-4 py-3 text-sm">
              {(
                [
                  ['Subtotal', order.totals.subtotal],
                  ['Discount', order.totals.discount],
                  ['Tax', order.totals.tax],
                  ['Shipping', order.totals.shipping],
                ] satisfies [string, Money][]
              ).map(([label, amount]) => (
                <div key={label} className="flex justify-between gap-4">
                  <dt className="text-ink-muted">{label}</dt>
                  <dd className="tabular text-ink">{formatMoney(amount)}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-4 border-t border-border pt-2 text-base font-semibold">
                <dt>{t('orderDetail.grandTotal')}</dt>
                <dd className="tabular">{formatMoney(order.totals.grandTotal)}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-ink-muted">{t('orderDetail.paid')}</dt>
                <dd
                  className={cx('tabular font-medium', isSettled ? 'text-success' : 'text-warning')}
                >
                  {formatMoney(order.totals.paid)}
                </dd>
              </div>
              {order.totals.refunded.minor !== '0' && (
                <div className="flex justify-between gap-4">
                  <dt className="text-ink-muted">{t('orderDetail.refunded')}</dt>
                  <dd className="tabular font-medium text-danger">
                    {formatMoney(order.totals.refunded)}
                  </dd>
                </div>
              )}
            </dl>
          </Card>

          <Card
            title={t('orderDetail.delivery')}
            description={order.shippingMethodName ?? undefined}
          >
            <div className="grid gap-6 px-5 py-4 sm:grid-cols-2">
              <AddressBlock
                title={t('orderDetail.shippingAddress')}
                address={order.shippingAddress}
              />
              <AddressBlock
                title={t('orderDetail.billingAddress')}
                address={order.billingAddress}
              />
            </div>
            {order.customerNote !== null && (
              <div className="border-t border-border-subtle px-5 py-3">
                <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                  {t('orderDetail.customerNote')}
                </h3>
                <p className="mt-1 text-sm leading-relaxed text-ink">{order.customerNote}</p>
              </div>
            )}
          </Card>

          <InternalNote order={order} />

          <Card
            title={t('orderDetail.timeline')}
            description={t('orderDetail.everyStatusChangeWithWho')}
          >
            <ol className="divide-y divide-border-subtle">
              {order.timeline.map((entry, index) => (
                <li
                  key={`${entry.at}:${String(index)}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3"
                >
                  <span className="w-40 shrink-0 whitespace-nowrap text-xs text-ink-subtle">
                    {formatDateTime(entry.at)}
                  </span>
                  <span className="flex items-center gap-2 text-sm text-ink">
                    {entry.from === null ? (
                      <span className="text-ink-muted">{t('orderDetail.createdAs')}</span>
                    ) : (
                      <>
                        <span className="text-ink-muted">{humanise(entry.from)}</span>
                        <span aria-hidden="true" className="text-ink-subtle">
                          →
                        </span>
                      </>
                    )}
                    <Badge dot tone={orderStatusTone(entry.to)}>
                      {humanise(entry.to)}
                    </Badge>
                  </span>
                  <span className="text-xs text-ink-muted">
                    by {entry.actorType === 'SYSTEM' ? 'the system' : humanise(entry.actorType)}
                  </span>
                  {entry.reason !== null && (
                    <span className="w-full pl-40 text-xs leading-relaxed text-ink-muted">
                      {entry.reason}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title={t('orderDetail.whatHappensNext')}>
            <div className="space-y-3 px-5 py-4">
              {order.cancelReason !== null && (
                <Callout tone="danger" title={t('orderDetail.cancelled')}>
                  {order.cancelReason}
                </Callout>
              )}

              {order.availableTransitions.length === 0 ? (
                <p className="text-xs leading-relaxed text-ink-muted">
                  {t('orderDetail.nothingCanMoveFromHere')}
                </p>
              ) : (
                <>
                  <p className="text-xs leading-relaxed text-ink-muted">
                    Only these moves are allowed from {humanise(order.status)}. The server decides
                    the list, so nothing here can be refused for being out of order.
                  </p>

                  {forwardTransitions.map((transition) => (
                    <Button
                      key={transition.to}
                      className="w-full"
                      variant="primary"
                      onClick={() => {
                        setTransitionFor(transition);
                      }}
                    >
                      {transitionLabel(transition.to)}
                    </Button>
                  ))}

                  {/* Cancelling stays quiet rather than red. It is separated
                      from the forward moves so it cannot be hit by momentum,
                      and the dialog behind it is where the warning lives. */}
                  {exitTransitions.length > 0 && (
                    <div className="space-y-2 border-t border-border-subtle pt-3">
                      {exitTransitions.map((transition) => (
                        <Button
                          key={transition.to}
                          className="w-full"
                          variant="secondary"
                          onClick={() => {
                            setTransitionFor(transition);
                          }}
                        >
                          {transitionLabel(transition.to)}
                        </Button>
                      ))}
                    </div>
                  )}
                </>
              )}

              {order.reservationCount > 0 && (
                <p className="border-t border-border-subtle pt-3 text-xs leading-relaxed text-ink-muted">
                  {formatNumber(order.reservationCount)} stock reservation
                  {order.reservationCount === 1 ? '' : 's'} held for this order.
                </p>
              )}
            </div>
          </Card>

          {/* Above the customer card: an invoice is about the order, and it
              is the thing somebody comes to this page to raise or to send. */}
          <InvoicePanel orderId={order.id} />

          <Card title={t('orderDetail.customer')}>
            <div className="px-5 py-4 text-sm">
              {order.customer === null ? (
                <p className="text-ink-muted">{t('orderDetail.noCustomerOnThisOrder')}</p>
              ) : (
                <>
                  <Link
                    to={`/customers/${order.customer.id}`}
                    className="font-medium text-ink hover:text-accent hover:underline"
                  >
                    {order.customer.fullName ?? order.customer.email ?? 'Customer'}
                  </Link>
                  {order.customer.organization !== null && (
                    <p className="text-xs text-ink-muted">{order.customer.organization}</p>
                  )}
                  {order.customer.email !== undefined && (
                    <p className="mt-1 break-words text-xs text-ink-muted">
                      {order.customer.email}
                    </p>
                  )}
                </>
              )}
            </div>
          </Card>

          <Card
            title={t('orderDetail.payment')}
            description={t('orderDetail.reportedNeverEditedOnlyA')}
          >
            <div className="space-y-3 px-5 py-4 text-sm">
              {order.payments.length === 0 && order.paymentLinks.length === 0 ? (
                <p className="text-ink-muted">{t('orderDetail.noPaymentActivityYet')}</p>
              ) : (
                <>
                  {order.payments.map((item) => (
                    <div
                      key={item.id}
                      className="border-b border-border-subtle pb-2.5 last:border-0 last:pb-0"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <Badge dot tone={paymentStatusTone(item.status)}>
                          {humanise(item.status)}
                        </Badge>
                        <span className="tabular font-medium">{formatMoney(item.amount)}</span>
                      </div>
                      {item.failureMessage != null && (
                        <p className="mt-1 text-xs leading-relaxed text-danger">
                          {item.failureMessage}
                        </p>
                      )}
                      <p className="mt-1 text-xxs text-ink-subtle">
                        {formatDateTime(item.createdAt)}
                      </p>
                    </div>
                  ))}

                  {order.paymentLinks.map((link) => (
                    <div
                      key={link.id}
                      className="border-b border-border-subtle pb-2.5 last:border-0 last:pb-0"
                    >
                      <p className="text-xs font-medium text-ink">{t('orderDetail.paymentLink')}</p>
                      <p className="break-words text-xxs text-ink-muted">{link.recipientEmail}</p>
                      <p className="mt-0.5 text-xxs text-ink-subtle">
                        {link.usedAt !== null
                          ? `Used ${formatDateTime(link.usedAt)}`
                          : link.revokedAt !== null
                            ? 'Revoked'
                            : `Expires ${formatDateTime(link.expiresAt)}`}
                      </p>
                    </div>
                  ))}
                </>
              )}

              {order.refunds.length > 0 && (
                <div className="border-t border-border-subtle pt-2.5">
                  <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                    {t('orderDetail.refunds')}
                  </p>
                  {order.refunds.map((refund) => (
                    <div key={refund.id} className="mt-1 flex justify-between gap-2 text-xs">
                      <span className="text-ink-muted">{humanise(refund.status)}</span>
                      <span className="tabular font-medium text-danger">
                        {formatMoney(refund.amount)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {can(Permission.PAYMENT_READ) && (
                <Link
                  to={`/payments?orderId=${order.id}`}
                  className="block border-t border-border-subtle pt-2.5 text-xs font-medium text-accent underline underline-offset-2"
                >
                  {t('orderDetail.openInPayments')}
                </Link>
              )}
            </div>
          </Card>
        </div>
      </div>

      {transitionFor !== null && (
        <TransitionDialog
          order={order}
          transition={transitionFor}
          onClose={() => {
            setTransitionFor(null);
          }}
        />
      )}
    </>
  );
}
