/**
 * The delivery legs this company has been given - one level of a four-level
 * journey each (L1 first mile, L2 international, L3 destination inland, L4
 * last mile) - and nothing else.
 *
 * The company accepts or refuses a leg, puts one of its own drivers on it,
 * enters the references it issued, and records the start and the handover.
 * It is never shown what the buyer paid for the leg, and it cannot see any
 * leg another company holds: the server scopes every read and write to the
 * company in the session.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, EmptyState, ErrorState, Input, LoadingState, PageHeader, Select } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { ApiError, api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { fetchDrivers } from '@/lib/logistics';
import { Permission } from '@/lib/permissions';

type LegStatus = 'PENDING' | 'AWAITING_ASSIGNMENT' | 'ASSIGNED' | 'ACCEPTED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

interface PartnerLeg {
  id: string;
  level: 'L1' | 'L2' | 'L3' | 'L4';
  status: LegStatus;
  orderNumber: string;
  sellerName: string;
  origin: string | null;
  destination: string | null;
  transportMode: string | null;
  trackingNumber: string | null;
  pickupReference: string | null;
  driverProfileId: string | null;
  version: number;
  events: { id: string; kind: string; toStatus: LegStatus; note: string | null; occurredAt: string }[];
}

const TONE: Record<LegStatus, BadgeTone> = {
  PENDING: 'neutral',
  AWAITING_ASSIGNMENT: 'neutral',
  ASSIGNED: 'warning',
  ACCEPTED: 'brand',
  IN_PROGRESS: 'operational',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
};

const KEY = ['logistics', 'legs'] as const;

export function LegsPage(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: KEY, queryFn: () => api.get<{ legs: PartnerLeg[] }>('/logistics/legs') });

  return (
    <div className="space-y-5">
      <PageHeader title={t('legs.heading')} description={t('legs.intro')} />
      {query.isPending && <LoadingState label={t('legs.loading')} />}
      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}
      {query.data !== undefined && query.data.legs.length === 0 && (
        <Card>
          <EmptyState title={t('legs.emptyTitle')} description={t('legs.emptyBody')} />
        </Card>
      )}
      <ul className="space-y-4">
        {query.data?.legs.map((leg) => (
          <li key={leg.id}>
            <LegCard leg={leg} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function LegCard({ leg }: { leg: PartnerLeg }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const { can } = useSession();
  const [reason, setReason] = useState('');
  const [tracking, setTracking] = useState(leg.trackingNumber ?? '');
  const [driver, setDriver] = useState(leg.driverProfileId ?? '');
  const drivers = useQuery({ queryKey: ['logistics', 'drivers'], queryFn: fetchDrivers, enabled: can(Permission.DRIVER_ASSIGN) });

  function message(error: unknown): string {
    return error instanceof ApiError && error.message.length > 0 ? error.message : t('legs.failed');
  }

  const act = useMutation({
    mutationFn: (input: { path: string; body: unknown; method?: 'POST' | 'PATCH' }) =>
      input.method === 'PATCH' ? api.patch(input.path, input.body) : api.post(input.path, input.body),
    onSuccess: () => {
      toast.success(t('legs.saved'));
      void client.invalidateQueries({ queryKey: KEY });
    },
    onError: (error: unknown) => {
      toast.error(message(error));
    },
  });

  const base = `/logistics/legs/${leg.id}`;

  return (
    <Card
      title={`${leg.level} · ${t(`legs.level.${leg.level}`)}`}
      description={`${leg.orderNumber} · ${leg.sellerName}`}
      actions={<Badge tone={TONE[leg.status]}>{t(`legs.status.${leg.status}`)}</Badge>}
    >
      <div className="space-y-4 px-5 pb-5">
        <p className="text-sm text-ink">
          {leg.origin ?? '—'} → {leg.destination ?? '—'}
        </p>

        {leg.status === 'ASSIGNED' && can(Permission.SHIPMENT_ACCEPT) && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Button variant="primary" isLoading={act.isPending} onClick={() => { act.mutate({ path: `${base}/accept`, body: {} }); }}>
              {t('legs.accept')}
            </Button>
            <label className="flex-1 text-xs font-medium text-ink">
              {t('legs.rejectReason')}
              <Input className="mt-1" value={reason} maxLength={512} onChange={(event) => { setReason(event.currentTarget.value); }} />
            </label>
            <Button variant="secondary" disabled={reason.trim().length < 4} onClick={() => { act.mutate({ path: `${base}/reject`, body: { reason: reason.trim() } }); }}>
              {t('legs.reject')}
            </Button>
          </div>
        )}

        {(leg.status === 'ACCEPTED' || leg.status === 'IN_PROGRESS') && can(Permission.DRIVER_ASSIGN) && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex-1 text-xs font-medium text-ink">
              {t('legs.driver')}
              <Select className="mt-1" value={driver} onChange={(event) => { setDriver(event.currentTarget.value); }}>
                <option value="">{t('legs.noDriver')}</option>
                {(drivers.data?.drivers ?? [])
                  .filter((row) => row.state === 'ACTIVE')
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.fullName}
                    </option>
                  ))}
              </Select>
            </label>
            <Button variant="secondary" onClick={() => { act.mutate({ path: `${base}/driver`, body: { driverProfileId: driver === '' ? null : driver } }); }}>
              {t('legs.saveDriver')}
            </Button>
          </div>
        )}

        {(leg.status === 'ACCEPTED' || leg.status === 'IN_PROGRESS') && can(Permission.SHIPMENT_STATUS_WRITE) && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex-1 text-xs font-medium text-ink">
              {t('legs.reference')}
              <Input className="mt-1" value={tracking} maxLength={64} onChange={(event) => { setTracking(event.currentTarget.value); }} />
            </label>
            <Button variant="secondary" disabled={tracking.trim() === ''} onClick={() => { act.mutate({ path: base, body: { trackingNumber: tracking.trim() }, method: 'PATCH' }); }}>
              {t('legs.saveReference')}
            </Button>
            {leg.status === 'ACCEPTED' ? (
              <Button variant="primary" onClick={() => { act.mutate({ path: `${base}/progress`, body: { to: 'IN_PROGRESS', idempotencyKey: `${leg.id}:start:${String(leg.version)}` } }); }}>
                {t('legs.start')}
              </Button>
            ) : (
              <Button variant="primary" onClick={() => { act.mutate({ path: `${base}/progress`, body: { to: 'COMPLETED', idempotencyKey: `${leg.id}:done:${String(leg.version)}` } }); }}>
                {leg.level === 'L4' ? t('legs.delivered') : t('legs.handOver')}
              </Button>
            )}
          </div>
        )}

        {leg.events.length > 0 && (
          <ul className="space-y-1 border-t border-border-subtle pt-3 text-xs text-ink-muted">
            {leg.events.slice(-4).map((event) => (
              <li key={event.id}>
                {formatDateTime(event.occurredAt)} · {t(`legs.status.${event.toStatus}`)}
                {event.note !== null && ` · ${event.note}`}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
