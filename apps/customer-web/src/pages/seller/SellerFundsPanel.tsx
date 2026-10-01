/**
 * Seller Hub -> Payments: connecting the Stripe payout account, the seller's
 * receivables (gross, fees, refunds, held, reserve, available, in transit,
 * paid out), and each order's held funds with its release conditions.
 *
 * Every figure is the server's ledger; nothing is worked out here.
 */
import { useMutation, useQuery } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import {
  conditionKey,
  fetchSellerFinance,
  fetchSellerHolds,
  fundsStatusKey,
  fundsTone,
  type SellerBalance,
} from '@/lib/finance';
import { fetchPayoutAccount, formatMinor, startPayoutOnboarding } from '@/lib/seller';

const k = (key: string): TranslationKey => key as TranslationKey;

/** The connect button and what Stripe still needs. Only when a provider is configured. */
export function ConnectPayoutAccount(): React.JSX.Element | null {
  const { t } = useI18n();
  const toast = useToast();
  const account = useQuery({ queryKey: ['seller', 'payout-account'], queryFn: fetchPayoutAccount });
  const connect = useMutation({
    mutationFn: () => {
      const here = window.location.href;
      return startPayoutOnboarding({ returnUrl: here, refreshUrl: here });
    },
    onSuccess: (link) => {
      window.location.assign(link.url);
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });
  const data = account.data;
  if (data === undefined || !data.isProviderConfigured) return null;

  return (
    <div className="space-y-3 border-t border-border-subtle pt-4">
      <p className="text-sm text-ink">
        {t(k('finance.connect.state'))}{' '}
        <Badge tone={data.state === 'ENABLED' ? 'success' : 'warning'}>{t(k(`finance.connect.${data.state}`))}</Badge>
        {data.providerAccountId !== null && (
          <span className="ms-2 font-mono text-xs text-ink-muted">{data.providerAccountId}</span>
        )}
      </p>
      {data.pendingRequirements.length > 0 && data.state !== 'ENABLED' && (
        <ul className="list-disc ps-5 text-xs text-ink-muted" aria-label={t(k('finance.connect.requirements'))}>
          {data.pendingRequirements.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      {data.state !== 'ENABLED' && (
        <Button
          onClick={() => {
            connect.mutate();
          }}
          variant="primary"
          isLoading={connect.isPending}
        >
          {data.providerAccountId === null ? t(k('finance.connect.start')) : t(k('finance.connect.continue'))}
        </Button>
      )}
    </div>
  );
}

const ROWS: { field: keyof SellerBalance; key: string }[] = [
  { field: 'grossSalesMinor', key: 'finance.balance.gross' },
  { field: 'platformFeesMinor', key: 'finance.balance.fees' },
  { field: 'platformFeeTaxMinor', key: 'finance.balance.feeTax' },
  { field: 'refundsChargedMinor', key: 'finance.balance.refunds' },
  { field: 'heldMinor', key: 'finance.balance.held' },
  { field: 'reserveMinor', key: 'finance.balance.reserve' },
  { field: 'availableMinor', key: 'finance.balance.available' },
  { field: 'inTransitMinor', key: 'finance.balance.inTransit' },
  { field: 'paidOutMinor', key: 'finance.balance.paidOut' },
];

export function SellerFundsPanel(): React.JSX.Element | null {
  const { t, language } = useI18n();
  const finance = useQuery({ queryKey: ['seller', 'finance', 'balances'], queryFn: fetchSellerFinance });
  const holds = useQuery({ queryKey: ['seller', 'finance', 'holds'], queryFn: fetchSellerHolds });

  if (finance.data !== undefined && !finance.data.enabled) return null;

  return (
    <>
      <Card title={t(k('finance.balance.title'))} description={t(k('finance.balance.intro'))}>
        <div className="px-6 py-5">
          {finance.isPending && <LoadingState label={t(k('finance.loading'))} />}
          {finance.isError && (
            <ErrorState
              error={finance.error}
              onRetry={() => {
                void finance.refetch();
              }}
            />
          )}
          {finance.data !== undefined && (
            <>
              <p className="text-sm text-ink-muted">
                {t(k('finance.protection.terms'), { days: finance.data.releaseTerms.releaseAfterDays })}
                {finance.data.releaseTerms.reserveBps > 0 &&
                  ` ${t(k('finance.balance.reserveTerms'), {
                    percent: (finance.data.releaseTerms.reserveBps / 100).toString(),
                    days: finance.data.releaseTerms.reserveDays,
                  })}`}
              </p>
              {finance.data.balances.length === 0 ? (
                <EmptyState title={t(k('finance.balance.emptyTitle'))} description={t(k('finance.balance.empty'))} />
              ) : (
                finance.data.balances.map((balance) => (
                  <dl key={balance.currency} className="mt-4 grid gap-3 sm:grid-cols-3" aria-label={balance.currency}>
                    {ROWS.map((row) => (
                      <div key={row.field}>
                        <dt className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">{t(k(row.key))}</dt>
                        <dd className="mt-1 text-sm tabular-nums text-ink">
                          {formatMinor(balance[row.field], balance.currency, language)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ))
              )}
              <p className="mt-4 text-xs text-ink-muted">
                {finance.data.lastReconciledAt === null
                  ? t(k('finance.balance.notReconciled'))
                  : t(k('finance.balance.reconciled'), { date: formatDateTime(finance.data.lastReconciledAt) })}
              </p>
            </>
          )}
        </div>
      </Card>

      <Card title={t(k('finance.holds.title'))} description={t(k('finance.holds.intro'))}>
        {holds.data !== undefined && holds.data.items.length === 0 && (
          <EmptyState title={t(k('finance.holds.emptyTitle'))} description={t(k('finance.holds.empty'))} />
        )}
        {holds.data !== undefined && holds.data.items.length > 0 && (
          <ul className="divide-y divide-border-subtle">
            {holds.data.items.map((hold) => (
              <li key={hold.id} className="space-y-2 px-6 py-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-ink">{hold.sellerOrderNumber}</span>
                  <Badge tone={fundsTone(hold.status)}>{t(k(fundsStatusKey(hold.status)))}</Badge>
                </div>
                <p className="text-ink-muted">
                  {t(k('finance.holds.amounts'), {
                    allocated: formatMinor(hold.allocatedMinor, hold.currency, language),
                    released: formatMinor(hold.releasedMinor, hold.currency, language),
                    reserve: formatMinor(hold.reserveMinor, hold.currency, language),
                  })}
                </p>
                {hold.holdCode === 'DISPUTE' && <p className="text-xs text-warning">{t(k('finance.protection.disputeHold'))}</p>}
                {hold.holdCode === 'MANUAL' && (
                  <p className="text-xs text-warning">{hold.holdReason ?? t(k('finance.holds.manual'))}</p>
                )}
                <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {hold.conditions.map((condition) => (
                    <li key={condition.key} className={condition.met ? 'text-success' : 'text-ink-muted'}>
                      {condition.met ? '✓ ' : '○ '}
                      {t(k(conditionKey(condition.key)))}
                    </li>
                  ))}
                </ul>
                {hold.payout !== null && (
                  <p className="text-xs text-ink-muted">
                    {t(k('finance.holds.payout'), { reference: hold.payout.reference })}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
