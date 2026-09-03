/**
 * Payments.
 *
 * This screen reports on money; it does not move it. Three consequences:
 *
 *   - **There is no "mark as paid".** An order settles when a
 *     signature-verified provider webhook says so, and nothing else. If a
 *     payment looks stuck, Reconcile asks the gateway — it does not assert an
 *     answer.
 *   - **Refunds are quoted before they are issued.** The server returns the
 *     maximum refundable amount, which is captured minus already-refunded.
 *     Typing a larger number is refused server-side; this form refuses it
 *     first so nobody has to discover the limit by hitting it.
 *   - **A refund carries an idempotency key.** Generated once per attempt, so a
 *     double-click, a retry or a flaky connection cannot refund twice.
 *
 * Webhook health is on this page rather than hidden in settings because a
 * rejected signature means payments are silently not being recorded, and the
 * person who needs to know is looking at this screen.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, Field, Input, PageHeader, Select, Textarea } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { newIdempotencyKey } from '@/lib/forms';
import { formatDateTime, formatMoney, formatNumber, humanise, majorToMinor, minorToMajor } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import type { Pagination } from '@/lib/types';

interface PaymentRow {
  id: string;
  orderId: string;
  orderNumber: string;
  provider: string;
  mode: string;
  status: string;
  amountMinor: string;
  capturedMinor: string;
  currency: string;
  method: string | null;
  providerOrderId: string | null;
  providerPaymentId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  reconciledAt: string | null;
  createdAt: string;
}

interface WebhookEvent {
  id: string;
  provider: string;
  eventType: string;
  signatureVerified: boolean;
  processingStatus: string;
  processingError: string | null;
  orderId: string | null;
  receivedAt: string;
  processedAt: string | null;
}

interface WebhookHealth {
  summary: Record<string, number>;
  recent: WebhookEvent[];
}

interface RefundQuote {
  capturedMinor: string;
  alreadyRefundedMinor: string;
  maxRefundableMinor: string;
  currency: string;
}

function paymentTone(status: string): BadgeTone {
  if (status === 'CAPTURED') return 'success';
  if (status === 'FAILED' || status === 'CANCELLED' || status === 'EXPIRED') return 'danger';
  if (status === 'AUTHORIZED' || status === 'PENDING' || status === 'CREATED') return 'warning';
  return 'neutral';
}

function money(minor: string, currency: string): string {
  return formatMoney({ minor, formatted: minorToMajor(minor), currency });
}

function RefundDialog({
  payment,
  onClose,
}: {
  payment: PaymentRow;
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Generated once per dialog, not per click. A fresh key on retry would
  // defeat the point and could refund twice.
  const [idempotencyKey] = useState(() => newIdempotencyKey());

  const quote = useQuery({
    queryKey: ['refund-quote', payment.orderId],
    queryFn: () => api.get<RefundQuote>(`/admin/orders/${payment.orderId}/refund-quote`),
  });

  const refund = useMutation({
    mutationFn: () => {
      const minor = majorToMinor(amount);

      if (minor === null) {
        throw new ApiError(400, {
          code: 'VALIDATION_FAILED',
          message: 'Enter an amount like 500.00.',
        });
      }

      return api.post(
        `/admin/orders/${payment.orderId}/refunds`,
        { amountMinor: minor, reason: reason.trim() },
        { idempotencyKey },
      );
    },
    onSuccess: async () => {
      toast.success('Refund submitted to the gateway.');
      await queryClient.invalidateQueries({ queryKey: ['payments'] });
      await queryClient.invalidateQueries({ queryKey: ['order', payment.orderId] });
      onClose();
    },
    onError: (apiError) => {
      setError(apiError instanceof ApiError ? apiError.message : 'The refund could not be issued.');
    },
  });

  const maxMinor = quote.data?.maxRefundableMinor ?? '0';
  const typedMinor = amount.trim() === '' ? null : majorToMinor(amount);
  const isOverMax = typedMinor !== null && BigInt(typedMinor) > BigInt(maxMinor);
  const isValid =
    typedMinor !== null && BigInt(typedMinor) > 0n && !isOverMax && reason.trim().length > 0;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Refund ${payment.orderNumber}`}
      description="The gateway processes this. It cannot be undone from here."
      footer={
        <>
          <Button onClick={onClose} disabled={refund.isPending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!isValid}
            isLoading={refund.isPending}
            onClick={() => {
              refund.mutate();
            }}
          >
            Issue refund
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error !== null && (
          <p
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
          >
            {error}
          </p>
        )}

        {quote.data !== undefined && (
          <dl className="grid grid-cols-3 gap-px rounded-md border border-border bg-border text-center">
            {(
              [
                ['Captured', quote.data.capturedMinor],
                ['Already refunded', quote.data.alreadyRefundedMinor],
                ['Refundable now', quote.data.maxRefundableMinor],
              ] satisfies [string, string][]
            ).map(([label, value]) => (
              <div key={label} className="bg-surface px-3 py-2">
                <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                  {label}
                </dt>
                <dd className="mt-0.5 text-sm font-semibold tabular text-ink">
                  {money(value, quote.data.currency)}
                </dd>
              </div>
            ))}
          </dl>
        )}

        <Field
          label={`Refund amount (${payment.currency})`}
          hint={`At most ${money(maxMinor, quote.data?.currency ?? payment.currency)}.`}
          error={isOverMax ? 'That is more than is refundable on this order.' : undefined}
          required
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              inputMode="decimal"
              className="tabular"
              value={amount}
              aria-describedby={describedBy}
              invalid={isOverMax}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
            />
          )}
        </Field>

        <Button
          size="sm"
          onClick={() => {
            setAmount(minorToMajor(maxMinor));
          }}
        >
          Refund the full amount
        </Button>

        <Field
          label="Reason"
          hint="Recorded against your name and sent to the gateway."
          required
        >
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              rows={2}
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

function WebhookHealthPanel(): React.JSX.Element {
  const query = useQuery({
    queryKey: ['webhook-health'],
    queryFn: () => api.get<WebhookHealth>('/admin/payments/webhook-health'),
  });

  const columns: Column<WebhookEvent>[] = [
    {
      key: 'received',
      header: 'Received',
      render: (row) => <span className="whitespace-nowrap">{formatDateTime(row.receivedAt)}</span>,
    },
    { key: 'event', header: 'Event', render: (row) => <span className="font-mono text-xxs">{row.eventType}</span> },
    {
      key: 'signature',
      header: 'Signature',
      render: (row) =>
        row.signatureVerified ? (
          <Badge tone="success">Verified</Badge>
        ) : (
          // An unverified signature is the serious one: something sent a
          // payment event this system could not prove came from the gateway.
          <Badge tone="danger">Rejected</Badge>
        ),
    },
    {
      key: 'processing',
      header: 'Processing',
      render: (row) => (
        <Badge tone={row.processingStatus === 'PROCESSED' ? 'success' : row.processingStatus === 'FAILED' ? 'danger' : 'neutral'}>
          {humanise(row.processingStatus)}
        </Badge>
      ),
    },
    {
      key: 'error',
      header: 'Detail',
      secondary: true,
      render: (row) => row.processingError ?? <span className="text-ink-subtle">—</span>,
    },
  ];

  const rejected = query.data?.recent.filter((event) => !event.signatureVerified).length ?? 0;

  return (
    <Card
      title="Webhook health"
      description="A gateway event only counts once its signature verifies."
    >
      {rejected > 0 && (
        <p
          role="alert"
          className="mx-4 mt-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
        >
          {formatNumber(rejected)} recent delivery
          {rejected === 1 ? '' : 'ies'} failed signature verification. Either the webhook secret
          here does not match the one in the gateway dashboard, or something else is posting to the
          endpoint. Nothing from a rejected delivery has been applied.
        </p>
      )}

      <DataTable
        caption="Recent webhook deliveries"
        columns={columns}
        rows={query.data?.recent}
        rowKey={(row) => row.id}
        isLoading={query.isPending}
        error={query.isError ? query.error : undefined}
        emptyTitle="No webhook deliveries yet"
        emptyDescription="Once the gateway is configured with this system's webhook URL, deliveries appear here."
      />
    </Card>
  );
}

export function PaymentsPage(): React.JSX.Element {
  const { can } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const page = Number(searchParams.get('page') ?? '1');
  const status = searchParams.get('status') ?? '';
  const orderId = searchParams.get('orderId') ?? '';

  const [refundFor, setRefundFor] = useState<PaymentRow | null>(null);

  const query = useQuery({
    queryKey: ['payments', { page, status, orderId }],
    queryFn: () =>
      api.get<{ payments: PaymentRow[]; pagination: Pagination }>('/admin/payments', {
        query: {
          page,
          limit: 25,
          status: status === '' ? undefined : status,
          orderId: orderId === '' ? undefined : orderId,
        },
      }),
  });

  const reconcile = useMutation({
    mutationFn: (payment: PaymentRow) => api.post(`/admin/payments/${payment.id}/reconcile`),
    onSuccess: async () => {
      toast.success('Asked the gateway. The status here now matches theirs.');
      await queryClient.invalidateQueries({ queryKey: ['payments'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'The gateway could not be reached.');
    },
  });

  const canRefund = can(Permission.REFUND_CREATE);

  const columns: Column<PaymentRow>[] = [
    {
      key: 'order',
      header: 'Order',
      render: (row) => (
        <Link
          to={`/orders/${row.orderId}`}
          className="font-mono font-medium text-ink hover:text-accent hover:underline"
        >
          {row.orderNumber}
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => (
        <div>
          <Badge tone={paymentTone(row.status)}>{humanise(row.status)}</Badge>
          {row.failureMessage !== null && (
            <p className="mt-0.5 text-xxs text-danger">{row.failureMessage}</p>
          )}
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      render: (row) => money(row.amountMinor, row.currency),
    },
    {
      key: 'captured',
      header: 'Captured',
      align: 'right',
      render: (row) => (
        <span className={row.capturedMinor === '0' ? 'text-ink-subtle' : 'text-success'}>
          {money(row.capturedMinor, row.currency)}
        </span>
      ),
    },
    {
      key: 'provider',
      header: 'Gateway',
      secondary: true,
      render: (row) => (
        <div>
          <p className="text-ink">{humanise(row.provider)}</p>
          <p className="text-xxs text-ink-subtle">
            {row.mode}
            {row.method !== null && ` · ${row.method}`}
          </p>
        </div>
      ),
    },
    {
      key: 'when',
      header: 'When',
      secondary: true,
      render: (row) => <span className="whitespace-nowrap">{formatDateTime(row.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => (
        <div className="flex justify-end gap-1">
          <Button
            size="sm"
            variant="ghost"
            isLoading={reconcile.isPending}
            onClick={() => {
              reconcile.mutate(row);
            }}
          >
            Reconcile
          </Button>
          {canRefund && row.capturedMinor !== '0' && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setRefundFor(row);
              }}
            >
              Refund
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Payments"
        description="What the gateway confirmed. This screen reports money; it never moves it."
      />

      <div className="space-y-5">
        <Card>
          <div className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
            <label>
              <span className="mb-1 block text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                Status
              </span>
              <Select
                value={status}
                onChange={(event) => {
                  setSearchParams((current) => {
                    const next = new URLSearchParams(current);
                    if (event.target.value === '') next.delete('status');
                    else next.set('status', event.target.value);
                    next.delete('page');
                    return next;
                  });
                }}
                className="w-44"
              >
                <option value="">Any status</option>
                {['CREATED', 'PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'EXPIRED'].map(
                  (value) => (
                    <option key={value} value={value}>
                      {humanise(value)}
                    </option>
                  ),
                )}
              </Select>
            </label>

            {orderId !== '' && (
              <Button
                onClick={() => {
                  setSearchParams((current) => {
                    const next = new URLSearchParams(current);
                    next.delete('orderId');
                    return next;
                  });
                }}
              >
                Clear order filter
              </Button>
            )}
          </div>

          <DataTable
            caption="Payments"
            columns={columns}
            rows={query.data?.payments}
            rowKey={(row) => row.id}
            isLoading={query.isPending}
            error={query.isError ? query.error : undefined}
            onRetry={() => {
              void query.refetch();
            }}
            emptyTitle="No payments yet"
            emptyDescription="A payment appears once a customer starts one. Nothing here is entered by hand."
          />

          {query.data !== undefined && (
            <Pager
              page={query.data.pagination.page}
              limit={query.data.pagination.limit}
              total={query.data.pagination.total}
              totalPages={query.data.pagination.totalPages}
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

        <WebhookHealthPanel />
      </div>

      {refundFor !== null && (
        <RefundDialog
          payment={refundFor}
          onClose={() => {
            setRefundFor(null);
          }}
        />
      )}
    </>
  );
}
