/**
 * Destination documentation readiness of each seller order on this order
 * (JOURNEY-049): the trade rules that apply, what holds the goods before
 * dispatch and who must act, and the staff override.
 *
 * An override lets the goods leave despite the holds open now, with a written
 * reason. It is audited, the seller is told, and a new cause holds the goods
 * again. The server enforces the hold; this panel only shows and records.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, Field, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

type HoldCode = 'PROHIBITED' | 'DOCUMENT_MISSING' | 'DOCUMENT_NOT_VALID' | 'HS_UNVERIFIED' | 'HS_REJECTED';
type Party = 'SELLER' | 'BUYER' | 'FORWARDER' | 'OPERATOR';

export interface SellerOrderCompliance {
  sellerOrderGroupId: string;
  sellerOrderNumber: string;
  sellerName: string;
  status: string;
  verdict: {
    destination: string;
    items: {
      ruleId: string;
      ruleName: string;
      restriction: 'NONE' | 'RESTRICTED' | 'PROHIBITED';
      responsibleParty: Party;
      documentName: string | null;
      status: string;
    }[];
    holds: { key: string; code: HoldCode; ruleName: string; responsibleParty: Party; sku: string | null; covered: boolean }[];
    open: boolean;
    overridden: boolean;
  };
  override: { reason: string; grantedByLabel: string; grantedAt: string; revokedAt: string | null } | null;
}

export function CompliancePanel({ orderId }: { orderId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['order', orderId, 'compliance'],
    queryFn: () => api.get<{ sellerOrders: SellerOrderCompliance[] }>(`/admin/orders/${orderId}/compliance`),
  });
  const rows = (query.data?.sellerOrders ?? []).filter((row) => row.verdict.items.length > 0);
  if (rows.length === 0) return null;

  return (
    <Card title={t('orderCompliance.title')} description={t('orderCompliance.description')} bodyClassName="space-y-4 px-5 py-4">
      {rows.map((row) => (
        <SellerOrderRow key={row.sellerOrderGroupId} orderId={orderId} row={row} />
      ))}
    </Card>
  );
}

function SellerOrderRow({ orderId, row }: { orderId: string; row: SellerOrderCompliance }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const { can } = useSession();
  const canOverride = can(Permission.LOGISTICS_WRITE);
  const [reason, setReason] = useState('');
  const open = row.verdict.holds.filter((hold) => !hold.covered);
  const activeOverride = row.override !== null && row.override.revokedAt === null ? row.override : null;

  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['order', orderId, 'compliance'] });
  };
  const grant = useMutation({
    mutationFn: () => api.post(`/admin/seller-orders/${row.sellerOrderGroupId}/compliance-override`, { reason: reason.trim() }),
    onSuccess: async () => {
      setReason('');
      toast.success(t('orderCompliance.overridden'));
      await refresh();
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });
  const revoke = useMutation({
    mutationFn: () => api.delete(`/admin/seller-orders/${row.sellerOrderGroupId}/compliance-override`),
    onSuccess: async () => {
      toast.success(t('orderCompliance.revoked'));
      await refresh();
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  return (
    <section className="space-y-2 border-b border-line pb-4 last:border-b-0 last:pb-0" data-testid={`compliance-${row.sellerOrderNumber}`}>
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
        <span>{row.sellerOrderNumber}</span>
        <span className="text-ink-muted">{row.sellerName}</span>
        <Badge tone={row.verdict.open ? (row.verdict.overridden ? 'warning' : 'success') : 'danger'}>
          {row.verdict.open
            ? row.verdict.overridden
              ? t('orderCompliance.stateOverridden')
              : t('orderCompliance.stateReady')
            : t('orderCompliance.stateHeld')}
        </Badge>
      </p>
      <ul className="space-y-1 text-sm">
        {row.verdict.items.map((item) => (
          <li key={item.ruleId} className="flex flex-wrap items-center gap-2">
            <span className="text-ink">{item.documentName ?? item.ruleName}</span>
            <Badge tone="neutral">{t(`orderCompliance.party.${item.responsibleParty}`)}</Badge>
            {item.restriction !== 'NONE' && (
              <Badge tone={item.restriction === 'PROHIBITED' ? 'danger' : 'warning'}>
                {t(`orderCompliance.restriction.${item.restriction}`)}
              </Badge>
            )}
          </li>
        ))}
      </ul>
      {open.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-sm text-danger" aria-label={t('orderCompliance.holds')}>
          {open.map((hold) => (
            <li key={hold.key}>
              {t(`orderCompliance.hold.${hold.code}`, { rule: hold.ruleName, sku: hold.sku ?? '' })}
            </li>
          ))}
        </ul>
      )}
      {activeOverride !== null && (
        <p className="text-xs text-ink-muted">
          {t('orderCompliance.overrideBy', {
            who: activeOverride.grantedByLabel,
            when: formatDateTime(activeOverride.grantedAt),
            reason: activeOverride.reason,
          })}
        </p>
      )}
      {canOverride && open.length > 0 && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            grant.mutate();
          }}
        >
          <Field label={t('orderCompliance.reason')} hint={t('orderCompliance.reasonHint')} required>
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                rows={2}
                maxLength={1000}
                value={reason}
                required
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            )}
          </Field>
          <Button type="submit" size="sm" variant="danger" disabled={grant.isPending || reason.trim().length < 10}>
            {t('orderCompliance.override')}
          </Button>
        </form>
      )}
      {canOverride && activeOverride !== null && (
        <Button
          size="sm"
          variant="secondary"
          disabled={revoke.isPending}
          onClick={() => {
            revoke.mutate();
          }}
        >
          {t('orderCompliance.revoke')}
        </Button>
      )}
    </section>
  );
}
