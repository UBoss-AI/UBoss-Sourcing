/**
 * Sourcing terms on a Seller Hub listing (checklist JOURNEY-029).
 *
 * Samples, bulk lead time, OEM and private label, the Incoterms the seller
 * quotes on, and which of their certificates cover this product. Only a
 * certificate the marketplace verified and that is still in date can be
 * linked - the list offered here is exactly that list, and the server checks
 * it again. Buyers see these terms on the product page and can filter on them.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Button, Card, Input } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';

interface Terms {
  sampleAvailable: boolean;
  sampleNote: string | null;
  privateLabelAvailable: boolean;
  oemAvailable: boolean;
  leadTimeDaysMin: number | null;
  leadTimeDaysMax: number | null;
  incoterms: string[];
  certifications: { id: string; standard: string; issuer: string; expiresOn: string | null }[];
}

interface SourcingResponse {
  terms: Terms | null;
  /** Production capacity on this listing (JOURNEY-028). Absent from older servers. */
  capacity?: { capacityUnitsPerWeek: number | null; capacityLeadTimeDays: number | null };
  incoterms: string[];
  linkableCertifications: { id: string; standard: string; issuer: string; expiresOn: string | null }[];
}

const EMPTY: Terms = {
  sampleAvailable: false,
  sampleNote: null,
  privateLabelAvailable: false,
  oemAvailable: false,
  leadTimeDaysMin: null,
  leadTimeDaysMax: null,
  incoterms: [],
  certifications: [],
};

function daysOrNull(text: string): number | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : Number(trimmed);
}

export function ListingSourcingPanel({ offerId }: { offerId: string }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['seller', 'listing-sourcing', offerId],
    queryFn: () => api.get<SourcingResponse>(`/seller/listings/${offerId}/sourcing`),
    enabled: offerId !== '',
  });
  const [draft, setDraft] = useState<Terms>(EMPTY);
  const [minText, setMinText] = useState('');
  const [maxText, setMaxText] = useState('');
  const [certIds, setCertIds] = useState<string[]>([]);
  const [weeklyText, setWeeklyText] = useState('');
  const [capacityLeadText, setCapacityLeadText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const capacity = query.data?.capacity;
    const weeklyStored = capacity?.capacityUnitsPerWeek ?? null;
    const leadStored = capacity?.capacityLeadTimeDays ?? null;
    setWeeklyText(weeklyStored === null ? '' : String(weeklyStored));
    setCapacityLeadText(leadStored === null ? '' : String(leadStored));
    const terms = query.data?.terms ?? EMPTY;
    setDraft(terms);
    setMinText(terms.leadTimeDaysMin === null ? '' : String(terms.leadTimeDaysMin));
    setMaxText(terms.leadTimeDaysMax === null ? '' : String(terms.leadTimeDaysMax));
    setCertIds(terms.certifications.map((certificate) => certificate.id));
  }, [query.data]);

  const validDays = (text: string): boolean => text.trim() === '' || /^\d{1,3}$/.test(text.trim());
  const min = daysOrNull(minText);
  const max = daysOrNull(maxText);
  const rangeError = validDays(minText) && validDays(maxText) && min !== null && max !== null && min > max;
  const validWeekly = weeklyText.trim() === '' || /^[1-9]\d{0,8}$/.test(weeklyText.trim());
  const weekly = weeklyText.trim() === '' ? null : Number(weeklyText.trim());
  const capacityLead = daysOrNull(capacityLeadText);
  // A lead time means nothing without the weekly figure it applies to.
  const capacityError = capacityLead !== null && weekly === null;
  const canSave =
    validDays(minText) && validDays(maxText) && !rangeError && validWeekly && validDays(capacityLeadText) && !capacityError;

  const save = useMutation({
    mutationFn: () =>
      api.put(`/seller/listings/${offerId}/sourcing`, {
        sampleAvailable: draft.sampleAvailable,
        sampleNote: draft.sampleAvailable ? (draft.sampleNote ?? '').trim() || null : null,
        privateLabelAvailable: draft.privateLabelAvailable,
        oemAvailable: draft.oemAvailable,
        leadTimeDaysMin: min,
        leadTimeDaysMax: max,
        incoterms: draft.incoterms,
        certificationIds: certIds,
        capacityUnitsPerWeek: weekly,
        capacityLeadTimeDays: capacityLead,
      }),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['seller', 'listing-sourcing', offerId] });
      toast.success(t('seller.sourcing.saved'));
    },
    onError: (caught) => {
      setError(errorMessage(t, caught, t('seller.sourcing.saveFailed')));
    },
  });

  const toggle = (label: string, checked: boolean, onChange: (value: boolean) => void): React.JSX.Element => (
    <label className="flex min-h-11 items-center gap-2.5 text-sm text-ink">
      <input type="checkbox" className="h-4 w-4 rounded border-border-strong text-brand" checked={checked} onChange={(event) => { onChange(event.target.checked); }} />
      {label}
    </label>
  );

  return (
    <Card title={t('seller.sourcing.title')} description={t('seller.sourcing.intro')} bodyClassName="px-6 py-5">
      {query.isPending ? (
        <p className="text-sm text-ink-subtle">{t('common.loading')}</p>
      ) : query.isError ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-subtle">{t('seller.sourcing.loadFailed')}</p>
          <Button size="sm" onClick={() => { void query.refetch(); }}>{t('common.retry')}</Button>
        </div>
      ) : (
        <div className="space-y-4">
          {error !== null && (
            <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
          )}
          <div>
            {toggle(t('seller.sourcing.sample'), draft.sampleAvailable, (value) => { setDraft({ ...draft, sampleAvailable: value }); })}
            {draft.sampleAvailable && (
              <label className="mt-1 block text-sm text-ink">
                {t('seller.sourcing.sampleNote')}
                <Input className="mt-1" maxLength={255} value={draft.sampleNote ?? ''} onChange={(event) => { setDraft({ ...draft, sampleNote: event.target.value }); }} />
              </label>
            )}
            {toggle(t('seller.sourcing.oem'), draft.oemAvailable, (value) => { setDraft({ ...draft, oemAvailable: value }); })}
            {toggle(t('seller.sourcing.privateLabel'), draft.privateLabelAvailable, (value) => { setDraft({ ...draft, privateLabelAvailable: value }); })}
          </div>

          <fieldset>
            <legend className="text-sm font-medium text-ink">{t('seller.sourcing.leadTime')}</legend>
            <div className="mt-1 grid grid-cols-2 gap-3 sm:max-w-sm">
              <label className="text-xs text-ink-muted">
                {t('seller.sourcing.leadTimeMin')}
                <Input className="mt-1" inputMode="numeric" value={minText} onChange={(event) => { setMinText(event.target.value); }} aria-invalid={!validDays(minText) || rangeError} />
              </label>
              <label className="text-xs text-ink-muted">
                {t('seller.sourcing.leadTimeMax')}
                <Input className="mt-1" inputMode="numeric" value={maxText} onChange={(event) => { setMaxText(event.target.value); }} aria-invalid={!validDays(maxText) || rangeError} />
              </label>
            </div>
            {rangeError && <p className="mt-1 text-xs text-danger">{t('seller.sourcing.rangeError')}</p>}
          </fieldset>

          <fieldset>
            <legend className="text-sm font-medium text-ink">{t('seller.sourcing.capacity')}</legend>
            <p className="text-xs text-ink-muted">{t('seller.sourcing.capacityHint')}</p>
            <div className="mt-1 grid grid-cols-2 gap-3 sm:max-w-sm">
              <label className="text-xs text-ink-muted">
                {t('seller.sourcing.capacityWeekly')}
                <Input className="mt-1" inputMode="numeric" value={weeklyText} onChange={(event) => { setWeeklyText(event.target.value); }} aria-invalid={!validWeekly || capacityError} />
              </label>
              <label className="text-xs text-ink-muted">
                {t('seller.sourcing.capacityLead')}
                <Input className="mt-1" inputMode="numeric" value={capacityLeadText} onChange={(event) => { setCapacityLeadText(event.target.value); }} aria-invalid={!validDays(capacityLeadText)} />
              </label>
            </div>
            {capacityError && <p className="mt-1 text-xs text-danger">{t('seller.sourcing.capacityError')}</p>}
          </fieldset>

          <fieldset>
            <legend className="text-sm font-medium text-ink">{t('seller.sourcing.incoterms')}</legend>
            <div className="mt-1 flex flex-wrap gap-x-4">
              {query.data.incoterms.map((code) =>
                <span key={code}>
                  {toggle(code, draft.incoterms.includes(code), (on) => {
                    setDraft({ ...draft, incoterms: on ? [...draft.incoterms, code] : draft.incoterms.filter((existing) => existing !== code) });
                  })}
                </span>,
              )}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-sm font-medium text-ink">{t('seller.sourcing.certifications')}</legend>
            {query.data.linkableCertifications.length === 0 ? (
              <p className="mt-1 text-xs text-ink-muted">{t('seller.sourcing.noCertifications')}</p>
            ) : (
              query.data.linkableCertifications.map((certificate) => (
                <span key={certificate.id}>
                  {toggle(`${certificate.standard} · ${certificate.issuer}`, certIds.includes(certificate.id), (on) => {
                    setCertIds(on ? [...certIds, certificate.id] : certIds.filter((id) => id !== certificate.id));
                  })}
                </span>
              ))
            )}
          </fieldset>

          <Button variant="primary" isLoading={save.isPending} disabled={!canSave} onClick={() => { save.mutate(); }}>
            {t('seller.sourcing.save')}
          </Button>
        </div>
      )}
    </Card>
  );
}
