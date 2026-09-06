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
 * The status vocabulary is the gateway's, and it has seven values that fall
 * into three outcomes: settled, still in flight, and finished without money.
 * The filter groups them that way and the badges colour them that way, because
 * "EXPIRED" and "CANCELLED" mean the same thing to the person working the
 * queue even though they mean different things to Razorpay.
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
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { newIdempotencyKey } from '@/lib/forms';
import {
  formatDateTime,
  formatMoney,
  formatNumber,
  humanise,
  majorToMinor,
  minorToMajor,
} from '@/lib/format';
import { paymentStatusTone } from '@/lib/orders';
import { Permission } from '@/lib/permissions';
import type { Pagination } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

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

/**
 * The three outcomes, and which gateway statuses belong to each.
 *
 * `IN_FLIGHT` is amber rather than neutral on purpose: a transaction sitting
 * in CREATED, PENDING or AUTHORIZED is money the gateway may believe it has
 * and this system does not, which is the reconciliation queue and not a
 * resting state.
 */
const STATUS_GROUPS = [
  { label: 'Settled', statuses: ['CAPTURED'] },
  { label: 'Still in flight', statuses: ['CREATED', 'PENDING', 'AUTHORIZED'] },
  { label: 'Ended without payment', statuses: ['FAILED', 'CANCELLED', 'EXPIRED'] },
] as const;

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
  const { t } = useI18n();

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
      description={t('payments.theGatewayProcessesThisIt')}
      footer={
        <>
          <Button onClick={onClose} disabled={refund.isPending}>
            {t('payments.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={!isValid}
            isLoading={refund.isPending}
            onClick={() => {
              refund.mutate();
            }}
          >
            {t('payments.issueRefund')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error !== null && (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        )}

        {quote.data !== undefined && (
          <SummaryTiles
            items={[
              { label: 'Captured', value: money(quote.data.capturedMinor, quote.data.currency) },
              {
                label: 'Already refunded',
                value: money(quote.data.alreadyRefundedMinor, quote.data.currency),
              },
              {
                label: 'Refundable now',
                value: money(quote.data.maxRefundableMinor, quote.data.currency),
                tone: 'success',
              },
            ]}
          />
        )}

        <div className="space-y-2">
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
            variant="ghost"
            onClick={() => {
              setAmount(minorToMajor(maxMinor));
            }}
          >
            {t('payments.useTheFullRefundableAmount')}
          </Button>
        </div>

        <Field
          label={t('payments.reason')}
          hint={t('payments.recordedAgainstYourNameAnd')}
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
  const { t } = useI18n();

  const query = useQuery({
    queryKey: ['webhook-health'],
    queryFn: () => api.get<WebhookHealth>('/admin/payments/webhook-health'),
  });

  const columns: Column<WebhookEvent>[] = [
    {
      key: 'received',
      header: 'Received',
      nowrap: true,
      render: (row) => <span className="text-ink-muted">{formatDateTime(row.receivedAt)}</span>,
    },
    {
      key: 'event',
      header: 'Event',
      render: (row) => <span className="font-mono text-xxs">{row.eventType}</span>,
    },
    {
      key: 'signature',
      header: 'Signature',
      render: (row) =>
        row.signatureVerified ? (
          <Badge dot tone="success">
            {t('payments.verified')}
          </Badge>
        ) : (
          // An unverified signature is the serious one: something sent a
          // payment event this system could not prove came from the gateway.
          <Badge dot tone="danger">
            {t('payments.rejected')}
          </Badge>
        ),
    },
    {
      key: 'processing',
      header: 'Processing',
      render: (row) => (
        <Badge
          dot
          tone={
            row.processingStatus === 'PROCESSED'
              ? 'success'
              : row.processingStatus === 'FAILED'
                ? 'danger'
                : 'neutral'
          }
        >
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

  // The server's own tally, whatever shape it is in. Rendered rather than
  // discarded: it counts every delivery, where the table below is only the
  // most recent handful.
  const summary = Object.entries(query.data?.summary ?? {});

  return (
    <Card title={t('payments.webhookHealth')} description={t('payments.aGatewayEventOnlyCounts')}>
      {(rejected > 0 || summary.length > 0) && (
        <div className="space-y-3 px-4 pt-4">
          {rejected > 0 && (
            <Callout
              tone="danger"
              role="alert"
              title={t('payments.deliveriesAreFailingSignatureVerification')}
            >
              {formatNumber(rejected)} of the recent deliveries below could not be proved to have
              come from the gateway. Either the webhook secret here does not match the one in the
              gateway dashboard, or something else is posting to the endpoint.
            </Callout>
          )}

          {summary.length > 0 && (
            <SummaryTiles
              items={summary.map(([key, value]) => ({
                label: humanise(key),
                value: formatNumber(value),
              }))}
            />
          )}
        </div>
      )}

      <DataTable
        caption="Recent webhook deliveries"
        columns={columns}
        rows={query.data?.recent}
        rowKey={(row) => row.id}
        isLoading={query.isPending}
        error={query.isError ? query.error : undefined}
        loadingLabel="Loading webhook deliveries"
        minWidth="52rem"
        rowClassName={(row) =>
          row.signatureVerified ? undefined : 'bg-danger-soft/60 hover:bg-danger-soft'
        }
        onRetry={() => {
          void query.refetch();
        }}
        emptyTitle="No webhook deliveries yet"
        emptyDescription="Once the gateway is configured with this system's webhook URL, deliveries appear here."
      />
    </Card>
  );
}

export function PaymentsPage(): React.JSX.Element {
  const { t } = useI18n();

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
  const hasFilters = status !== '' || orderId !== '';

  const columns: Column<PaymentRow>[] = [
    {
      key: 'order',
      header: 'Order',
      nowrap: true,
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
        <div className="min-w-32">
          <Badge dot tone={paymentStatusTone(row.status)}>
            {humanise(row.status)}
          </Badge>
          {row.failureMessage !== null && (
            <p className="mt-1 text-xxs leading-relaxed text-danger">{row.failureMessage}</p>
          )}
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      nowrap: true,
      render: (row) => money(row.amountMinor, row.currency),
    },
    {
      key: 'captured',
      header: 'Captured',
      align: 'right',
      nowrap: true,
      render: (row) => (
        <span
          className={
            row.capturedMinor === '0'
              ? 'text-ink-subtle'
              : BigInt(row.capturedMinor) >= BigInt(row.amountMinor)
                ? 'font-medium text-success'
                : 'font-medium text-warning'
          }
        >
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
          <p className="flex items-center gap-1.5 text-ink">
            {humanise(row.provider)}
            {/* LIVE and TEST must never be confusable on a money screen. */}
            {row.mode === 'LIVE' ? (
              <Badge tone="danger">{t('payments.live')}</Badge>
            ) : (
              <Badge tone="neutral">{t('payments.test')}</Badge>
            )}
          </p>
          {row.method !== null && <p className="text-xxs text-ink-subtle">{row.method}</p>}
        </div>
      ),
    },
    {
      key: 'when',
      header: 'When',
      secondary: true,
      tertiary: true,
      nowrap: true,
      render: (row) => <span className="text-ink-muted">{formatDateTime(row.createdAt)}</span>,
    },
    {
      key: 'actions',
      header: <span className="sr-only">{t('payments.actions')}</span>,
      align: 'right',
      render: (row) => (
        <div className="flex justify-end gap-1">
          <Button
            size="sm"
            variant="ghost"
            // Scoped to the row being reconciled. Keyed off the mutation alone,
            // every Reconcile button on the page spins at once.
            isLoading={reconcile.isPending && reconcile.variables.id === row.id}
            onClick={() => {
              reconcile.mutate(row);
            }}
          >
            {t('payments.reconcile')}
            <span className="sr-only"> {row.orderNumber} with the gateway</span>
          </Button>
          {canRefund && row.capturedMinor !== '0' && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setRefundFor(row);
              }}
            >
              {t('payments.refund')}
              <span className="sr-only"> {row.orderNumber}</span>
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('payments.payments')}
        description={t('payments.whatTheGatewayConfirmedThis')}
      />

      <div className="space-y-5">
        <Card>
          <Toolbar>
            <ToolbarField label={t('payments.status')}>
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
                className="w-52"
              >
                <option value="">{t('payments.anyStatus')}</option>
                {STATUS_GROUPS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.statuses.map((value) => (
                      <option key={value} value={value}>
                        {humanise(value)}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </ToolbarField>

            {orderId !== '' && (
              <div className="flex h-10 items-center">
                <span className="inline-flex h-8 items-center gap-2 rounded-md border border-accent bg-accent-soft px-3 text-xs font-medium text-accent">
                  {t('payments.filteredToOneOrder')}
                  <button
                    type="button"
                    aria-label={t('payments.clearTheOrderFilter')}
                    className="text-accent hover:text-accent-hover"
                    onClick={() => {
                      setSearchParams((current) => {
                        const next = new URLSearchParams(current);
                        next.delete('orderId');
                        next.delete('page');
                        return next;
                      });
                    }}
                  >
                    ×
                  </button>
                </span>
              </div>
            )}

            {hasFilters && (
              <ToolbarActions>
                <Button
                  onClick={() => {
                    setSearchParams({});
                  }}
                >
                  {t('payments.clearFilters')}
                </Button>
              </ToolbarActions>
            )}
          </Toolbar>

          <DataTable
            caption="Payments"
            columns={columns}
            rows={query.data?.payments}
            rowKey={(row) => row.id}
            isLoading={query.isPending}
            isRefreshing={query.isFetching && !query.isPending}
            error={query.isError ? query.error : undefined}
            loadingLabel="Loading payments"
            minWidth="64rem"
            onRetry={() => {
              void query.refetch();
            }}
            emptyTitle={hasFilters ? 'Nothing matches these filters' : 'No payments yet'}
            emptyDescription={
              hasFilters
                ? 'Try another status, or clear the filters.'
                : 'A payment appears once a customer starts one. Nothing here is entered by hand.'
            }
            emptyAction={
              hasFilters ? (
                <Button
                  onClick={() => {
                    setSearchParams({});
                  }}
                >
                  {t('payments.clearFilters')}
                </Button>
              ) : undefined
            }
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
