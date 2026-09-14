/**
 * What you have earned, and where it is going.
 *
 * Two things kept apart on purpose, because they answer different questions
 * and go wrong separately: a SETTLEMENT is arithmetic over a period - this is
 * what you sold, this is what we kept, this is what is left - and a PAYOUT is
 * a transfer that either happened or did not.
 *
 * Every figure is shown as a line rather than as a total, because a seller
 * disputing a settlement needs to see which part they disagree with. A single
 * "net payable" with no breakdown is a number nobody can argue with, which is
 * not the same as a number nobody disputes.
 */
import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/ui';
import { cx } from '@/lib/cx';
import {
  fetchPayoutAccount,
  fetchPayouts,
  refreshPayoutAccount,
  fetchSettlementLines,
  fetchSettlements,
  formatMinor,
  type SettlementRow,
} from '@/lib/seller';
import type { SellerOutletContext } from './SellerLayout';

export function SellerPaymentsPage(): React.JSX.Element {
  const seller = useOutletContext<SellerOutletContext>();

  const settlements = useQuery({ queryKey: ['seller', 'settlements'], queryFn: fetchSettlements });
  const payoutAccount = useQuery({
    queryKey: ['seller', 'payout-account'],
    queryFn: fetchPayoutAccount,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Payments"
        description="Your statements, what the marketplace kept, and where the money goes."
      />

      {/* ---- The payout account ------------------------------------------- */}
      <Card
        title="Payout account"
        actions={
          payoutAccount.data?.isProviderConfigured === true ? <RefreshPayoutButton /> : undefined
        }
      >
        <div className="px-6 py-5">
          {payoutAccount.isPending && <LoadingState label="Checking your payout setup" />}

          {payoutAccount.isError && (
            <ErrorState
              error={payoutAccount.error}
              onRetry={() => {
                void payoutAccount.refetch();
              }}
            />
          )}

          {payoutAccount.data !== undefined && !payoutAccount.data.isProviderConfigured && (
            /*
              The configuration-required state, and the reason this whole panel
              branches rather than showing a reassuring default. This
              deployment has no payout provider, so it can neither verify a
              bank account nor send money - and a seller told "verified" by a
              system that cannot verify anything has been misled about their
              own money. Nothing is collected here and nothing is claimed.
            */
            <div className="space-y-3 rounded-lg border border-warning/30 bg-warning-soft px-4 py-4">
              <Badge tone="warning">Not set up yet</Badge>
              <p className="text-sm leading-relaxed text-ink">
                The marketplace has not finished setting up payouts, so nothing can be sent yet.
                Everything you earn is still being recorded in full and will be paid once this is
                in place.
              </p>
              {payoutAccount.data.missingConfigurationKey !== null && (
                <p className="text-xxs leading-relaxed text-ink-muted">
                  For whoever runs this marketplace: set{' '}
                  <code className="rounded bg-surface px-1 py-0.5 font-mono">
                    {payoutAccount.data.missingConfigurationKey}
                  </code>{' '}
                  and the provider return URLs. We deliberately do not collect bank details here —
                  they belong with the payment provider, not in this database.
                </p>
              )}
            </div>
          )}

          {payoutAccount.data !== undefined && payoutAccount.data.isProviderConfigured && (
            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">
                  Status
                </dt>
                <dd className="mt-1">
                  <Badge tone={payoutAccount.data.payoutsEnabled ? 'success' : 'warning'}>
                    {payoutAccount.data.payoutsEnabled ? 'Payouts enabled' : 'Not yet enabled'}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">
                  Account
                </dt>
                <dd className="mt-1 text-sm text-ink">
                  {payoutAccount.data.bankName ?? 'Not connected'}
                  {payoutAccount.data.accountLast4 !== null &&
                    ` ···· ${payoutAccount.data.accountLast4}`}
                </dd>
              </div>
              <div>
                <dt className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">
                  Currency
                </dt>
                <dd className="mt-1 text-sm text-ink">
                  {payoutAccount.data.payoutCurrency ?? '—'}
                </dd>
              </div>

              {payoutAccount.data.payoutsHeldByOperator && (
                <div className="sm:col-span-3">
                  <div className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3">
                    <p className="text-sm font-medium text-ink">Payouts are on hold</p>
                    <p className="mt-0.5 text-sm text-ink-muted">
                      {payoutAccount.data.payoutHoldReason ??
                        'The marketplace has paused payouts to this account.'}
                    </p>
                  </div>
                </div>
              )}
            </dl>
          )}
        </div>
      </Card>

      {/* ---- Statements ---------------------------------------------------- */}
      <Card
        title="Statements"
        description="One per settlement period, with every line that made it up."
      >
        {settlements.isPending && <LoadingState label="Loading your statements" />}

        {settlements.isError && (
          <ErrorState
            error={settlements.error}
            onRetry={() => {
              void settlements.refetch();
            }}
          />
        )}

        {settlements.data !== undefined && settlements.data.settlements.length === 0 && (
          <EmptyState
            title="No statements yet"
            description={
              seller.isTrading
                ? 'Your first statement appears once you have delivered an order.'
                : 'Statements start once your account is approved and you have sold something.'
            }
          />
        )}

        {settlements.data !== undefined && settlements.data.settlements.length > 0 && (
          <ul className="divide-y divide-border-subtle">
            {settlements.data.settlements.map((settlement) => (
              <li key={settlement.id} className="px-6 py-5">
                <SettlementPanel settlement={settlement} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <PayoutsCard isTrading={seller.isTrading} />
    </div>
  );
}

/**
 * Ask the provider again.
 *
 * A seller who has just finished verifying their bank details elsewhere comes
 * back to a screen that still says "not yet enabled", because nothing told this
 * side anything changed. Without this the only fix is guessing how long to wait
 * and reloading — so the button exists to make the wait a decision rather than a
 * superstition.
 */
function RefreshPayoutButton(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const mutation = useMutation({
    mutationFn: refreshPayoutAccount,
    onSuccess: async (account) => {
      await client.invalidateQueries({ queryKey: ['seller', 'payout-account'] });
      await client.invalidateQueries({ queryKey: ['seller', 'dashboard'] });
      toast.success(
        account.payoutsEnabled
          ? 'Your payout account is ready.'
          : 'Checked. Nothing has changed on the provider yet.',
      );
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'We could not check with the provider.'));
    },
  });

  return (
    <Button
      isLoading={mutation.isPending}
      onClick={() => {
        mutation.mutate();
      }}
    >
      Check again
    </Button>
  );
}

/**
 * The transfers themselves.
 *
 * Separate from the statements above, because the two go wrong separately: a
 * statement can be correct and the transfer still fail, and a seller chasing
 * "where is my money" is asking about this list, not that one.
 *
 * A failed payout must never be a dead end. `remediationHint` is stored for
 * exactly this line, and it is rendered next to the failure rather than behind
 * a support address.
 */
function PayoutsCard({ isTrading }: { isTrading: boolean }): React.JSX.Element {
  const payouts = useQuery({ queryKey: ['seller', 'payouts'], queryFn: fetchPayouts });

  const rows = payouts.data?.payouts ?? [];

  return (
    <Card title="Payouts" description="Money on its way to your bank, and what happened to it.">
      {payouts.isPending && <LoadingState label="Loading your payouts" />}

      {payouts.isError && (
        <ErrorState
          error={payouts.error}
          onRetry={() => {
            void payouts.refetch();
          }}
        />
      )}

      {payouts.isSuccess && rows.length === 0 && (
        <EmptyState
          title="No payouts yet"
          description={
            isTrading
              ? 'A payout is created once a statement is settled and your payout account is ready.'
              : 'Payouts start once your account is approved and you have been paid for something.'
          }
        />
      )}

      {rows.length > 0 && (
        <ul className="divide-y divide-border-subtle">
          {rows.map((payout) => (
            <li key={payout.id} className="px-6 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{payout.reference}</p>
                  <p className="mt-0.5 text-xxs text-ink-subtle">
                    {payout.paidAt !== null
                      ? `Paid ${new Date(payout.paidAt).toLocaleDateString()}`
                      : payout.scheduledFor !== null
                        ? `Due ${new Date(payout.scheduledFor).toLocaleDateString()}`
                        : 'Not scheduled yet'}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  <span className="tabular text-sm font-semibold text-ink">
                    {formatMinor(payout.amountMinor, payout.currency)}
                  </span>
                  <Badge tone={payoutTone(payout.status)}>{payoutLabel(payout.status)}</Badge>
                </div>
              </div>

              {payout.failureReason !== null && (
                <div className="mt-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2">
                  <p className="text-xs text-ink">{payout.failureReason}</p>
                  {payout.remediationHint !== null && (
                    <p className="mt-1 text-xs text-ink-muted">{payout.remediationHint}</p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function payoutLabel(status: string): string {
  switch (status) {
    case 'PENDING':
      return 'Being prepared';
    case 'IN_TRANSIT':
      return 'On its way';
    case 'PAID':
      return 'Paid';
    case 'FAILED':
      return 'Failed';
    case 'CANCELLED':
      return 'Cancelled';
    default:
      return status.toLowerCase().replace(/_/g, ' ');
  }
}

function payoutTone(status: string): 'neutral' | 'brand' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'PAID':
      return 'success';
    case 'IN_TRANSIT':
      return 'brand';
    case 'FAILED':
      return 'danger';
    case 'CANCELLED':
      return 'neutral';
    default:
      return 'warning';
  }
}

/**
 * One statement, broken down.
 *
 * The arithmetic is shown rather than asserted: gross, minus commission, minus
 * fees, minus refunds, plus adjustments, equals net. A seller should be able to
 * check the bottom line against the lines above it without a calculator and
 * without asking anybody.
 */
function SettlementPanel({ settlement }: { settlement: SettlementRow }): React.JSX.Element {
  const rows: { label: string; amountMinor: string; isDeduction: boolean }[] = [
    { label: 'Sales', amountMinor: settlement.grossMinor, isDeduction: false },
    { label: 'Marketplace commission', amountMinor: settlement.commissionMinor, isDeduction: true },
    { label: 'Payment processing', amountMinor: settlement.processingFeeMinor, isDeduction: true },
    { label: 'Refunds', amountMinor: settlement.refundsMinor, isDeduction: true },
    { label: 'Adjustments', amountMinor: settlement.adjustmentsMinor, isDeduction: false },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{settlement.reference}</p>
          <p className="mt-0.5 text-xxs text-ink-subtle">
            {new Date(settlement.periodStart).toLocaleDateString()} to{' '}
            {new Date(settlement.periodEnd).toLocaleDateString()}
          </p>
        </div>
        <Badge tone={settlementTone(settlement.status)}>{settlementLabel(settlement.status)}</Badge>
      </div>

      {settlement.holdReason !== null && (
        <p className="mt-3 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-ink">
          {settlement.holdReason}
        </p>
      )}

      <dl className="mt-4 space-y-1.5">
        {rows.map((row) => {
          // A zero line is omitted rather than shown as £0.00. A statement with
          // five zero rows and one real one buries the real one.
          if (BigInt(row.amountMinor) === 0n) return null;

          return (
            <div key={row.label} className="flex items-baseline justify-between gap-4">
              <dt className="text-sm text-ink-muted">{row.label}</dt>
              <dd
                className={cx(
                  'tabular text-sm',
                  row.isDeduction ? 'text-danger' : 'text-ink',
                )}
              >
                {row.isDeduction ? '−' : ''}
                {formatMinor(row.amountMinor, settlement.currency)}
              </dd>
            </div>
          );
        })}

        <div className="flex items-baseline justify-between gap-4 border-t border-border-subtle pt-2">
          <dt className="text-sm font-semibold text-ink">Payable to you</dt>
          <dd className="tabular text-sm font-semibold text-ink">
            {formatMinor(settlement.netPayableMinor, settlement.currency)}
          </dd>
        </div>
      </dl>

      <SettlementLines settlement={settlement} />
    </div>
  );
}

/**
 * Every movement the statement above is a sum of.
 *
 * Behind a disclosure, and fetched only when it is opened: a settlement period
 * can hold several hundred lines and loading all of them for every statement on
 * the page would make the screen unusable to answer a question most sellers do
 * not have.
 *
 * But when they do have it, it is the only thing that answers it. "Commission
 * £412.90" is not disputable; "commission on order SO-1043, £18.20" is.
 */
function SettlementLines({ settlement }: { settlement: SettlementRow }): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);

  const lines = useQuery({
    queryKey: ['seller', 'settlement-lines', settlement.id],
    queryFn: () => fetchSettlementLines(settlement.id),
    enabled: isOpen,
  });

  const rows = lines.data?.lines ?? [];

  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => {
          setIsOpen(!isOpen);
        }}
        className="text-xs font-medium text-brand hover:underline"
      >
        {isOpen ? 'Hide the lines' : 'Show every line'}
      </button>

      {isOpen && (
        <div className="mt-2">
          {lines.isPending && <LoadingState label="Loading the lines" />}

          {lines.isError && (
            <ErrorState
              error={lines.error}
              onRetry={() => {
                void lines.refetch();
              }}
            />
          )}

          {lines.isSuccess && rows.length === 0 && (
            <p className="text-xs text-ink-subtle">
              No individual lines were recorded for this period.
            </p>
          )}

          {rows.length > 0 && (
            <ul className="divide-y divide-border-subtle rounded-lg border border-border">
              {rows.map((line) => (
                <li key={line.id} className="flex items-baseline justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-xs text-ink">
                      {line.description ?? line.kind.toLowerCase().replace(/_/g, ' ')}
                    </p>
                    <p className="text-xxs text-ink-subtle">
                      {new Date(line.occurredAt).toLocaleDateString()}
                      {line.reason === null ? '' : ` · ${line.reason}`}
                    </p>
                  </div>
                  <span
                    className={cx(
                      'tabular shrink-0 text-xs',
                      BigInt(line.amountMinor) < 0n ? 'text-danger' : 'text-ink',
                    )}
                  >
                    {formatMinor(line.amountMinor, line.currency)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function settlementLabel(status: string): string {
  switch (status) {
    case 'OPEN':
      return 'Still open';
    case 'PENDING_PAYOUT':
      return 'Awaiting payout';
    case 'PAID':
      return 'Paid';
    case 'ON_HOLD':
      return 'On hold';
    default:
      return status;
  }
}

function settlementTone(status: string): 'neutral' | 'brand' | 'success' | 'warning' {
  switch (status) {
    case 'PAID':
      return 'success';
    case 'PENDING_PAYOUT':
      return 'brand';
    case 'ON_HOLD':
      return 'warning';
    default:
      return 'neutral';
  }
}
