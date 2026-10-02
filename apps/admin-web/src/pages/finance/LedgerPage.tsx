/**
 * Finance -> Ledger (checklist Master rows 59, 60, 61).
 *
 * One screen for where every order's money is: gross, platform fee, the tax
 * on it, refunds and the seller's settlement per order, drilled down to the
 * journal entries; the held funds with their release conditions, staff holds
 * and the two-person early release; refunds and chargebacks with their
 * accounting status; payouts; and reconciliation with the provider.
 */
import { Fragment, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, PageHeader } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatDate, formatMoney } from '@/lib/format';
import {
  decideRelease,
  fetchHolds,
  fetchLedgerOrders,
  fetchOrderLedger,
  fetchReconciliations,
  fetchRefundsChargebacks,
  money,
  refreshEscrow,
  requestRelease,
  resumeHold,
  runPayouts,
  runReconciliation,
  suspendHold,
  type FundHold,
} from '@/lib/ledger';
import { Permission } from '@/lib/permissions';

const k = (key: string): TranslationKey => key as TranslationKey;
type Tab = 'orders' | 'holds' | 'refunds' | 'reconciliation';
const TABS: Tab[] = ['orders', 'holds', 'refunds', 'reconciliation'];

const th = 'px-3 py-2 text-start text-xxs font-medium uppercase tracking-wider text-ink-subtle';
const td = 'px-3 py-2 text-sm text-ink tabular-nums';

function holdTone(status: string): 'neutral' | 'brand' | 'success' | 'warning' {
  return status === 'RELEASED' ? 'success' : status === 'ON_HOLD' ? 'warning' : status === 'HELD' ? 'brand' : 'neutral';
}

export function LedgerPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const { can } = useSession();
  const mayWrite = can(Permission.FINANCE_POLICY_WRITE);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('orders');

  const refresh = useMutation({
    mutationFn: refreshEscrow,
    onSuccess: () => {
      toast.success(t(k('finance.ledger.refreshed')));
      void queryClient.invalidateQueries({ queryKey: ['finance'] });
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });
  const payouts = useMutation({
    mutationFn: runPayouts,
    onSuccess: (result) => {
      toast.success(
        t(k('finance.ledger.payoutsDone'), {
          paid: result.paid.length,
          failed: result.failed.length,
          skipped: result.skipped.length,
        }),
      );
      void queryClient.invalidateQueries({ queryKey: ['finance'] });
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t(k('finance.ledger.title'))}
        description={t(k('finance.ledger.intro'))}
        actions={
          mayWrite ? (
            <div className="flex gap-2">
              <Button
                onClick={() => {
                  refresh.mutate();
                }}
                isLoading={refresh.isPending}
              >
                {t(k('finance.ledger.refresh'))}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  payouts.mutate();
                }}
                isLoading={payouts.isPending}
              >
                {t(k('finance.ledger.runPayouts'))}
              </Button>
            </div>
          ) : undefined
        }
      />
      <div role="tablist" className="flex flex-wrap gap-2">
        {TABS.map((item) => (
          <button
            key={item}
            role="tab"
            type="button"
            aria-selected={tab === item}
            className={`rounded-md px-3 py-1.5 text-sm ${tab === item ? 'bg-brand text-on-brand' : 'bg-surface-muted text-ink'}`}
            onClick={() => {
              setTab(item);
            }}
          >
            {t(k(`finance.ledger.tab.${item}`))}
          </button>
        ))}
      </div>
      {tab === 'orders' && <OrdersTab />}
      {tab === 'holds' && <HoldsTab mayWrite={mayWrite} />}
      {tab === 'refunds' && <RefundsTab />}
      {tab === 'reconciliation' && <ReconciliationTab mayWrite={mayWrite} />}
    </div>
  );
}

function OrdersTab(): React.JSX.Element {
  const { t } = useI18n();
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['finance', 'ledger-orders', page], queryFn: () => fetchLedgerOrders(page) });
  const rows = query.data?.items ?? [];
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full">
        <thead>
          <tr>
            <th className={th}>{t(k('finance.ledger.order'))}</th>
            <th className={th}>{t(k('finance.ledger.gross'))}</th>
            <th className={th}>{t(k('finance.ledger.fee'))}</th>
            <th className={th}>{t(k('finance.ledger.feeTax'))}</th>
            <th className={th}>{t(k('finance.ledger.refunds'))}</th>
            <th className={th}>{t(k('finance.ledger.sellerShare'))}</th>
            <th className={th}>{t(k('finance.ledger.settlement'))}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {rows.length === 0 && (
            <tr>
              <td className={td} colSpan={7}>
                {query.isPending ? t(k('finance.loading')) : t(k('finance.ledger.empty'))}
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <Fragment key={row.orderId}>
              <tr>
                <td className={td}>
                  <button
                    type="button"
                    className="font-mono text-brand hover:underline"
                    aria-expanded={open === row.orderId}
                    onClick={() => {
                      setOpen(open === row.orderId ? null : row.orderId);
                    }}
                  >
                    {row.orderNumber ?? row.orderId}
                  </button>
                </td>
                <td className={td}>{formatMoney(money(row.grossMinor, row.currency))}</td>
                <td className={td}>{formatMoney(money(row.platformFeeMinor, row.currency))}</td>
                <td className={td}>{formatMoney(money(row.platformFeeTaxMinor, row.currency))}</td>
                <td className={td}>{formatMoney(money(row.refundsMinor, row.currency))}</td>
                <td className={td}>{formatMoney(money(row.sellerShareMinor, row.currency))}</td>
                <td className={td}>
                  <Badge tone={holdTone(row.settlement)}>{t(k(`finance.settlement.${row.settlement}`))}</Badge>
                </td>
              </tr>
              {open === row.orderId && (
                <tr>
                  <td colSpan={7} className="bg-surface-muted px-3 py-3">
                    <OrderDetail orderId={row.orderId} />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      <div className="flex justify-end gap-2 p-3">
        <Button
          size="sm"
          disabled={page === 1}
          onClick={() => {
            setPage(page - 1);
          }}
        >
          {t(k('finance.previous'))}
        </Button>
        <Button
          size="sm"
          disabled={(query.data?.total ?? 0) <= page * 25}
          onClick={() => {
            setPage(page + 1);
          }}
        >
          {t(k('finance.next'))}
        </Button>
      </div>
    </div>
  );
}

function OrderDetail({ orderId }: { orderId: string }): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: ['finance', 'order-ledger', orderId], queryFn: () => fetchOrderLedger(orderId) });
  const data = query.data;
  if (data === undefined) return <p className="text-sm text-ink-muted">{t(k('finance.loading'))}</p>;
  const summary = data.summary;
  // Where the buyer's money went, one line per destination. Each figure is the
  // sum of the journal below, never a second calculation.
  const movement: { key: string; minor: string }[] = [
    { key: 'gross', minor: summary.grossMinor },
    { key: 'orderTax', minor: summary.orderTaxMinor },
    { key: 'fee', minor: summary.platformFeeMinor },
    { key: 'feeTax', minor: summary.platformFeeTaxMinor },
    { key: 'logistics', minor: summary.logisticsMinor },
    { key: 'discountsFunded', minor: summary.discountsFundedMinor },
    { key: 'operatorSales', minor: summary.operatorSalesMinor },
    { key: 'sellerShare', minor: summary.sellerShareMinor },
    { key: 'refunds', minor: summary.refundsMinor },
    { key: 'released', minor: summary.releasedMinor },
    { key: 'held', minor: summary.heldMinor },
    { key: 'unallocated', minor: summary.unallocatedMinor },
  ];
  return (
    <div className="space-y-3 text-sm">
      <h3 className="font-medium text-ink">{t(k('finance.ledger.movement'))}</h3>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
        {movement.map((item) => (
          <div key={item.key} className="flex justify-between gap-3 border-b border-border-subtle py-1">
            <dt className="text-ink-muted">{t(k(`finance.ledger.movement.${item.key}`))}</dt>
            <dd className="tabular-nums text-ink">{formatMoney(money(item.minor, data.currency))}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-ink-muted">{t(k('finance.ledger.immutable'))}</p>
      <h3 className="font-medium text-ink">{t(k('finance.ledger.entries'))}</h3>
      <ul className="space-y-1">
        {data.entries.map((entry) => (
          <li key={entry.id} className="font-mono text-xs text-ink">
            {formatDate(entry.occurredAt)} · {entry.kind} · {entry.memo}
            {entry.providerReference !== null ? ` · ${entry.providerReference}` : ''}
            <span className="block ps-4 text-ink-muted">
              {entry.lines
                .map((line) => `${line.account} ${formatMoney(money(line.amountMinor, entry.currency))}`)
                .join('  |  ')}
            </span>
          </li>
        ))}
      </ul>
      {data.holds.length > 0 && (
        <>
          <h3 className="font-medium text-ink">{t(k('finance.ledger.tab.holds'))}</h3>
          <ul>
            {data.holds.map((hold) => (
              <li key={hold.id}>
                {hold.sellerName} · {hold.sellerOrderNumber} · <Badge tone={holdTone(hold.status)}>{hold.status}</Badge>
                {hold.payout !== null ? ` · ${hold.payout.reference} (${hold.payout.status})` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
      {(data.refunds.length > 0 || data.chargebacks.length > 0) && (
        <>
          <h3 className="font-medium text-ink">{t(k('finance.ledger.tab.refunds'))}</h3>
          <ul>
            {data.refunds.map((refund) => (
              <li key={refund.id}>
                {formatMoney(money(refund.amountMinor, refund.currency))} · {refund.status} ·{' '}
                {t(k(`finance.accounting.${refund.accounting}`))}
              </li>
            ))}
            {data.chargebacks.map((chargeback) => (
              <li key={chargeback.id}>
                {chargeback.reference} · {chargeback.status} · {t(k(`finance.accounting.${chargeback.accounting}`))}
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 className="font-medium text-ink">{t(k('finance.ledger.inspection'))}</h3>
      <p className="text-ink-muted">{t(k('finance.ledger.inspectionNone'))}</p>
      {data.inspection.invoices.length > 0 && (
        <ul>
          {data.inspection.invoices.map((invoice) => (
            <li key={invoice.id}>
              {invoice.invoiceNumber} · {formatMoney(money(invoice.amountMinor, invoice.currency))} ·{' '}
              {t(k(`finance.ledger.inspectionPayer.${invoice.payer}`))} · {invoice.status}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function HoldsTab({ mayWrite }: { mayWrite: boolean }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const { user } = useSession();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const query = useQuery({ queryKey: ['finance', 'holds', status], queryFn: () => fetchHolds(status) });
  const act = useMutation({
    mutationFn: async (input: { hold: FundHold; action: 'suspend' | 'resume' | 'release' | 'approve' | 'reject' }) => {
      const { hold, action } = input;
      if (action === 'resume') return resumeHold(hold.id);
      if (action === 'approve' || action === 'reject') return decideRelease(hold.pendingRelease?.id ?? '', action === 'approve');
      const reason = window.prompt(t(k('finance.holds.reasonPrompt'))) ?? '';
      if (reason.trim().length < 5) return undefined;
      if (action === 'suspend') return suspendHold(hold.id, reason);
      await requestRelease(hold.id, reason);
      return undefined;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['finance'] });
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-ink">
        {t(k('finance.holds.filter'))}
        <select
          className="rounded-md border border-border bg-surface px-2 py-1"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
          }}
        >
          <option value="">{t(k('finance.holds.all'))}</option>
          <option value="HELD">{t(k('finance.funds.held'))}</option>
          <option value="ON_HOLD">{t(k('finance.funds.onHold'))}</option>
          <option value="RELEASED">{t(k('finance.funds.released'))}</option>
        </select>
      </label>
      <ul className="divide-y divide-border-subtle rounded-lg border border-border bg-surface">
        {(query.data?.items ?? []).map((hold) => (
          <li key={hold.id} className="space-y-1 px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-ink">
                {hold.sellerName} · <span className="font-mono">{hold.sellerOrderNumber}</span> ·{' '}
                {formatMoney(money(hold.allocatedMinor, hold.currency))}
              </span>
              <Badge tone={holdTone(hold.status)}>{t(k(`finance.funds.${hold.status === 'ON_HOLD' ? 'onHold' : hold.status === 'HELD' ? 'held' : 'released'}`))}</Badge>
            </div>
            <p className="text-xs text-ink-muted">
              {hold.conditions.map((c) => `${c.met ? '✓' : '○'} ${t(k(`finance.condition.${c.key}`))}`).join('   ')}
            </p>
            {hold.holdReason !== null && <p className="text-xs text-warning">{hold.holdReason}</p>}
            {hold.pendingRelease != null && (
              <p className="text-xs text-ink">
                {t(k('finance.holds.pendingRelease'), { who: hold.pendingRelease.requestedByLabel, reason: hold.pendingRelease.reason })}
              </p>
            )}
            {mayWrite && hold.status !== 'RELEASED' && (
              <div className="flex flex-wrap gap-2 pt-1">
                {hold.status === 'HELD' && (
                  <Button size="sm" onClick={() => { act.mutate({ hold, action: 'suspend' }); }}>
                    {t(k('finance.holds.suspend'))}
                  </Button>
                )}
                {hold.holdCode === 'MANUAL' && (
                  <Button size="sm" onClick={() => { act.mutate({ hold, action: 'resume' }); }}>
                    {t(k('finance.holds.resume'))}
                  </Button>
                )}
                {hold.pendingRelease == null && hold.holdCode !== 'DISPUTE' && (
                  <Button size="sm" onClick={() => { act.mutate({ hold, action: 'release' }); }}>
                    {t(k('finance.holds.requestRelease'))}
                  </Button>
                )}
                {hold.pendingRelease != null && hold.pendingRelease.requestedById !== user?.id && (
                  <>
                    <Button size="sm" variant="primary" onClick={() => { act.mutate({ hold, action: 'approve' }); }}>
                      {t(k('finance.holds.approve'))}
                    </Button>
                    <Button size="sm" onClick={() => { act.mutate({ hold, action: 'reject' }); }}>
                      {t(k('finance.holds.reject'))}
                    </Button>
                  </>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function RefundsTab(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: ['finance', 'refunds-chargebacks'], queryFn: fetchRefundsChargebacks });
  const data = query.data;
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-title-sm text-ink">{t(k('finance.refunds.title'))}</h2>
        <ul className="mt-2 divide-y divide-border-subtle text-sm">
          {(data?.refunds ?? []).map((refund) => (
            <li key={refund.id} className="py-2">
              <span className="font-mono">{refund.orderNumber}</span> · {formatMoney(money(refund.amountMinor, refund.currency))} ·{' '}
              {refund.status} · <Badge tone={refund.accounting === 'NOT_POSTED' ? 'warning' : 'neutral'}>{t(k(`finance.accounting.${refund.accounting}`))}</Badge>
            </li>
          ))}
        </ul>
      </section>
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="text-title-sm text-ink">{t(k('finance.chargebacks.title'))}</h2>
        <ul className="mt-2 divide-y divide-border-subtle text-sm">
          {(data?.chargebacks ?? []).map((chargeback) => (
            <li key={chargeback.id} className="py-2">
              <span className="font-mono">{chargeback.reference}</span> ·{' '}
              {formatMoney(money(chargeback.disputedAmountMinor, chargeback.currency))} · {chargeback.status}
              {chargeback.evidenceDueAt !== null ? ` · ${t(k('finance.chargebacks.evidenceDue'), { date: formatDate(chargeback.evidenceDueAt) })}` : ''} ·{' '}
              <Badge tone={chargeback.accounting === 'LOSS_NOT_POSTED' ? 'warning' : 'neutral'}>{t(k(`finance.accounting.${chargeback.accounting}`))}</Badge>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function ReconciliationTab({ mayWrite }: { mayWrite: boolean }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['finance', 'reconciliations'], queryFn: fetchReconciliations });
  const [result, setResult] = useState<Awaited<ReturnType<typeof runReconciliation>> | null>(null);
  const run = useMutation({
    mutationFn: () => {
      const end = new Date();
      const start = new Date(end.getTime() - 30 * 86_400_000);
      return runReconciliation(start.toISOString(), end.toISOString());
    },
    onSuccess: (data) => {
      setResult(data);
      void queryClient.invalidateQueries({ queryKey: ['finance', 'reconciliations'] });
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });
  return (
    <div className="space-y-4">
      {mayWrite && (
        <Button variant="primary" isLoading={run.isPending} onClick={() => { run.mutate(); }}>
          {t(k('finance.reconcile.run'))}
        </Button>
      )}
      {result !== null && (
        <section className="rounded-lg border border-border bg-surface p-4 text-sm">
          <p className="text-ink">{t(k('finance.reconcile.result'), { matched: result.matchedCount, mismatched: result.mismatchCount })}</p>
          <ul className="mt-2 space-y-1 text-xs">
            {(result.items ?? []).map((item) => (
              <li key={item.id}>
                <Badge tone="warning">{item.kind}</Badge> {item.providerReference ?? ''} · {item.note}
              </li>
            ))}
          </ul>
        </section>
      )}
      <ul className="divide-y divide-border-subtle rounded-lg border border-border bg-surface text-sm">
        {(query.data?.runs ?? []).map((runRow) => (
          <li key={runRow.id} className="px-4 py-2">
            {formatDate(runRow.startedAt)} · {runRow.provider} · {runRow.status} ·{' '}
            {t(k('finance.reconcile.result'), { matched: runRow.matchedCount, mismatched: runRow.mismatchCount })}
          </li>
        ))}
      </ul>
    </div>
  );
}
