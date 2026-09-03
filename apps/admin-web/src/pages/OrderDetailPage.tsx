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
  Card,
  ErrorState,
  Field,
  LoadingState,
  PageHeader,
  Textarea,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatDateTime, formatMoney, formatNumber, humanise } from '@/lib/format';
import { orderStatusTone, transitionLabel } from '@/lib/orders';
import { Permission } from '@/lib/permissions';
import type { AvailableTransition, OrderDetail } from '@/lib/orders';
import type { Money } from '@/lib/types';

function AddressBlock({
  title,
  address,
}: {
  title: string;
  address: OrderDetail['shippingAddress'];
}): React.JSX.Element {
  return (
    <div>
      <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{title}</h3>
      {address === null ? (
        <p className="mt-1 text-sm text-ink-muted">Not provided</p>
      ) : (
        <address className="mt-1 text-sm not-italic text-ink">
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
            Cancel
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
          <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-sm text-ink">
            Cancelling releases any reserved stock back to available. If the order has been paid,
            refund it separately from the Payments panel — cancelling does not move money.
          </p>
        )}

        {error !== null && (
          <p
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
          >
            {error}
          </p>
        )}

        <Field
          label="Reason"
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

  return (
    <Card title="Internal note" description="Staff only. Customers never see this.">
      <div className="space-y-2 px-5 py-4">
        <label htmlFor="internal-note" className="sr-only">
          Internal note
        </label>
        <Textarea
          id="internal-note"
          rows={3}
          value={note}
          disabled={!canWrite}
          onChange={(event) => {
            setNote(event.target.value);
          }}
        />
        {canWrite && (
          <Button
            size="sm"
            isLoading={save.isPending}
            disabled={note === (order.internalNote ?? '')}
            onClick={() => {
              save.mutate();
            }}
          >
            Save note
          </Button>
        )}
      </div>
    </Card>
  );
}

export function OrderDetailPage(): React.JSX.Element {
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
      toast.error(error instanceof ApiError ? error.message : 'The decision could not be recorded.');
    },
  });

  if (query.isPending) {
    return (
      <Card>
        <LoadingState label="Loading the order" />
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      </Card>
    );
  }

  const order = query.data.order;
  const isAwaitingApproval = order.status === 'PENDING_APPROVAL';
  const canApprove = can(Permission.ORDER_APPROVE);
  const isSettled = BigInt(order.totals.paid.minor) >= BigInt(order.totals.grandTotal.minor);

  return (
    <>
      <PageHeader
        title={order.orderNumber}
        description={`Placed ${formatDateTime(order.placedAt ?? order.createdAt)} · ${humanise(order.source)}`}
        actions={
          <Link
            to="/orders"
            className="inline-flex h-9 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-sunken"
          >
            Back to orders
          </Link>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-5">
          {isAwaitingApproval && (
            <Card
              title="Waiting for approval"
              description="This order exceeds the customer's approval threshold."
            >
              <div className="space-y-3 px-5 py-4">
                {canApprove ? (
                  <>
                    <Field label="Comment" hint="Optional. Recorded with the decision.">
                      {({ inputId }) => (
                        <Textarea
                          id={inputId}
                          rows={2}
                          value={approvalComment}
                          onChange={(event) => {
                            setApprovalComment(event.target.value);
                          }}
                        />
                      )}
                    </Field>
                    <div className="flex gap-2">
                      <Button
                        variant="primary"
                        isLoading={decide.isPending}
                        onClick={() => {
                          decide.mutate(true);
                        }}
                      >
                        Approve order
                      </Button>
                      <Button
                        variant="danger"
                        isLoading={decide.isPending}
                        onClick={() => {
                          decide.mutate(false);
                        }}
                      >
                        Reject order
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="text-sm text-ink-muted">
                    A Finance Approver or Business Owner has to decide this one.
                  </p>
                )}
              </div>
            </Card>
          )}

          <Card title="Items">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">
                  Items on order {order.orderNumber} — {order.items.length} line
                  {order.items.length === 1 ? '' : 's'}
                </caption>
                <thead>
                  <tr className="border-b border-border">
                    <th scope="col" className="px-4 py-2.5 text-left text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                      Product
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                      Qty
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                      Unit price
                    </th>
                    <th scope="col" className="hidden px-4 py-2.5 text-right text-xxs font-semibold uppercase tracking-wider text-ink-subtle lg:table-cell">
                      Tax
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                      Line total
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {order.items.map((item) => (
                    <tr key={item.id}>
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
                      <td className="px-4 py-2.5 text-right tabular">{formatNumber(item.quantity)}</td>
                      <td className="px-4 py-2.5 text-right tabular">{formatMoney(item.unitPrice)}</td>
                      <td className="hidden px-4 py-2.5 text-right tabular lg:table-cell">
                        {formatMoney(item.tax)}
                        <span className="ml-1 text-xxs text-ink-subtle">({item.taxRatePercent}%)</span>
                      </td>
                      <td className="px-4 py-2.5 text-right font-medium tabular">
                        {formatMoney(item.lineTotal)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <dl className="space-y-1.5 border-t border-border px-4 py-3 text-sm">
              {(
                [
                  ['Subtotal', order.totals.subtotal],
                  ['Discount', order.totals.discount],
                  ['Tax', order.totals.tax],
                  ['Shipping', order.totals.shipping],
                ] satisfies [string, Money][]
              ).map(([label, money]) => (
                <div key={label} className="flex justify-between">
                  <dt className="text-ink-muted">{label}</dt>
                  <dd className="tabular text-ink">{formatMoney(money)}</dd>
                </div>
              ))}
              <div className="flex justify-between border-t border-border pt-1.5 text-base font-semibold">
                <dt>Grand total</dt>
                <dd className="tabular">{formatMoney(order.totals.grandTotal)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-muted">Paid</dt>
                <dd className={`tabular ${isSettled ? 'text-success' : 'text-warning'}`}>
                  {formatMoney(order.totals.paid)}
                </dd>
              </div>
              {order.totals.refunded.minor !== '0' && (
                <div className="flex justify-between">
                  <dt className="text-ink-muted">Refunded</dt>
                  <dd className="tabular text-danger">{formatMoney(order.totals.refunded)}</dd>
                </div>
              )}
            </dl>
          </Card>

          <Card title="Delivery">
            <div className="grid gap-6 px-5 py-4 sm:grid-cols-2">
              <AddressBlock title="Shipping address" address={order.shippingAddress} />
              <AddressBlock title="Billing address" address={order.billingAddress} />
            </div>
            {order.customerNote !== null && (
              <div className="border-t border-border px-5 py-3">
                <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                  Customer note
                </h3>
                <p className="mt-1 text-sm text-ink">{order.customerNote}</p>
              </div>
            )}
          </Card>

          <InternalNote order={order} />

          <Card title="Timeline" description="Every status change, with who made it and why.">
            <ol className="divide-y divide-border">
              {order.timeline.map((entry, index) => (
                <li key={`${entry.at}:${String(index)}`} className="flex flex-wrap gap-x-3 gap-y-1 px-5 py-3">
                  <span className="whitespace-nowrap text-xs text-ink-subtle">
                    {formatDateTime(entry.at)}
                  </span>
                  <span className="text-sm text-ink">
                    {entry.from === null ? 'Created as' : `${humanise(entry.from)} →`}{' '}
                    <Badge tone={orderStatusTone(entry.to)}>{humanise(entry.to)}</Badge>
                  </span>
                  <span className="text-xs text-ink-muted">
                    by {entry.actorType === 'SYSTEM' ? 'the system' : humanise(entry.actorType)}
                  </span>
                  {entry.reason !== null && (
                    <span className="w-full text-xs text-ink-muted">{entry.reason}</span>
                  )}
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Status">
            <div className="space-y-3 px-5 py-4">
              <Badge tone={orderStatusTone(order.status)}>{humanise(order.status)}</Badge>

              {order.cancelReason !== null && (
                <p className="text-xs text-ink-muted">Cancelled: {order.cancelReason}</p>
              )}

              {order.availableTransitions.length === 0 ? (
                <p className="text-xs text-ink-muted">
                  Nothing can move from here. This is a final state, or the next step belongs to the
                  system.
                </p>
              ) : (
                <div className="space-y-2">
                  <p className="text-xs text-ink-muted">
                    Only these moves are allowed from {humanise(order.status)}.
                  </p>
                  {order.availableTransitions.map((transition) => (
                    <Button
                      key={transition.to}
                      className="w-full"
                      variant={transition.to === 'CANCELLED' ? 'secondary' : 'primary'}
                      onClick={() => {
                        setTransitionFor(transition);
                      }}
                    >
                      {transitionLabel(transition.to)}
                    </Button>
                  ))}
                </div>
              )}

              {order.reservationCount > 0 && (
                <p className="border-t border-border pt-3 text-xs text-ink-muted">
                  {formatNumber(order.reservationCount)} stock reservation
                  {order.reservationCount === 1 ? '' : 's'} held for this order.
                </p>
              )}
            </div>
          </Card>

          <Card title="Customer">
            <div className="px-5 py-4 text-sm">
              {order.customer === null ? (
                <p className="text-ink-muted">No customer on this order.</p>
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
                    <p className="mt-1 text-xs text-ink-muted">{order.customer.email}</p>
                  )}
                </>
              )}
            </div>
          </Card>

          <Card
            title="Payment"
            description="Reported, never edited. Only a verified gateway event settles an order."
          >
            <div className="space-y-3 px-5 py-4 text-sm">
              {order.payments.length === 0 && order.paymentLinks.length === 0 ? (
                <p className="text-ink-muted">No payment activity yet.</p>
              ) : (
                <>
                  {order.payments.map((payment) => (
                    <div key={payment.id} className="border-b border-border pb-2 last:border-0">
                      <div className="flex items-center justify-between gap-2">
                        <Badge tone={payment.status === 'CAPTURED' ? 'success' : 'warning'}>
                          {humanise(payment.status)}
                        </Badge>
                        <span className="tabular font-medium">{formatMoney(payment.amount)}</span>
                      </div>
                      {payment.failureMessage != null && (
                        <p className="mt-1 text-xs text-danger">{payment.failureMessage}</p>
                      )}
                      <p className="mt-0.5 text-xxs text-ink-subtle">
                        {formatDateTime(payment.createdAt)}
                      </p>
                    </div>
                  ))}

                  {order.paymentLinks.map((link) => (
                    <div key={link.id} className="border-b border-border pb-2 last:border-0">
                      <p className="text-xs font-medium text-ink">Payment link</p>
                      <p className="text-xxs text-ink-muted">{link.recipientEmail}</p>
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
                <div className="border-t border-border pt-2">
                  <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                    Refunds
                  </p>
                  {order.refunds.map((refund) => (
                    <div key={refund.id} className="mt-1 flex justify-between text-xs">
                      <span>{humanise(refund.status)}</span>
                      <span className="tabular">{formatMoney(refund.amount)}</span>
                    </div>
                  ))}
                </div>
              )}

              {can(Permission.PAYMENT_READ) && (
                <Link
                  to={`/payments?orderId=${order.id}`}
                  className="block text-xs font-medium text-accent underline underline-offset-2"
                >
                  Open in Payments
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
