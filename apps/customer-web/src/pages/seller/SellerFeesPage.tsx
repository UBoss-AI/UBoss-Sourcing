/**
 * /seller/fees - what the marketplace's commercial schedules mean for this
 * seller (Doc 08), read only: commission reversed after refunds on its
 * orders, the security schedules it is under with their reviews, and any
 * certification-recovery programme. Changes are made by the operator's
 * finance team; this page shows where things stand.
 */
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { useI18n, type Translate, type TranslationKey } from '@/i18n/i18n-context';
import { bpsToPercent, commercialKeys, fetchSellerFees } from '@/lib/commercial-policy';
import { formatDate, formatDateTime, formatMoneyMinor, humanise } from '@/lib/format';

const statusLabel = (t: Translate, status: string): string =>
  t(`commercial.fees.status.${status}` as TranslationKey, { defaultValue: humanise(status) });

function Table({ head, children }: { head: string[]; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-ink-muted">
          <tr>
            {head.map((label) => (
              <th key={label} scope="col" className="px-6 py-2 font-medium">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

export function SellerFeesPage(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: commercialKeys.sellerFees, queryFn: fetchSellerFees });
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} />;
  const { adjustments, schedules, reviews, programmes } = query.data;
  const cell = 'px-6 py-2';
  return (
    <div className="space-y-6">
      <PageHeader title={t('commercial.fees.title')} description={t('commercial.fees.description')} />

      <Card title={t('commercial.fees.reversalsTitle')} description={t('commercial.fees.reversalsHint')}>
        {adjustments.length === 0 ? (
          <div className="px-6 py-5"><EmptyState title={t('commercial.fees.reversalsNone')} /></div>
        ) : (
          <Table head={[t('commercial.fees.created'), t('commercial.fees.refunded'), t('commercial.fees.reversed'), t('commercial.fees.statusLabel')]}>
            {adjustments.map((a) => (
              <tr key={a.id}>
                <td className={cell}>{formatDate(a.createdAt)}</td>
                <td className={cell}>{formatMoneyMinor(a.refundedGoodsMinor, a.currency)}</td>
                <td className={cell}>{formatMoneyMinor(a.reversedMinor, a.currency)}</td>
                <td className={cell}><Badge tone={a.status === 'APPLIED' ? 'success' : 'neutral'}>{statusLabel(t, a.status)}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title={t('commercial.fees.securityTitle')} description={t('commercial.fees.securityHint')}>
        {schedules.length === 0 ? (
          <div className="px-6 py-5"><EmptyState title={t('commercial.fees.securityNone')} /></div>
        ) : (
          <ul className="divide-y divide-border">
            {schedules.map((s) => {
              const own = reviews.filter((r) => r.scheduleId === s.id);
              return (
                <li key={s.id} className="space-y-2 px-6 py-4 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink">{t(`commercial.fees.form.${s.form}` as TranslationKey, { defaultValue: humanise(s.form) })}</span>
                    <Badge tone={s.status === 'ACTIVE' ? 'brand' : 'neutral'}>{statusLabel(t, s.status)}</Badge>
                  </div>
                  <p className="text-ink-muted">
                    {t('commercial.fees.securityTerms', {
                      rate: bpsToPercent(s.reserveBps),
                      days: String(s.holdDays),
                      cap: s.capMinor === null ? '—' : formatMoneyMinor(s.capMinor, s.currency),
                    })}
                  </p>
                  {(s.guaranteeMinor !== '0' || s.depositMinor !== '0') && (
                    <p className="text-ink-muted">
                      {t('commercial.fees.guaranteeDeposit', { guarantee: formatMoneyMinor(s.guaranteeMinor, s.currency), deposit: formatMoneyMinor(s.depositMinor, s.currency) })}
                    </p>
                  )}
                  {s.nextMonthlyReviewAt !== null && <p className="text-ink-muted">{t('commercial.fees.nextReview', { when: formatDate(s.nextMonthlyReviewAt) })}</p>}
                  {own.length > 0 && (
                    <ul className="mt-1 space-y-1">
                      {own.map((r) => (
                        <li key={r.id} className="rounded-md border border-border px-3 py-2">
                          {r.periodKey} · {statusLabel(t, r.outcome)}
                          {r.excessMinor !== null && r.excessMinor !== '0' && ` · ${t('commercial.fees.excess', { amount: formatMoneyMinor(r.excessMinor, s.currency) })}`}
                          <span className="text-ink-muted"> · {r.reviewedAt === null ? t('commercial.fees.reviewDue', { when: formatDate(r.dueAt) }) : formatDateTime(r.reviewedAt)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title={t('commercial.fees.programmesTitle')} description={t('commercial.fees.programmesHint')}>
        {programmes.length === 0 ? (
          <div className="px-6 py-5"><EmptyState title={t('commercial.fees.programmesNone')} /></div>
        ) : (
          <Table head={[t('commercial.fees.programme'), t('commercial.fees.period'), t('commercial.fees.cap'), t('commercial.fees.eligible'), t('commercial.fees.unrecovered'), t('commercial.fees.statusLabel')]}>
            {programmes.map((p) => (
              <tr key={p.id}>
                <td className={cell}>{p.reference} · {p.title}</td>
                <td className={cell}>{formatDate(p.periodStart)} – {formatDate(p.periodEnd)}</td>
                <td className={cell}>{bpsToPercent(p.capBps)}</td>
                <td className={cell}>{formatMoneyMinor(p.eligibleCostMinor, p.currency)}</td>
                <td className={cell}>{formatMoneyMinor(p.unrecoveredMinor, p.currency)}</td>
                <td className={cell}><Badge>{statusLabel(t, p.status)}</Badge></td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
