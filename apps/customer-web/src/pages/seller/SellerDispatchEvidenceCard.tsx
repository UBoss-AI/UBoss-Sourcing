/**
 * What a seller order still needs before it may be dispatched (Doc 07): the
 * gaps, the customs documents and the handling requirements, with the three
 * records that close them - dispatch evidence, a custody handover and the
 * freight booking.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, Field, Input, Textarea } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { newIdempotencyKey } from '@/lib/api';
import {
  commercialKeys,
  fetchSellerDispatch,
  gapLabel,
  recordCustodyHandover,
  saveDispatchEvidence,
  saveFreightBooking,
  type DispatchEvidenceInput,
  type FreightBookingInput,
} from '@/lib/commercial-policy';
import { errorMessage } from '@/lib/errors';
import { currencyExponent, humanise, majorToMinor } from '@/lib/format';
import type { SellerOrderDetail } from '@/lib/seller';

type Dialog = 'evidence' | 'custody' | 'freight' | null;

const list = (value: string): string[] =>
  value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');

const whole = (value: string): number => Number.parseInt(value === '' ? '0' : value, 10);
const digits = (value: string): string => value.replace(/\D/g, '');

function useSave<T>(orderId: string, run: () => Promise<T>, onDone: () => void, setError: (message: string | null) => void) {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: async () => {
      toast.success(t('commercial.dispatch.saved'));
      await queryClient.invalidateQueries({ queryKey: commercialKeys.sellerDispatch(orderId) });
      onDone();
    },
    onError: (failure) => { setError(errorMessage(t, failure)); },
  });
}

function DialogFrame({ title, description, busy, onClose, onSave, error, children }: { title: string; description?: string; busy: boolean; onClose: () => void; onSave: () => void; error: string | null; children: React.ReactNode }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Modal
      isOpen
      size="lg"
      onClose={onClose}
      title={title}
      {...(description === undefined ? {} : { description })}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" isLoading={busy} onClick={onSave}>{t('common.save')}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {children}
        {error !== null && (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">{error}</p>
        )}
      </div>
    </Modal>
  );
}

function EvidenceDialog({ order, requirements, onClose }: { order: SellerOrderDetail; requirements: string[]; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>(() => Object.fromEntries(order.lines.map((line) => [line.orderItemId, String(line.quantity)])));
  const [lots, setLots] = useState<Record<string, string>>({});
  const [serials, setSerials] = useState<Record<string, string>>({});
  const [seals, setSeals] = useState('');
  const [photos, setPhotos] = useState('');
  const [temperature, setTemperature] = useState('');
  const [handling, setHandling] = useState<Record<string, string>>({});
  const build = (): DispatchEvidenceInput => ({
    quantities: order.lines.map((line) => ({ orderItemId: line.orderItemId, quantity: whole(quantities[line.orderItemId] ?? '0') })),
    lots: order.lines.flatMap((line) => [
      ...list(lots[line.orderItemId] ?? '').map((lot) => ({ orderItemId: line.orderItemId, lot })),
      ...list(serials[line.orderItemId] ?? '').map((serial) => ({ orderItemId: line.orderItemId, serial })),
    ]),
    seals: list(seals),
    packingPhotoRefs: list(photos),
    temperatureLogRef: temperature.trim() === '' ? null : temperature.trim(),
    handlingEvidence: requirements
      .filter((kind) => (handling[kind] ?? '').trim() !== '')
      .map((kind) => ({ kind, evidence: (handling[kind] ?? '').trim() })),
  });
  const save = useSave(order.id, () => saveDispatchEvidence(order.id, build()), onClose, setError);
  return (
    <DialogFrame title={t('commercial.dispatch.evidenceTitle')} busy={save.isPending} onClose={onClose} onSave={() => { setError(null); save.mutate(); }} error={error}>
      {order.lines.map((line) => (
        <fieldset key={line.id} className="space-y-3 rounded-md border border-border px-4 py-3">
          <legend className="px-1 text-sm font-medium text-ink">{line.productName}</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('commercial.dispatch.quantity')}>
              {({ inputId }) => <Input id={inputId} inputMode="numeric" value={quantities[line.orderItemId] ?? ''} onChange={(event) => { setQuantities((c) => ({ ...c, [line.orderItemId]: digits(event.target.value) })); }} />}
            </Field>
            <Field label={t('commercial.dispatch.lots')}>
              {({ inputId }) => <Input id={inputId} value={lots[line.orderItemId] ?? ''} onChange={(event) => { setLots((c) => ({ ...c, [line.orderItemId]: event.target.value })); }} />}
            </Field>
            <Field label={t('commercial.dispatch.serials')}>
              {({ inputId }) => <Input id={inputId} value={serials[line.orderItemId] ?? ''} onChange={(event) => { setSerials((c) => ({ ...c, [line.orderItemId]: event.target.value })); }} />}
            </Field>
          </div>
        </fieldset>
      ))}
      <p className="text-xs text-ink-muted">{t('commercial.dispatch.commaHint')}</p>
      <Field label={t('commercial.dispatch.seals')}>
        {({ inputId }) => <Input id={inputId} value={seals} onChange={(event) => { setSeals(event.target.value); }} />}
      </Field>
      <Field label={t('commercial.dispatch.photos')}>
        {({ inputId }) => <Textarea id={inputId} rows={2} value={photos} onChange={(event) => { setPhotos(event.target.value); }} />}
      </Field>
      <Field label={t('commercial.dispatch.temperature')}>
        {({ inputId }) => <Input id={inputId} value={temperature} onChange={(event) => { setTemperature(event.target.value); }} />}
      </Field>
      {requirements.map((kind) => (
        <Field key={kind} label={t('commercial.dispatch.handlingEvidence', { requirement: t(`commercial.handling.${kind}` as TranslationKey, { defaultValue: humanise(kind) }) })}>
          {({ inputId }) => <Textarea id={inputId} rows={2} value={handling[kind] ?? ''} onChange={(event) => { setHandling((c) => ({ ...c, [kind]: event.target.value })); }} />}
        </Field>
      ))}
    </DialogFrame>
  );
}

function CustodyDialog({ orderId, onClose }: { orderId: string; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [key] = useState(newIdempotencyKey);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [place, setPlace] = useState('');
  const [at, setAt] = useState('');
  const [packages, setPackages] = useState('1');
  const [sealsIntact, setSealsIntact] = useState(true);
  const [note, setNote] = useState('');
  const save = useSave(
    orderId,
    () =>
      recordCustodyHandover(
        orderId,
        {
          fromParty: from.trim(),
          toParty: to.trim(),
          place: place.trim(),
          handedOverAt: at === '' ? new Date().toISOString() : new Date(at).toISOString(),
          packages: whole(packages),
          sealsIntact,
          exceptionNote: note.trim() === '' ? null : note.trim(),
        },
        key,
      ),
    onClose,
    setError,
  );
  return (
    <DialogFrame title={t('commercial.dispatch.custodyTitle')} busy={save.isPending} onClose={onClose} onSave={() => { setError(null); save.mutate(); }} error={error}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('commercial.dispatch.fromParty')} required>
          {({ inputId }) => <Input id={inputId} value={from} onChange={(event) => { setFrom(event.target.value); }} />}
        </Field>
        <Field label={t('commercial.dispatch.toParty')} required>
          {({ inputId }) => <Input id={inputId} value={to} onChange={(event) => { setTo(event.target.value); }} />}
        </Field>
        <Field label={t('commercial.dispatch.place')} required>
          {({ inputId }) => <Input id={inputId} value={place} onChange={(event) => { setPlace(event.target.value); }} />}
        </Field>
        <Field label={t('commercial.dispatch.handedOverAt')}>
          {({ inputId }) => <Input id={inputId} type="datetime-local" value={at} onChange={(event) => { setAt(event.target.value); }} />}
        </Field>
        <Field label={t('commercial.dispatch.packages')}>
          {({ inputId }) => <Input id={inputId} inputMode="numeric" value={packages} onChange={(event) => { setPackages(digits(event.target.value)); }} />}
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={sealsIntact} onChange={(event) => { setSealsIntact(event.target.checked); }} />
        {t('commercial.dispatch.sealsIntact')}
      </label>
      <Field label={t('commercial.dispatch.exceptionNote')}>
        {({ inputId }) => <Textarea id={inputId} rows={2} value={note} onChange={(event) => { setNote(event.target.value); }} />}
      </Field>
    </DialogFrame>
  );
}

interface QuoteRow {
  providerName: string;
  amount: string;
  transitMin: string;
  transitMax: string;
  comparable: boolean;
  reference: string;
}

const EMPTY_QUOTE: QuoteRow = { providerName: '', amount: '', transitMin: '', transitMax: '', comparable: true, reference: '' };

function FreightDialog({ orderId, currency, onClose }: { orderId: string; currency: string; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [lane, setLane] = useState('');
  const [weight, setWeight] = useState('');
  const [dims, setDims] = useState({ lengthMm: '', widthMm: '', heightMm: '', packages: '1' });
  const [packaging, setPackaging] = useState('');
  const [hazard, setHazard] = useState('');
  const [legs, setLegs] = useState([{ leg: '', responsible: '' }]);
  const [returnCapability, setReturnCapability] = useState('');
  const [quotes, setQuotes] = useState<QuoteRow[]>([{ ...EMPTY_QUOTE }]);
  const [selected, setSelected] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const exponent = currencyExponent(currency);
  const optionalInt = (value: string): number | null => (value === '' ? null : whole(value));
  const build = (): FreightBookingInput => {
    const kept = quotes.filter((q) => q.providerName.trim() !== '' && q.amount.trim() !== '');
    return {
      lane: lane.trim(),
      grossWeightGrams: whole(weight),
      dimensions: { lengthMm: whole(dims.lengthMm), widthMm: whole(dims.widthMm), heightMm: whole(dims.heightMm), packages: whole(dims.packages) },
      packaging: packaging.trim(),
      hazardClass: hazard.trim() === '' ? null : hazard.trim(),
      custody: legs.filter((l) => l.leg.trim() !== '' && l.responsible.trim() !== '').map((l) => ({ leg: l.leg.trim(), responsible: l.responsible.trim() })),
      returnCapability: returnCapability.trim() === '' ? null : returnCapability.trim(),
      singleSourceReason: reason.trim() === '' ? null : reason.trim(),
      quotes: kept.map((q) => ({
        providerName: q.providerName.trim(),
        amountMinor: majorToMinor(q.amount, exponent) ?? '0',
        currency,
        transitDaysMin: optionalInt(q.transitMin),
        transitDaysMax: optionalInt(q.transitMax),
        comparable: q.comparable,
        reference: q.reference.trim() === '' ? null : q.reference.trim(),
      })),
      selectedIndex: selected !== null && selected < kept.length ? selected : null,
    };
  };
  const save = useSave(orderId, () => saveFreightBooking(orderId, build()), onClose, setError);
  const setQuote = (index: number, patch: Partial<QuoteRow>): void => {
    setQuotes((current) => current.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  };
  return (
    <DialogFrame title={t('commercial.dispatch.freightTitle')} description={t('commercial.dispatch.quotesHint')} busy={save.isPending} onClose={onClose} onSave={() => { setError(null); save.mutate(); }} error={error}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('commercial.dispatch.lane')} required>
          {({ inputId }) => <Input id={inputId} value={lane} onChange={(event) => { setLane(event.target.value); }} />}
        </Field>
        <Field label={t('commercial.dispatch.weightGrams')} required>
          {({ inputId }) => <Input id={inputId} inputMode="numeric" value={weight} onChange={(event) => { setWeight(digits(event.target.value)); }} />}
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        {(['lengthMm', 'widthMm', 'heightMm', 'packages'] as const).map((field) => (
          <Field key={field} label={t(`commercial.dispatch.${field}` as TranslationKey)}>
            {({ inputId }) => <Input id={inputId} inputMode="numeric" value={dims[field]} onChange={(event) => { setDims((c) => ({ ...c, [field]: digits(event.target.value) })); }} />}
          </Field>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('commercial.dispatch.packaging')} required>
          {({ inputId }) => <Input id={inputId} value={packaging} onChange={(event) => { setPackaging(event.target.value); }} />}
        </Field>
        <Field label={t('commercial.dispatch.hazardClass')}>
          {({ inputId }) => <Input id={inputId} value={hazard} onChange={(event) => { setHazard(event.target.value); }} />}
        </Field>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">{t('commercial.dispatch.custodyLegs')}</legend>
        {legs.map((leg, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-2">
            <Input aria-label={t('commercial.dispatch.legName')} placeholder={t('commercial.dispatch.legName')} value={leg.leg} onChange={(event) => { setLegs((c) => c.map((l, i) => (i === index ? { ...l, leg: event.target.value } : l))); }} />
            <Input aria-label={t('commercial.dispatch.legResponsible')} placeholder={t('commercial.dispatch.legResponsible')} value={leg.responsible} onChange={(event) => { setLegs((c) => c.map((l, i) => (i === index ? { ...l, responsible: event.target.value } : l))); }} />
          </div>
        ))}
        {legs.length < 10 && (
          <Button variant="ghost" size="sm" onClick={() => { setLegs((c) => [...c, { leg: '', responsible: '' }]); }}>{t('commercial.dispatch.addLeg')}</Button>
        )}
      </fieldset>
      <Field label={t('commercial.dispatch.returnCapability')}>
        {({ inputId }) => <Input id={inputId} value={returnCapability} onChange={(event) => { setReturnCapability(event.target.value); }} />}
      </Field>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-ink">{t('commercial.dispatch.quotes')}</legend>
        {quotes.map((quote, index) => (
          <div key={index} className="space-y-2 rounded-md border border-border px-3 py-3">
            <div className="grid gap-2 sm:grid-cols-3">
              <Input aria-label={t('commercial.dispatch.provider')} placeholder={t('commercial.dispatch.provider')} value={quote.providerName} onChange={(event) => { setQuote(index, { providerName: event.target.value }); }} />
              <Input aria-label={t('commercial.dispatch.quoteAmount', { currency })} placeholder={t('commercial.dispatch.quoteAmount', { currency })} inputMode="decimal" value={quote.amount} onChange={(event) => { setQuote(index, { amount: event.target.value }); }} />
              <Input aria-label={t('commercial.dispatch.quoteReference')} placeholder={t('commercial.dispatch.quoteReference')} value={quote.reference} onChange={(event) => { setQuote(index, { reference: event.target.value }); }} />
              <Input aria-label={t('commercial.dispatch.transitMin')} placeholder={t('commercial.dispatch.transitMin')} inputMode="numeric" value={quote.transitMin} onChange={(event) => { setQuote(index, { transitMin: digits(event.target.value) }); }} />
              <Input aria-label={t('commercial.dispatch.transitMax')} placeholder={t('commercial.dispatch.transitMax')} inputMode="numeric" value={quote.transitMax} onChange={(event) => { setQuote(index, { transitMax: digits(event.target.value) }); }} />
            </div>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={quote.comparable} onChange={(event) => { setQuote(index, { comparable: event.target.checked }); }} />
                {t('commercial.dispatch.comparable')}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" name="selected-quote" checked={selected === index} onChange={() => { setSelected(index); }} />
                {t('commercial.dispatch.selectQuote')}
              </label>
            </div>
          </div>
        ))}
        {quotes.length < 10 && (
          <Button variant="ghost" size="sm" onClick={() => { setQuotes((c) => [...c, { ...EMPTY_QUOTE }]); }}>{t('commercial.dispatch.addQuote')}</Button>
        )}
      </fieldset>
      <Field label={t('commercial.dispatch.singleSourceReason')}>
        {({ inputId }) => <Textarea id={inputId} rows={2} value={reason} onChange={(event) => { setReason(event.target.value); }} />}
      </Field>
    </DialogFrame>
  );
}

export function SellerDispatchEvidenceCard({ order }: { order: SellerOrderDetail }): React.JSX.Element | null {
  const { t } = useI18n();
  const [dialog, setDialog] = useState<Dialog>(null);
  const query = useQuery({ queryKey: commercialKeys.sellerDispatch(order.id), queryFn: () => fetchSellerDispatch(order.id) });
  if (query.isPending || query.isError) return null;
  const c = query.data;
  const canAct = order.status !== 'CANCELLED';
  const close = (): void => { setDialog(null); };
  return (
    <Card title={t('commercial.dispatch.title')} bodyClassName="space-y-4 px-6 py-5 text-sm">
      {c.gaps.length > 0 ? (
        <div className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2">
          <p className="font-medium text-ink">{t('commercial.dispatch.gapsTitle')}</p>
          <ul className="mt-1 list-disc pl-5">
            {c.gaps.map((gap) => <li key={gap}>{gapLabel(t, gap)}</li>)}
          </ul>
        </div>
      ) : (
        <Badge tone="success">{t('commercial.dispatch.noGaps')}</Badge>
      )}
      {c.requirements.length > 0 && (
        <div>
          <p className="font-medium text-ink">{t('commercial.dispatch.requirements')}</p>
          <ul className="mt-1 list-disc pl-5">
            {c.requirements.map((kind) => <li key={kind}>{t(`commercial.handling.${kind}` as TranslationKey, { defaultValue: humanise(kind) })}</li>)}
          </ul>
        </div>
      )}
      {c.documents.length > 0 && (
        <div>
          <p className="font-medium text-ink">{t('commercial.dispatch.documents')}</p>
          <ul className="mt-1 divide-y divide-border">
            {c.documents.map((doc) => (
              <li key={doc.kind} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>
                  {t(`commercial.customsDoc.${doc.kind}` as TranslationKey, { defaultValue: humanise(doc.kind) })}
                  {doc.requiredBeforeDispatch && <span className="text-ink-muted"> · {t('commercial.dispatch.requiredBeforeDispatch')}</span>}
                </span>
                <Badge tone={doc.status === 'VALID' ? 'success' : doc.status === 'MISSING' ? 'neutral' : 'warning'}>
                  {t(`commercial.docStatus.${doc.status}` as TranslationKey, { defaultValue: humanise(doc.status) })}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-ink-muted">
        {t('commercial.dispatch.recorded', {
          handovers: String(c.custodyCount),
          booking: c.hasBooking ? t('commercial.dispatch.bookingYes') : t('commercial.dispatch.bookingNo'),
        })}
      </p>
      {canAct && (
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onClick={() => { setDialog('evidence'); }}>{t('commercial.dispatch.evidenceTitle')}</Button>
          <Button variant="secondary" size="sm" onClick={() => { setDialog('custody'); }}>{t('commercial.dispatch.custodyTitle')}</Button>
          <Button variant="secondary" size="sm" onClick={() => { setDialog('freight'); }}>{t('commercial.dispatch.freightTitle')}</Button>
        </div>
      )}
      {dialog === 'evidence' && <EvidenceDialog order={order} requirements={c.requirements} onClose={close} />}
      {dialog === 'custody' && <CustodyDialog orderId={order.id} onClose={close} />}
      {dialog === 'freight' && <FreightDialog orderId={order.id} currency={order.currency} onClose={close} />}
    </Card>
  );
}
