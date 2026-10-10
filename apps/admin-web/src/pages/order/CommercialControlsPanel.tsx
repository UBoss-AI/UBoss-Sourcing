/**
 * The order's frozen commercial terms and its refund states (Doc 07 / Doc 08).
 *
 * Each line carries the snapshot taken when the order was placed: seller,
 * manufacturer, approved version and site, delivery term and importer, the
 * commission and the policy versions it was priced under. Refunds show what
 * the payment provider has actually confirmed; a refund still at the provider
 * is never called complete, and bank-credit timing is not promised.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Callout, Card, DescriptionList, LoadingState, type BadgeTone } from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import { bpsToPercent, commercialApi, type LineSnapshot, type RefundState } from '@/lib/commercial-policy';
import { formatDate } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { codeLabel, money } from '@/pages/commercial/format';
import { CodeList, JsonBlock } from '@/pages/commercial/shared';

const REFUND_TONE: Record<RefundState, BadgeTone> = { REQUESTED: 'neutral', SUBMITTED: 'warning', PENDING_PROVIDER: 'warning', SUCCEEDED: 'success', FAILED: 'danger', CANCELLED: 'neutral' };

function gapsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function LineCard({ line }: { line: LineSnapshot }): React.JSX.Element {
  const { t } = useI18n();
  const gaps = gapsOf(line.controlGapsJson);
  return (
    <div className="rounded-md border border-border p-3">
      <DescriptionList
        columns={2}
        items={[
          { label: t('commercial.order.seller'), value: <span className="font-mono text-xxs">{line.sellerAccountId ?? '—'}</span> },
          { label: t('commercial.order.manufacturer'), value: line.manufacturerName ?? '—' },
          { label: t('commercial.order.versionSite'), value: `${line.productVersion ?? '—'} · ${line.facilityRef ?? '—'}` },
          { label: t('commercial.order.countries'), value: `${line.sellerCountry ?? '—'} → ${line.destinationCountry}` },
          { label: t('commercial.channel'), value: line.channel },
          { label: t('commercial.order.deliveryTerm'), value: `${line.deliveryTerm}${line.namedPlace ? ` · ${line.namedPlace}` : ''}` },
          { label: t('commercial.ops.importer'), value: codeLabel(t, line.importerOfRecord) },
          { label: t('commercial.order.commission'), value: `${bpsToPercent(line.commissionBps)} × ${money(line.commissionBaseMinor, line.currency)} = ${money(line.commissionMinor, line.currency)}` },
          { label: t('commercial.source'), value: `${codeLabel(t, line.commissionSource)}${line.commissionRuleVersion ? ` · ${line.commissionRuleVersion}` : ''}` },
          { label: t('commercial.order.rounding'), value: codeLabel(t, line.rounding) },
        ]}
      />
      <div className="mt-3">
        <p className="text-xs font-medium text-ink">{t('commercial.gaps')}</p>
        <CodeList codes={gaps} empty={t('commercial.noGaps')} />
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-xs font-medium text-accent">{t('commercial.order.policyVersions')}</summary>
        <JsonBlock value={line.policyVersionsJson} />
      </details>
    </div>
  );
}

/** Acceptance and dispatch controls for one seller order, loaded on demand. */
function SellerOrderControls({ groupId }: { groupId: string }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const controls = useQuery({ queryKey: ['commercial', 'group', groupId], queryFn: () => commercialApi.groupControls(groupId), enabled: can(Permission.ORDER_READ) });
  const dispatch = useQuery({ queryKey: ['commercial', 'dispatch', groupId], queryFn: () => commercialApi.dispatchControls(groupId), enabled: can(Permission.LOGISTICS_READ) });
  const acceptanceGaps = [...new Set((controls.data?.lines ?? []).flatMap((l) => gapsOf(l.controlGapsJson)))];
  const d = dispatch.data;
  return (
    <div className="space-y-3 text-sm">
      {(controls.isLoading || dispatch.isLoading) && <LoadingState />}
      {controls.data !== undefined && (
        <div>
          <p className="text-xs font-medium text-ink">{t('commercial.order.acceptanceGaps')}</p>
          <CodeList codes={acceptanceGaps} empty={t('commercial.noGaps')} />
        </div>
      )}
      {d !== undefined && (
        <>
          <div>
            <p className="text-xs font-medium text-ink">{t('commercial.order.dispatchGaps')}</p>
            <CodeList codes={d.gaps} empty={t('commercial.noGaps')} />
          </div>
          <DescriptionList
            columns={2}
            items={[
              { label: t('commercial.order.booking'), value: d.booking === null ? t('commercial.order.noBooking') : `${d.booking.lane} · ${codeLabel(t, d.booking.status)}` },
              { label: t('commercial.order.quotes'), value: d.quotes.length === 0 ? '—' : d.quotes.map((q) => `${q.providerName}: ${money(q.amountMinor, q.currency)}`).join('; ') },
              { label: t('commercial.order.evidence'), value: d.evidence === null ? t('commercial.order.noEvidence') : t('commercial.order.evidenceRecorded') },
              { label: t('commercial.order.custody'), value: d.custody.length === 0 ? '—' : d.custody.map((c) => `${c.fromParty} → ${c.toParty} (${formatDate(c.handedOverAt)})`).join('; ') },
              { label: t('commercial.order.partials'), value: d.partials.length === 0 ? '—' : d.partials.map((p) => `${p.orderApprovalRef}: ${money(p.billedMinor, p.currency)}`).join('; ') },
            ]}
          />
        </>
      )}
    </div>
  );
}

export function CommercialControlsPanel({ orderId }: { orderId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['order', orderId, 'commercial-controls'], queryFn: () => commercialApi.orderControls(orderId) });
  if (query.isLoading || query.error !== null || query.data === undefined) return null;
  const { lines, refunds } = query.data;
  const groups = [...new Set(lines.map((l) => l.sellerOrderGroupId).filter((g): g is string => g !== null))];
  return (
    <>
      {lines.length > 0 && (
        <Card title={t('commercial.order.termsTitle')} description={t('commercial.order.termsBody')} bodyClassName="space-y-3 px-5 py-4">
          {lines.map((line) => (
            <LineCard key={line.id} line={line} />
          ))}
          {groups.map((groupId) => (
            <div key={groupId} className="rounded-md border border-border p-3">
              <Button size="sm" variant="ghost" aria-expanded={openGroup === groupId} onClick={() => { setOpenGroup(openGroup === groupId ? null : groupId); }}>
                {t('commercial.order.sellerOrderControls', { id: groupId.slice(-8) })}
              </Button>
              {openGroup === groupId && <div className="mt-3"><SellerOrderControls groupId={groupId} /></div>}
            </div>
          ))}
        </Card>
      )}
      {refunds.length > 0 && (
        <Card title={t('commercial.refund.title')} bodyClassName="space-y-3 px-5 py-4">
          <ul className="space-y-2 text-sm">
            {refunds.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-ink">
                  {money(r.amountMinor, r.currency)} · {t('commercial.refund.instructed', { date: formatDate(r.instructedAt) })}
                  {r.providerConfirmedAt !== null && ` · ${t('commercial.refund.confirmedOn', { date: formatDate(r.providerConfirmedAt) })}`}
                </span>
                <Badge tone={REFUND_TONE[r.state]}>{t(`commercial.refund.state.${r.state}`)}</Badge>
              </li>
            ))}
          </ul>
          <Callout tone="info">{t('commercial.refund.timingNote')}</Callout>
        </Card>
      )}
    </>
  );
}
