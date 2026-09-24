/**
 * The delivery legs of confirmed seller orders - L1 to L4 - across every seller.
 *
 * The desk works the UBOSS-controlled legs: naming the carrier, entering the
 * carrier's own tracking reference for a hand booking, and recording the start
 * and the handover. Seller-controlled legs are shown so the whole journey can
 * be followed, and are read-only here - the server refuses a UBOSS change to
 * one, whatever this page draws.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, ErrorState, Field, Input, LoadingState, PageHeader, Select, Toolbar, ToolbarField, ToolbarToggle } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatMoney } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import {
  assignUbossLeg,
  fetchLeg,
  fetchLegs,
  moveUbossLeg,
  updateUbossLegReferences,
  type ControlOwner,
  type LegStatus,
  type LegView,
} from '@/lib/logistics-levels';

const STATUSES: readonly LegStatus[] = ['PENDING', 'AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

const LEG_TONE: Record<LegStatus, BadgeTone> = {
  PENDING: 'neutral',
  AWAITING_ASSIGNMENT: 'warning',
  ASSIGNED: 'brand',
  ACCEPTED: 'brand',
  IN_PROGRESS: 'operational',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
};

export function LegsPage(): React.JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [owner, setOwner] = useState<ControlOwner | ''>('UBOSS');
  const [status, setStatus] = useState<LegStatus | ''>('');
  const [needsAssignment, setNeedsAssignment] = useState(false);

  const query = useQuery({
    queryKey: ['admin', 'legs', owner, status, needsAssignment],
    queryFn: () => fetchLegs({ owner, status, needsAssignment }),
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
  });

  const columns: Column<LegView>[] = [
    {
      key: 'level',
      header: t('legs.column.level'),
      render: (row) => (
        <div>
          <p className="font-medium text-ink">
            {row.level} · {t(`levels.level.${row.level}`)}
          </p>
          <p className="text-xxs text-ink-subtle">
            {row.origin ?? '—'} → {row.destination ?? '—'}
          </p>
        </div>
      ),
    },
    {
      key: 'order',
      header: t('legs.column.order'),
      render: (row) => (
        <div>
          <p className="text-sm text-ink">{row.orderNumber}</p>
          <p className="text-xxs text-ink-subtle">
            {row.sellerName} · {row.sellerOrderNumber}
          </p>
        </div>
      ),
    },
    {
      key: 'owner',
      header: t('legs.column.owner'),
      align: 'center',
      render: (row) => <Badge tone={row.owner === 'UBOSS' ? 'brand' : 'success'}>{row.owner === 'UBOSS' ? 'UBOSS' : t('levels.seller')}</Badge>,
    },
    {
      key: 'carrier',
      header: t('legs.column.carrier'),
      render: (row) => <span className="text-sm text-ink">{row.carrier ?? t('legs.noCarrier')}</span>,
    },
    {
      key: 'status',
      header: t('legs.column.status'),
      align: 'center',
      render: (row) => (
        <Badge tone={LEG_TONE[row.status]} dot>
          {t(`legs.status.${row.status}`)}
        </Badge>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <PageHeader title={t('legs.heading')} description={t('legs.intro')} />
      <Card>
        <Toolbar>
          <ToolbarField label={t('legs.filter.owner')} className="w-44">
            <Select value={owner} onChange={(event) => { setOwner(event.currentTarget.value as ControlOwner | ''); }}>
              <option value="">{t('legs.filter.anyOwner')}</option>
              <option value="UBOSS">UBOSS</option>
              <option value="SELLER">{t('levels.seller')}</option>
            </Select>
          </ToolbarField>
          <ToolbarField label={t('legs.filter.status')} className="w-56">
            <Select value={status} onChange={(event) => { setStatus(event.currentTarget.value as LegStatus | ''); }}>
              <option value="">{t('legs.filter.anyStatus')}</option>
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(`legs.status.${value}`)}
                </option>
              ))}
            </Select>
          </ToolbarField>
          <ToolbarToggle label={t('legs.filter.needsAssignment')} checked={needsAssignment} onChange={setNeedsAssignment} />
        </Toolbar>
        <DataTable
          caption={t('legs.heading')}
          columns={columns}
          rows={query.data?.legs ?? []}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          isRefreshing={query.isFetching && !query.isPending}
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
          minWidth="56rem"
          emptyTitle={t('legs.emptyTitle')}
          emptyDescription={t('legs.emptyBody')}
          onRowClick={(row) => {
            void navigate(`/logistics/legs/${row.id}`);
          }}
        />
      </Card>
    </div>
  );
}

export function LegDetailPage(): React.JSX.Element {
  const { t } = useI18n();
  const { legId = '' } = useParams();
  const query = useQuery({ queryKey: ['admin', 'leg', legId], queryFn: () => fetchLeg(legId) });

  if (query.isPending) return <LoadingState label={t('legs.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  const { leg, journey, marketplaceCarriers } = query.data;

  return (
    <div className="space-y-5">
      <PageHeader
        title={`${leg.level} · ${t(`levels.level.${leg.level}`)}`}
        description={`${leg.orderNumber} · ${leg.sellerName} · ${leg.sellerOrderNumber}`}
        back={{ to: '/logistics/legs', label: t('legs.heading') }}
        meta={
          <>
            <Badge tone={leg.owner === 'UBOSS' ? 'brand' : 'success'}>{leg.owner === 'UBOSS' ? t('levels.ubossManaged') : t('levels.sellerManaged')}</Badge>
            <Badge tone={LEG_TONE[leg.status]}>{t(`legs.status.${leg.status}`)}</Badge>
          </>
        }
      />

      <Card title={t('legs.journeyTitle')}>
        <ol className="grid gap-3 px-5 pb-5 sm:grid-cols-4">
          {journey.map((step) => (
            <li
              key={step.id}
              aria-current={step.id === leg.id ? 'step' : undefined}
              className={step.id === leg.id ? 'rounded-md border-2 border-brand p-3' : 'rounded-md border border-border-subtle p-3'}
            >
              <p className="text-sm font-semibold text-ink">{step.level}</p>
              <p className="text-xxs text-ink-subtle">{step.owner === 'UBOSS' ? 'UBOSS' : t('levels.seller')}</p>
              <Badge tone={LEG_TONE[step.status]}>{t(`legs.status.${step.status}`)}</Badge>
              <p className="mt-1 text-xxs text-ink-subtle">{step.carrier ?? '—'}</p>
            </li>
          ))}
        </ol>
      </Card>

      {leg.owner === 'UBOSS' ? (
        <LegActions leg={leg} carriers={marketplaceCarriers} />
      ) : (
        <Callout tone="neutral">{t('legs.sellerReadOnly')}</Callout>
      )}

      <Card title={t('legs.historyTitle')}>
        <ul className="divide-y divide-border-subtle">
          {leg.events.map((event) => (
            <li key={event.id} className="px-5 py-3 text-sm">
              <p className="text-ink">
                {t(`legs.status.${event.toStatus}`)} · {event.kind.toLowerCase().replace(/_/g, ' ')}
              </p>
              <p className="text-xxs text-ink-subtle">
                {formatDateTime(event.occurredAt)} · {event.actorRole}
                {event.note !== null && ` · ${event.note}`}
              </p>
            </li>
          ))}
        </ul>
      </Card>

      {leg.charge !== null && (
        <p className="text-xs text-ink-muted">
          {t('legs.charged', { amount: leg.charge.isFree ? t('levels.free') : formatMoney(leg.charge.amount) })}
        </p>
      )}
    </div>
  );
}

function LegActions({ leg, carriers }: { leg: LegView; carriers: { id: string; displayName: string }[] }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const { can } = useSession();
  const mayAssign = can(Permission.LOGISTICS_ASSIGN);
  const [carrier, setCarrier] = useState(leg.logisticsPartnerId !== null ? `partner:${leg.logisticsPartnerId}` : (leg.provider ?? ''));
  const [tracking, setTracking] = useState(leg.trackingNumber ?? '');
  const [reason, setReason] = useState('');

  function done(message: string): void {
    toast.success(message);
    void client.invalidateQueries({ queryKey: ['admin', 'leg', leg.id] });
    void client.invalidateQueries({ queryKey: ['admin', 'legs'] });
  }

  const assign = useMutation({
    mutationFn: () => {
      const partnerId = carrier.startsWith('partner:') ? carrier.slice('partner:'.length) : null;
      return assignUbossLeg(leg.id, {
        provider: partnerId === null ? carrier : null,
        logisticsPartnerId: partnerId,
        ...(tracking.trim() === '' ? {} : { trackingNumber: tracking.trim() }),
        ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
        expectedVersion: leg.version,
      });
    },
    onSuccess: () => {
      done(t('legs.assigned'));
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });
  const references = useMutation({
    mutationFn: () => updateUbossLegReferences(leg.id, { trackingNumber: tracking.trim() === '' ? null : tracking.trim() }),
    onSuccess: () => {
      done(t('legs.trackingSaved'));
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });
  const move = useMutation({
    mutationFn: (to: 'IN_PROGRESS' | 'COMPLETED') => moveUbossLeg(leg.id, { to, idempotencyKey: `${leg.id}:${to}:${String(leg.version)}` }),
    onSuccess: () => {
      done(t('legs.moved'));
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  if (!mayAssign) return <Callout tone="neutral">{t('legs.needsAssign')}</Callout>;

  const assignable = ['PENDING', 'AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTED'].includes(leg.status);
  const handBooked = leg.provider !== null;

  return (
    <Card title={t('legs.actionsTitle')} description={t('legs.actionsBody')}>
      <div className="space-y-4 px-5 pb-5">
        {assignable && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('levels.field.carrier')}>
              {({ inputId }) => (
                <Select id={inputId} value={carrier} onChange={(event) => { setCarrier(event.currentTarget.value); }}>
                  <option value="">—</option>
                  <option value="DHL">DHL</option>
                  <option value="FEDEX">FedEx</option>
                  <option value="INDIA_POST">India Post</option>
                  <option value="MANUAL">{t('levels.forwarder')}</option>
                  {carriers.map((partner) => (
                    <option key={partner.id} value={`partner:${partner.id}`}>
                      {partner.displayName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {leg.carrier !== null && (
              <Field label={t('legs.reason')}>
                {({ inputId }) => <Input id={inputId} value={reason} maxLength={512} onChange={(event) => { setReason(event.currentTarget.value); }} />}
              </Field>
            )}
            <div className="flex items-end">
              <Button variant="primary" disabled={carrier === ''} isLoading={assign.isPending} onClick={() => { assign.mutate(); }}>
                {leg.carrier === null ? t('legs.assign') : t('legs.reassign')}
              </Button>
            </div>
          </div>
        )}

        {handBooked && leg.status !== 'COMPLETED' && leg.status !== 'CANCELLED' && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('legs.trackingLabel')} hint={t('legs.trackingHint')}>
              {({ inputId, describedBy }) => (
                <Input id={inputId} aria-describedby={describedBy} value={tracking} maxLength={64} onChange={(event) => { setTracking(event.currentTarget.value); }} />
              )}
            </Field>
            <div className="flex items-end">
              <Button variant="secondary" disabled={tracking.trim() === ''} isLoading={references.isPending} onClick={() => { references.mutate(); }}>
                {t('legs.saveTracking')}
              </Button>
            </div>
          </div>
        )}

        {handBooked && (
          <div className="flex flex-wrap gap-2">
            {(leg.status === 'ASSIGNED' || leg.status === 'ACCEPTED') && (
              <Button variant="secondary" isLoading={move.isPending} onClick={() => { move.mutate('IN_PROGRESS'); }}>
                {t('legs.start')}
              </Button>
            )}
            {leg.status === 'IN_PROGRESS' && (
              <Button variant="primary" isLoading={move.isPending} onClick={() => { move.mutate('COMPLETED'); }}>
                {t('legs.handOver')}
              </Button>
            )}
          </div>
        )}

        {!handBooked && leg.logisticsPartnerId !== null && <p className="text-xs text-ink-muted">{t('legs.partnerMovesIt')}</p>}
      </div>
    </Card>
  );
}
