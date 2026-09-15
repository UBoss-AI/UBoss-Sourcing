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
import type { TranslationKey } from '@/i18n/i18n-context';
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
  const { t } = useI18n();

  const payoutAccount = useQuery({
    queryKey: ['seller', 'payout-account'],
    queryFn: fetchPayoutAccount,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('seller.payments.title')}
        description={t('seller.payments.intro')}
      />

      {/* ---- The payout account ------------------------------------------- */}
      <Card
        title={t('seller.payments.payoutAccount')}
        actions={
          payoutAccount.data?.isProviderConfigured === true ? <RefreshPayoutButton /> : undefined
        }
      >
        <div className="px-6 py-5">
          {payoutAccount.isPending && <LoadingState label={t('seller.payments.checkingPayout')} />}

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
              <Badge tone="warning">{t('seller.payments.notSetUp')}</Badge>
              <p className="text-sm leading-relaxed text-ink">{t('seller.payments.noProvider')}</p>
              {payoutAccount.data.missingConfigurationKey !== null && (
                <p className="text-xxs leading-relaxed text-ink-muted">
                  {t('seller.payments.operatorNoteBefore')}{' '}
                  <code className="rounded bg-surface px-1 py-0.5 font-mono">
                    {payoutAccount.data.missingConfigurationKey}
                  </code>{' '}
                  {t('seller.payments.operatorNoteAfter')}
                </p>
              )}
            </div>
          )}

          {payoutAccount.data !== undefined && payoutAccount.data.isProviderConfigured && (
            <dl className="grid gap-4 sm:grid-cols-3">
              <div>
                <dt className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">
                  {t('seller.payments.status')}
                </dt>
                <dd className="mt-1">
                  <Badge tone={payoutAccount.data.payoutsEnabled ? 'success' : 'warning'}>
                    {payoutAccount.data.payoutsEnabled
                      ? t('seller.payments.payoutsEnabled')
                      : t('seller.payments.notYetEnabled')}
                  </Badge>
                </dd>
              </div>
              <div>
                <dt className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">
                  {t('seller.payments.account')}
                </dt>
                <dd className="mt-1 text-sm text-ink">
                  {payoutAccount.data.bankName ?? t('seller.payments.notConnected')}
                  {payoutAccount.data.accountLast4 !== null &&
                    ` ···· ${payoutAccount.data.accountLast4}`}
                </dd>
              </div>
              <div>
                <dt className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">
                  {t('seller.payments.currency')}
                </dt>
                <dd className="mt-1 text-sm text-ink">
                  {payoutAccount.data.payoutCurrency ?? '—'}
                </dd>
              </div>

              {payoutAccount.data.payoutsHeldByOperator && (
                <div className="sm:col-span-3">
                  <div className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3">
                    <p className="text-sm font-medium text-ink">
                      {t('seller.payments.payoutsOnHold')}
                    </p>
                    <p className="mt-0.5 text-sm text-ink-muted">
                      {payoutAccount.data.payoutHoldReason ?? t('seller.payments.holdDefault')}
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
        title={t('seller.payments.statements')}
        description={t('seller.payments.statementsIntro')}
      >
        {settlements.isPending && <LoadingState label={t('seller.payments.loadingStatements')} />}

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
            title={t('seller.payments.noStatementsTitle')}
            description={
              seller.isTrading
                ? t('seller.payments.noStatementsTrading')
                : t('seller.payments.noStatementsPending')
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
          ? t('seller.payments.payoutReady')
          : t('seller.payments.payoutUnchanged'),
      );
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('seller.payments.checkFailed')));
    },
  });

  return (
    <Button
      isLoading={mutation.isPending}
      onClick={() => {
        mutation.mutate();
      }}
    >
      {t('seller.payments.checkAgain')}
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
  const { t } = useI18n();
  const payouts = useQuery({ queryKey: ['seller', 'payouts'], queryFn: fetchPayouts });

  const rows = payouts.data?.payouts ?? [];

  return (
    <Card title={t('seller.payments.payouts')} description={t('seller.payments.payoutsIntro')}>
      {payouts.isPending && <LoadingState label={t('seller.payments.loadingPayouts')} />}

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
          title={t('seller.payments.noPayoutsTitle')}
          description={
            isTrading
              ? t('seller.payments.noPayoutsTrading')
              : t('seller.payments.noPayoutsPending')
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
                      ? t('seller.payments.paidOn', {
                          date: new Date(payout.paidAt).toLocaleDateString(),
                        })
                      : payout.scheduledFor !== null
                        ? t('seller.payments.dueOn', {
                            date: new Date(payout.scheduledFor).toLocaleDateString(),
                          })
                        : t('seller.payments.notScheduled')}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  <span className="tabular text-sm font-semibold text-ink">
                    {formatMinor(payout.amountMinor, payout.currency)}
                  </span>
                  <Badge tone={payoutTone(payout.status)}>{t(payoutLabelKey(payout.status))}</Badge>
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

/**
 * What a payout's state is called.
 *
 * A status this build has never heard of falls back to `unknown` rather than to
 * the raw enum: a seller reading about their own money should not be shown
 * `IN_TRANSIT_TO_BANK`, and the amount and the date beside it still say what
 * matters.
 */
function payoutLabelKey(status: string): TranslationKey {
  switch (status) {
    case 'PENDING':
      return 'seller.payments.payoutStatus.PENDING';
    case 'IN_TRANSIT':
      return 'seller.payments.payoutStatus.IN_TRANSIT';
    case 'PAID':
      return 'seller.payments.payoutStatus.PAID';
    case 'FAILED':
      return 'seller.payments.payoutStatus.FAILED';
    case 'CANCELLED':
      return 'seller.payments.payoutStatus.CANCELLED';
    default:
      return 'seller.payments.payoutStatus.unknown';
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
  const { t } = useI18n();

  const rows: { labelKey: TranslationKey; amountMinor: string; isDeduction: boolean }[] = [
    {
      labelKey: 'seller.payments.line.sales',
      amountMinor: settlement.grossMinor,
      isDeduction: false,
    },
    {
      labelKey: 'seller.payments.line.commission',
      amountMinor: settlement.commissionMinor,
      isDeduction: true,
    },
    {
      labelKey: 'seller.payments.line.processing',
      amountMinor: settlement.processingFeeMinor,
      isDeduction: true,
    },
    {
      labelKey: 'seller.payments.line.refunds',
      amountMinor: settlement.refundsMinor,
      isDeduction: true,
    },
    {
      labelKey: 'seller.payments.line.adjustments',
      amountMinor: settlement.adjustmentsMinor,
      isDeduction: false,
    },
  ];

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{settlement.reference}</p>
          <p className="mt-0.5 text-xxs text-ink-subtle">
            {t('seller.payments.period', {
              from: new Date(settlement.periodStart).toLocaleDateString(),
              to: new Date(settlement.periodEnd).toLocaleDateString(),
            })}
          </p>
        </div>
        <Badge tone={settlementTone(settlement.status)}>
          {t(settlementLabelKey(settlement.status))}
        </Badge>
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
            <div key={row.labelKey} className="flex items-baseline justify-between gap-4">
              <dt className="text-sm text-ink-muted">{t(row.labelKey)}</dt>
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
          <dt className="text-sm font-semibold text-ink">{t('seller.payments.payableToYou')}</dt>
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
  const { t } = useI18n();
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
        {isOpen ? t('seller.payments.hideLines') : t('seller.payments.showLines')}
      </button>

      {isOpen && (
        <div className="mt-2">
          {lines.isPending && <LoadingState label={t('seller.payments.loadingLines')} />}

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
              {t('seller.payments.noLines')}
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

function settlementLabelKey(status: string): TranslationKey {
  switch (status) {
    case 'OPEN':
      return 'seller.payments.settlementStatus.OPEN';
    case 'PENDING_PAYOUT':
      return 'seller.payments.settlementStatus.PENDING_PAYOUT';
    case 'PAID':
      return 'seller.payments.settlementStatus.PAID';
    case 'ON_HOLD':
      return 'seller.payments.settlementStatus.ON_HOLD';
    default:
      return 'seller.payments.settlementStatus.unknown';
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
