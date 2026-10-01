/**
 * The buyer books an inspection on one part of their order before it ships
 * (checklist Master row 94): agency, date, inspection point and who pays.
 *
 * The agency list comes from the server for the chosen day and country, so an
 * agency that is fully booked or does not serve that country is shown greyed
 * out with its reason. An agency that is not independent of the seller is
 * never listed. Every rule is checked again on the server when booking.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Button, Input, Select, Textarea } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { bookBuyerInspection, fetchBuyerAgencyChoices, type BuyerBookingInput, type InspectionView } from '@/lib/inspection';

const POINT_TYPES = ['SELLER_PREMISES', 'WAREHOUSE', 'PORT', 'OTHER'] as const;

export function BuyerBookingForm({
  orderId,
  view,
  queryKey,
}: {
  orderId: string;
  view: InspectionView;
  queryKey: readonly unknown[];
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const groupId = view.requirement.sellerOrderGroupId;
  // An inspection no rule requires is one the buyer asked for, and the buyer pays for it.
  const buyerPaysOnly = view.requirement.level === 'NOT_REQUIRED' || view.requirement.level === 'BUYER_REQUESTED';

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    date: '',
    pointType: 'SELLER_PREMISES' as BuyerBookingInput['inspectionPointType'],
    label: '',
    addressLine: '',
    city: '',
    country: '',
    payer: 'BUYER' as BuyerBookingInput['payer'],
    agencyId: '',
    notes: '',
  });
  const set = (patch: Partial<typeof form>): void => { setForm({ ...form, ...patch }); };
  const country = form.country.trim().toUpperCase();

  const agencies = useQuery({
    queryKey: ['inspection', 'buyer', orderId, 'agencies', groupId, form.date, country],
    queryFn: () => fetchBuyerAgencyChoices(orderId, { sellerOrderGroupId: groupId, country, scheduledFor: form.date }),
    enabled: open && form.date !== '' && country.length === 2,
    retry: false,
  });

  const book = useMutation({
    mutationFn: () =>
      bookBuyerInspection(orderId, {
        sellerOrderGroupId: groupId,
        agencyId: form.agencyId,
        scheduledFor: form.date,
        inspectionPointType: form.pointType,
        inspectionPoint: { label: form.label.trim(), addressLine: form.addressLine.trim(), city: form.city.trim(), country },
        payer: buyerPaysOnly ? 'BUYER' : form.payer,
        specialRequirements: form.notes.trim() === '' ? null : form.notes.trim(),
      }),
    onSuccess: async (result) => {
      toast.success(t('inspection.booking.booked', { jobNumber: result.jobNumber }));
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (failure) => { toast.error(errorMessage(t, failure)); },
  });

  if (!open) {
    return <Button size="sm" variant="secondary" onClick={() => { setOpen(true); }}>{t('inspection.booking.open')}</Button>;
  }

  const ready =
    form.date !== '' && country.length === 2 && form.label.trim() !== '' && form.addressLine.trim() !== '' && form.city.trim() !== '' && form.agencyId !== '';

  return (
    <form
      aria-label={t('inspection.booking.title')}
      className="space-y-2 rounded-md border border-border-subtle p-3"
      onSubmit={(event) => { event.preventDefault(); if (ready) book.mutate(); }}
    >
      <p className="text-sm font-medium">{t('inspection.booking.title')}</p>
      <p className="text-xs text-ink-muted">{t('inspection.booking.scopeNote')}</p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Input type="date" aria-label={t('inspection.booking.date')} value={form.date} onChange={(event) => { set({ date: event.target.value, agencyId: '' }); }} />
        <Select aria-label={t('inspection.booking.pointType')} value={form.pointType} onChange={(event) => { set({ pointType: event.target.value as BuyerBookingInput['inspectionPointType'] }); }}>
          {POINT_TYPES.map((type) => <option key={type} value={type}>{t(`inspection.booking.point.${type}`)}</option>)}
        </Select>
        <Input aria-label={t('inspection.booking.pointLabel')} placeholder={t('inspection.booking.pointLabel')} value={form.label} onChange={(event) => { set({ label: event.target.value }); }} />
        <Input aria-label={t('inspection.booking.address')} placeholder={t('inspection.booking.address')} value={form.addressLine} onChange={(event) => { set({ addressLine: event.target.value }); }} />
        <Input aria-label={t('inspection.booking.city')} placeholder={t('inspection.booking.city')} value={form.city} onChange={(event) => { set({ city: event.target.value }); }} />
        <Input aria-label={t('inspection.booking.country')} placeholder={t('inspection.booking.country')} maxLength={2} value={form.country} onChange={(event) => { set({ country: event.target.value, agencyId: '' }); }} />
        <Select aria-label={t('inspection.booking.payer')} value={buyerPaysOnly ? 'BUYER' : form.payer} disabled={buyerPaysOnly} onChange={(event) => { set({ payer: event.target.value as BuyerBookingInput['payer'] }); }}>
          <option value="BUYER">{t('inspection.booking.payerBuyer')}</option>
          {!buyerPaysOnly && <option value="SELLER">{t('inspection.booking.payerSeller')}</option>}
        </Select>
        <Select
          aria-label={t('inspection.booking.agency')}
          value={form.agencyId}
          disabled={agencies.data === undefined}
          onChange={(event) => { set({ agencyId: event.target.value }); }}
        >
          <option value="">{agencies.data === undefined ? t('inspection.booking.agencyFirst') : t('inspection.booking.agencyChoose')}</option>
          {(agencies.data ?? []).map((agency) => (
            <option key={agency.id} value={agency.id} disabled={!agency.eligible}>
              {agency.eligible ? agency.name : `${agency.name} (${agency.problems.map((code) => t(`inspection.booking.problem.${code}` as TranslationKey)).join(', ')})`}
            </option>
          ))}
        </Select>
      </div>
      {agencies.data?.length === 0 && <p className="text-xs text-ink-muted">{t('inspection.booking.noAgencies')}</p>}
      {buyerPaysOnly && <p className="text-xs text-ink-muted">{t('inspection.booking.buyerPays')}</p>}
      <Textarea aria-label={t('inspection.booking.notes')} placeholder={t('inspection.booking.notes')} rows={2} value={form.notes} onChange={(event) => { set({ notes: event.target.value }); }} />
      <div className="flex gap-2">
        <Button type="submit" size="sm" variant="primary" disabled={!ready || book.isPending}>{t('inspection.booking.submit')}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => { setOpen(false); }}>{t('inspection.booking.cancel')}</Button>
      </div>
    </form>
  );
}
