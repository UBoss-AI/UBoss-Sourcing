/**
 * Custody and dispatch evidence on a shipment this carrier holds.
 *
 *   GET  /logistics/shipments/:id/custody   gaps, customs documents, handling needs, handovers
 *   POST /logistics/shipments/:id/custody   record a custody handover
 *
 * The carrier records who handed the goods to whom, where and when, how many
 * packages, and whether the seals were intact. It sees what the dispatch check
 * still needs but cannot waive it: the server decides.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, Input } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { ApiError, api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { Permission } from '@/lib/permissions';

interface CustodyView {
  gaps: string[];
  documents: { kind: string; status: string; requiredBeforeDispatch: boolean }[];
  requirements: string[];
  custody: { id: string; fromParty: string; toParty: string; place: string; handedOverAt: string; packages: number; sealsIntact: boolean; exceptionNote: string | null }[];
}

function newKey(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const EMPTY = { fromParty: '', toParty: '', place: '', packages: '1', sealsIntact: true, exceptionNote: '' };

export function CustodyPanel({ shipmentId }: { shipmentId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const toast = useToast();
  const { canAny } = useSession();
  const client = useQueryClient();
  const key = ['logistics', 'shipment-custody', shipmentId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api.get<CustodyView>(`/logistics/shipments/${encodeURIComponent(shipmentId)}/custody`),
    enabled: canAny(Permission.SHIPMENT_READ),
    retry: false,
  });
  const [form, setForm] = useState(EMPTY);
  const record = useMutation({
    mutationFn: () =>
      api.post(
        `/logistics/shipments/${encodeURIComponent(shipmentId)}/custody`,
        {
          fromParty: form.fromParty.trim(),
          toParty: form.toParty.trim(),
          place: form.place.trim(),
          handedOverAt: new Date().toISOString(),
          packages: Number.parseInt(form.packages, 10) || 0,
          sealsIntact: form.sealsIntact,
          exceptionNote: form.exceptionNote.trim() === '' ? null : form.exceptionNote.trim(),
        },
        { idempotencyKey: newKey() },
      ),
    onSuccess: () => {
      toast.success(t('custody.saved'));
      setForm(EMPTY);
      void client.invalidateQueries({ queryKey: key });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof ApiError && error.message.length > 0 ? error.message : t('custody.failed'));
    },
  });

  // Not a seller order shipment, or not this carrier's: nothing to show.
  if (query.isError || query.data === undefined) return null;
  const view = query.data;
  const canWrite = canAny(Permission.SHIPMENT_STATUS_WRITE);
  const ready = form.fromParty.trim() !== '' && form.toParty.trim() !== '' && form.place.trim().length >= 2;

  return (
    <Card title={t('custody.title')} description={t('custody.intro')} bodyClassName="space-y-4 px-5 py-4 text-sm">
      <div>
        <h3 className="font-medium">{t('custody.gaps')}</h3>
        {view.gaps.length === 0 ? (
          <p className="text-ink-muted">{t('custody.noGaps')}</p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-2">
            {view.gaps.map((gap) => (
              <li key={gap}>
                <Badge tone="warning">{t(`custody.gap.${gap}` as TranslationKey)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
      {view.requirements.length > 0 && (
        <div>
          <h3 className="font-medium">{t('custody.requirements')}</h3>
          <p>{view.requirements.map((r) => t(`custody.requirement.${r}` as TranslationKey)).join(', ')}</p>
        </div>
      )}
      <div>
        <h3 className="font-medium">{t('custody.documents')}</h3>
        <ul className="mt-1 space-y-1">
          {view.documents.map((d) => (
            <li key={d.kind} className="flex flex-wrap items-center gap-2">
              <span>{t(`custody.document.${d.kind}` as TranslationKey)}</span>
              <Badge tone={d.status === 'VALID' ? 'success' : d.status === 'REJECTED' ? 'danger' : 'neutral'}>{t(`custody.documentStatus.${d.status}` as TranslationKey)}</Badge>
              {d.requiredBeforeDispatch && <span className="text-ink-muted">{t('custody.requiredBeforeDispatch')}</span>}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="font-medium">{t('custody.handovers')}</h3>
        {view.custody.length === 0 ? (
          <p className="text-ink-muted">{t('custody.noHandovers')}</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {view.custody.map((h) => (
              <li key={h.id}>
                {t('custody.handoverLine', { from: h.fromParty, to: h.toParty, place: h.place, when: formatDateTime(h.handedOverAt), packages: String(h.packages) })}
                {' · '}
                {h.sealsIntact ? t('custody.sealsIntact') : t('custody.sealsBroken')}
                {h.exceptionNote !== null && ` · ${h.exceptionNote}`}
              </li>
            ))}
          </ul>
        )}
      </div>
      {canWrite && (
        <form
          className="grid gap-2 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) record.mutate();
          }}
        >
          <Input aria-label={t('custody.from')} placeholder={t('custody.from')} value={form.fromParty} onChange={(e) => { setForm({ ...form, fromParty: e.target.value }); }} />
          <Input aria-label={t('custody.to')} placeholder={t('custody.to')} value={form.toParty} onChange={(e) => { setForm({ ...form, toParty: e.target.value }); }} />
          <Input aria-label={t('custody.place')} placeholder={t('custody.place')} value={form.place} onChange={(e) => { setForm({ ...form, place: e.target.value }); }} />
          <Input aria-label={t('custody.packages')} type="number" min={0} value={form.packages} onChange={(e) => { setForm({ ...form, packages: e.target.value }); }} />
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.sealsIntact} onChange={(e) => { setForm({ ...form, sealsIntact: e.target.checked }); }} />
            {t('custody.sealsIntactLabel')}
          </label>
          <Input aria-label={t('custody.exception')} placeholder={t('custody.exception')} value={form.exceptionNote} onChange={(e) => { setForm({ ...form, exceptionNote: e.target.value }); }} />
          <div className="sm:col-span-2">
            <Button type="submit" size="sm" disabled={!ready || record.isPending}>
              {t('custody.record')}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
