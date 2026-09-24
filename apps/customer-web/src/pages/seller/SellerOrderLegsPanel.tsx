/**
 * The four legs of this confirmed order, one after another.
 *
 * The seller names the carrier for the legs they manage, types in the
 * carrier's own tracking reference, and records the start and the handover.
 * The legs UBOSS manages are shown read-only, with who UBOSS chose and where
 * the leg has got to - the seller can follow every leg of their own order, and
 * change only their own.
 *
 * A carrier booked by hand is exactly that: nothing here books DHL, prints a
 * label, invents a tracking number or names a driver.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, ErrorState, Input, LoadingState, Select } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatMoney } from '@/lib/format';
import {
  assignLeg,
  fetchLegs,
  fetchLogisticsPartners,
  fetchPolicy,
  legsKey,
  moveLeg,
  policyKey,
  updateLegReferences,
  type LegStatus,
  type LegView,
  type ManagedProvider,
} from '@/lib/seller-logistics';

const STATUS_TONE: Record<LegStatus, BadgeTone> = {
  PENDING: 'neutral',
  AWAITING_ASSIGNMENT: 'warning',
  ASSIGNED: 'brand',
  ACCEPTED: 'brand',
  IN_PROGRESS: 'operational',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
};

export function SellerOrderLegsPanel({ sellerOrderId, canAct }: { sellerOrderId: string; canAct: boolean }): React.JSX.Element | null {
  const { t } = useI18n();
  const query = useQuery({ queryKey: legsKey(sellerOrderId), queryFn: () => fetchLegs(sellerOrderId) });

  if (query.isPending) {
    return (
      <Card title={t('sellerLegs.title')}>
        <div className="px-6 pb-6">
          <LoadingState label={t('sellerLogistics.loading')} />
        </div>
      </Card>
    );
  }
  if (query.isError) {
    return (
      <Card title={t('sellerLegs.title')}>
        <div className="px-6 pb-6">
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        </div>
      </Card>
    );
  }
  // An order not priced on four levels has no legs, and no panel.
  if (query.data.legs.length === 0) return null;

  return (
    <Card title={t('sellerLegs.title')} description={t('sellerLegs.body')}>
      <ol className="space-y-3 px-6 pb-6">
        {query.data.legs.map((leg) => (
          <li key={leg.id}>
            <LegRow sellerOrderId={sellerOrderId} leg={leg} canAct={canAct} />
          </li>
        ))}
      </ol>
    </Card>
  );
}

function LegRow({ sellerOrderId, leg, canAct }: { sellerOrderId: string; leg: LegView; canAct: boolean }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const mine = leg.owner === 'SELLER';
  const [carrier, setCarrier] = useState<string>(leg.provider ?? (leg.logisticsPartnerId === null ? '' : `partner:${leg.logisticsPartnerId}`));
  const [tracking, setTracking] = useState(leg.trackingNumber ?? '');

  const policy = useQuery({ queryKey: policyKey, queryFn: fetchPolicy, enabled: mine && canAct });
  const partners = useQuery({ queryKey: ['seller', 'logistics', 'partners'], queryFn: fetchLogisticsPartners, enabled: mine && canAct });

  function done(message: string, legs: LegView[]): void {
    toast.success(message);
    client.setQueryData(legsKey(sellerOrderId), { legs });
  }

  const assign = useMutation({
    mutationFn: () => {
      const partnerId = carrier.startsWith('partner:') ? carrier.slice('partner:'.length) : null;
      return assignLeg(sellerOrderId, leg.level, {
        provider: partnerId === null ? (carrier as ManagedProvider) : null,
        logisticsPartnerId: partnerId,
        ...(tracking.trim() === '' ? {} : { trackingNumber: tracking.trim() }),
        ...(leg.carrier === null ? {} : { reason: t('sellerLegs.changedBySeller') }),
        expectedVersion: leg.version,
      });
    },
    onSuccess: (result) => {
      done(t('sellerLegs.assigned'), result.legs);
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerLegs.failed')));
    },
  });

  const references = useMutation({
    mutationFn: () => updateLegReferences(sellerOrderId, leg.level, { trackingNumber: tracking.trim() === '' ? null : tracking.trim() }),
    onSuccess: (result) => {
      done(t('sellerLegs.trackingSaved'), result.legs);
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerLegs.failed')));
    },
  });

  const move = useMutation({
    mutationFn: (to: 'IN_PROGRESS' | 'COMPLETED') =>
      moveLeg(sellerOrderId, leg.level, { to, idempotencyKey: `${leg.id}:${to}:${String(leg.version)}` }),
    onSuccess: (result, to) => {
      done(t(to === 'IN_PROGRESS' ? 'sellerLegs.started' : 'sellerLegs.handedOver'), result.legs);
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerLegs.failed')));
    },
  });

  const enabled = (policy.data?.policy.providers ?? []).filter((provider) => provider.enabled);
  const assignable = mine && canAct && ['PENDING', 'AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTED'].includes(leg.status);
  const handBooked = leg.provider !== null;

  return (
    <article className={cx('rounded-lg border p-4', mine ? 'border-border bg-surface' : 'border-dashed border-border-strong bg-surface-sunken')}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-ink">
            {leg.level} · {t(`sellerLogistics.level.${leg.level}.name`)}
          </p>
          <p className="text-xs text-ink-muted">
            {leg.origin ?? '—'} → {leg.destination ?? '—'}
            {leg.transportMode === null ? '' : ` · ${t(`sellerLogistics.transport.${leg.transportMode}`)}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge tone={mine ? 'brand' : 'operational'}>{mine ? t('sellerLogistics.sellerManaged') : t('sellerLogistics.ubossManaged')}</Badge>
          <Badge tone={STATUS_TONE[leg.status]}>{t(`sellerLegs.status.${leg.status}`)}</Badge>
        </div>
      </header>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-ink-muted">{t('sellerLegs.carrier')}</dt>
          <dd className="text-ink">{leg.carrier ?? t('sellerLegs.noCarrier')}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="text-ink-muted">{t('sellerLegs.tracking')}</dt>
          <dd className="text-ink">{leg.trackingNumber ?? '—'}</dd>
        </div>
        {leg.charge !== null && (
          <div className="flex gap-2">
            <dt className="text-ink-muted">{t('sellerLegs.charged')}</dt>
            <dd className="text-ink">{leg.charge.isFree ? t('sellerLogistics.free') : formatMoney(leg.charge.amount)}</dd>
          </div>
        )}
        {leg.completedAt !== null && (
          <div className="flex gap-2">
            <dt className="text-ink-muted">{t('sellerLegs.handedOverAt')}</dt>
            <dd className="text-ink">{formatDateTime(leg.completedAt)}</dd>
          </div>
        )}
      </dl>

      {!mine && <p className="mt-2 text-xs text-ink-muted">{t('sellerLegs.ubossReadOnly')}</p>}

      {assignable && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="flex-1 text-xs font-medium text-ink">
            {t('sellerLegs.chooseCarrier')}
            <Select
              className="mt-1"
              value={carrier}
              onChange={(event) => {
                setCarrier(event.target.value);
              }}
            >
              <option value="">{t('sellerLogistics.chooseCarrier')}</option>
              {enabled.map((provider) => (
                <option key={provider.provider} value={provider.provider}>
                  {t(`sellerLogistics.provider.${provider.provider}.name`)} · {t(`sellerLogistics.connection.${provider.connectionState}`)}
                </option>
              ))}
              {(partners.data?.partners ?? []).map((partner) => (
                <option key={partner.id} value={`partner:${partner.id}`}>
                  {partner.displayName}
                </option>
              ))}
            </Select>
          </label>
          <Button
            size="sm"
            variant="primary"
            disabled={carrier === '' || assign.isPending}
            isLoading={assign.isPending}
            onClick={() => {
              assign.mutate();
            }}
          >
            {leg.carrier === null ? t('sellerLegs.assign') : t('sellerLegs.reassign')}
          </Button>
        </div>
      )}

      {mine && canAct && handBooked && leg.status !== 'COMPLETED' && leg.status !== 'CANCELLED' && (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <label className="flex-1 text-xs font-medium text-ink">
            {t('sellerLegs.trackingLabel')}
            <Input
              className="mt-1"
              value={tracking}
              maxLength={64}
              onChange={(event) => {
                setTracking(event.target.value);
              }}
            />
          </label>
          <Button
            size="sm"
            variant="secondary"
            disabled={tracking.trim() === '' || references.isPending}
            onClick={() => {
              references.mutate();
            }}
          >
            {t('sellerLegs.saveTracking')}
          </Button>
        </div>
      )}

      {mine && canAct && handBooked && (
        <div className="mt-3 flex flex-wrap gap-2">
          {(leg.status === 'ASSIGNED' || leg.status === 'ACCEPTED') && (
            <Button
              size="sm"
              variant="secondary"
              isLoading={move.isPending}
              onClick={() => {
                move.mutate('IN_PROGRESS');
              }}
            >
              {t('sellerLegs.start')}
            </Button>
          )}
          {leg.status === 'IN_PROGRESS' && (
            <Button
              size="sm"
              variant="primary"
              isLoading={move.isPending}
              onClick={() => {
                move.mutate('COMPLETED');
              }}
            >
              {leg.level === 'L4' ? t('sellerLegs.delivered') : t('sellerLegs.handOver')}
            </Button>
          )}
        </div>
      )}

      {leg.status === 'PENDING' && <p className="mt-2 text-xs text-ink-muted">{t('sellerLegs.waitsForPrevious')}</p>}
    </article>
  );
}
