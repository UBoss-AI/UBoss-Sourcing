/**
 * Shipment Assessment on an L2 leg this carrier holds.
 *
 *   GET  /logistics/legs/:id/shipment-assessment            release or hold, handling needs
 *   POST /logistics/legs/:id/shipment-assessment/checks     final loading checks
 *   POST /logistics/legs/:id/shipment-assessment/evidence   container, seal and document photos
 *
 * The carrier sees whether the Audit Team has released the goods and records
 * the final loading checks after release. It cannot lift a hold: starting the
 * leg is refused by the server until the release is valid.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Input, Select } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { ApiError, api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

interface LoadingItem {
  code: string;
  label: string;
  evidenceRequired: boolean;
}

interface CarrierView {
  number: string;
  status: string;
  releaseRefusal: string | null;
  releaseDeadline: string | null;
  holdReason: string | null;
  loadingChecksCompletedAt: string | null;
  loadingItems: LoadingItem[];
  checks: { itemCode: string; outcome: string; note: string | null }[];
}

const OUTCOMES = ['PASS', 'FAIL', 'HOLD', 'NOT_APPLICABLE'] as const;

function newKey(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function LegAssessmentPanel({ legId }: { legId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const key = ['logistics', 'leg-assessment', legId];
  const query = useQuery({ queryKey: key, queryFn: () => api.get<{ assessment: CarrierView | null }>(`/logistics/legs/${encodeURIComponent(legId)}/shipment-assessment`) });
  const [drafts, setDrafts] = useState<Record<string, { outcome: string; note: string }>>({});
  const [file, setFile] = useState<File | null>(null);
  const [itemCode, setItemCode] = useState('');
  const onError = (error: unknown) => {
    toast.error(error instanceof ApiError && error.message.length > 0 ? error.message : t('legs.failed'));
  };
  const onSuccess = () => {
    toast.success(t('legs.saved'));
    setDrafts({});
    setFile(null);
    void client.invalidateQueries({ queryKey: key });
  };
  const save = useMutation({
    mutationFn: () =>
      api.post(`/logistics/legs/${encodeURIComponent(legId)}/shipment-assessment/checks`, {
        checks: Object.entries(drafts)
          .filter(([, draft]) => draft.outcome !== '')
          .map(([code, draft]) => ({ itemCode: code, outcome: draft.outcome, note: draft.note === '' ? null : draft.note })),
      }),
    onSuccess,
    onError,
  });
  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      if (itemCode !== '') form.append('itemCode', itemCode);
      form.append('file', file as File);
      return api.upload(`/logistics/legs/${encodeURIComponent(legId)}/shipment-assessment/evidence`, form, { idempotencyKey: newKey() });
    },
    onSuccess,
    onError,
  });

  const a = query.data?.assessment ?? null;
  if (a === null) return null;
  const released = a.status === 'APPROVED_FOR_L2';
  return (
    <div className="space-y-3 rounded-md border border-border-subtle p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t('legAssessment.title', { number: a.number })}</span>
        <Badge tone={released ? 'success' : a.status === 'DISPATCHED' ? 'neutral' : 'warning'}>{t(`legAssessment.status.${a.status}` as TranslationKey)}</Badge>
      </div>
      {a.releaseRefusal !== null && a.status !== 'DISPATCHED' && <p>{t(`legAssessment.refusal.${a.releaseRefusal}` as TranslationKey)}</p>}
      {a.holdReason !== null && <p className="text-danger">{t('legAssessment.held')}</p>}
      {a.releaseDeadline !== null && <p>{t('legAssessment.dispatchBy', { date: formatDateTime(a.releaseDeadline) })}</p>}
      {released && (
        <>
          <p className="text-ink-muted">{a.loadingChecksCompletedAt === null ? t('legAssessment.loadingIntro') : t('legAssessment.loadingDone')}</p>
          <ul className="space-y-2">
            {a.loadingItems.map((item) => {
              const recorded = a.checks.find((check) => check.itemCode === item.code);
              const draft = drafts[item.code] ?? { outcome: recorded?.outcome ?? '', note: recorded?.note ?? '' };
              return (
                <li key={item.code} className="grid gap-2 sm:grid-cols-[1fr_9rem_12rem]">
                  <span>
                    {item.code} · {item.label}
                    {item.evidenceRequired && ` · ${t('legAssessment.photoRequired')}`}
                  </span>
                  <Select
                    aria-label={`${item.code} ${t('legAssessment.result')}`}
                    value={draft.outcome}
                    onChange={(event) => {
                      setDrafts((current) => ({ ...current, [item.code]: { ...draft, outcome: event.target.value } }));
                    }}
                  >
                    <option value="">{t('legAssessment.notRecorded')}</option>
                    {OUTCOMES.map((outcome) => (
                      <option key={outcome} value={outcome}>
                        {t(`legAssessment.outcome.${outcome}` as TranslationKey)}
                      </option>
                    ))}
                  </Select>
                  <Input
                    aria-label={`${item.code} ${t('legAssessment.note')}`}
                    placeholder={t('legAssessment.note')}
                    value={draft.note}
                    onChange={(event) => {
                      setDrafts((current) => ({ ...current, [item.code]: { ...draft, note: event.target.value } }));
                    }}
                  />
                </li>
              );
            })}
          </ul>
          <Button
            size="sm"
            disabled={save.isPending || Object.keys(drafts).length === 0}
            onClick={() => {
              save.mutate();
            }}
          >
            {t('legAssessment.save')}
          </Button>
          <div className="flex flex-wrap items-end gap-2">
            <Select
              aria-label={t('legAssessment.item')}
              value={itemCode}
              onChange={(event) => {
                setItemCode(event.target.value);
              }}
            >
              <option value="">{t('legAssessment.item')}</option>
              {a.loadingItems.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.code}
                </option>
              ))}
            </Select>
            <Input
              type="file"
              accept="image/*,application/pdf"
              capture="environment"
              aria-label={t('legAssessment.photo')}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
              }}
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={file === null || upload.isPending}
              onClick={() => {
                upload.mutate();
              }}
            >
              {t('legAssessment.upload')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
