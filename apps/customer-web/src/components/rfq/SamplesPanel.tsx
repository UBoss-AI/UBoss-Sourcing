/**
 * Samples on a request for quotation (Master row 20), for either side.
 *
 * The buyer asks a supplier taking part for a sample and later confirms it
 * arrived and approves or rejects it; the supplier accepts (with any cost),
 * declines, or records the courier and tracking number when it ships. Each
 * button is offered only when the server says that side may take that step.
 * Payment for a sample is not collected here, and the panel says so rather
 * than showing it as paid.
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale } from '@/app/locale-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Select, Textarea } from '@/components/ui';
import { AttachmentList } from '@/components/rfq/RfqParts';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { api, newIdempotencyKey } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { currencyExponent, formatMoney, majorToMinor } from '@/lib/format';
import { rfqAttachmentUrl, uploadRfqAttachment, type RfqAttachment } from '@/lib/rfq';
import { formatUtc } from '@/lib/rfq-format';

export interface Sample {
  id: string;
  reference: string;
  sellerAccountId: string;
  supplierName: string;
  status: string;
  version: number;
  quantity: string;
  unitOfMeasure: string | null;
  deliveryAddress: string;
  requestedByDate: string | null;
  approvalCriteria: string;
  notes: string | null;
  cost: { minor: string; formatted: string; currency: string } | null;
  paymentStatus: 'NOT_REQUIRED' | 'PAYMENT_PENDING' | 'PAID';
  supplierNote: string | null;
  courier: string | null;
  trackingNumber: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  decisionReason: string | null;
  referenceCode: string | null;
  evidence: RfqAttachment[];
  actions: string[];
  createdAt: string;
}

const BUYER_VERBS: Record<string, string> = { CANCELLED: 'cancel', DELIVERED: 'receive', APPROVED: 'approve', REJECTED: 'reject' };
const SUPPLIER_VERBS: Record<string, string> = { ACCEPTED: 'accept', DECLINED: 'decline', SHIPPED: 'ship' };

export function SamplesPanel({
  party,
  rfqId,
  suppliers = [],
  canRequest = false,
  filesAvailable,
}: {
  party: 'BUYER' | 'SUPPLIER';
  rfqId: string;
  suppliers?: { sellerAccountId: string; displayName: string }[];
  canRequest?: boolean;
  filesAvailable: boolean;
}): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const base = party === 'BUYER' ? `/rfqs/${rfqId}/samples` : `/seller/rfqs/${rfqId}/samples`;
  const queryKey = ['rfq-samples', party, rfqId];
  const query = useQuery({ queryKey, queryFn: async () => (await api.get<{ samples: Sample[] }>(base)).samples });
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey });
  };

  const act = useMutation({
    mutationFn: ({ sample, to, body }: { sample: Sample; to: string; body: Record<string, unknown> }) =>
      api.post(`${base}/${sample.id}/${(party === 'BUYER' ? BUYER_VERBS : SUPPLIER_VERBS)[to] ?? ''}`, { expectedVersion: sample.version, ...body }),
    onSuccess: () => {
      toast.success(t('rfq.sample.updated'));
      refresh();
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
      refresh();
    },
  });

  if (query.isPending) return <LoadingState label={t('rfq.sample.loading')} />;
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

  return (
    <div className="space-y-4">
      {party === 'BUYER' && canRequest && suppliers.length > 0 && <SampleRequestForm rfqId={rfqId} suppliers={suppliers} onDone={refresh} />}
      {query.data.length === 0 ? (
        <EmptyState title={t('rfq.sample.none')} />
      ) : (
        query.data.map((sample) => (
          <Card key={sample.id} bodyClassName="space-y-3 px-6 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium text-ink">
                {sample.reference} · {sample.supplierName}
              </p>
              <Badge tone={sample.status === 'APPROVED' ? 'success' : sample.status === 'REJECTED' || sample.status === 'DECLINED' ? 'danger' : 'brand'}>
                {t(`rfq.sample.status.${sample.status}` as TranslationKey)}
              </Badge>
            </div>
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              <div>
                <dt className="inline text-ink-muted">{t('rfq.field.quantity')}: </dt>
                <dd className="inline text-ink">{sample.quantity}</dd>
              </div>
              <div>
                <dt className="inline text-ink-muted">{t('rfq.sample.address')}: </dt>
                <dd className="inline text-ink">{sample.deliveryAddress}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="inline text-ink-muted">{t('rfq.sample.criteria')}: </dt>
                <dd className="inline whitespace-pre-line text-ink">{sample.approvalCriteria}</dd>
              </div>
              <div>
                <dt className="inline text-ink-muted">{t('rfq.sample.cost')}: </dt>
                <dd className="inline text-ink">
                  {sample.cost === null ? t('rfq.sample.free') : formatMoney(sample.cost)}
                  {sample.paymentStatus === 'PAYMENT_PENDING' && <span className="block text-xs text-warning">{t('rfq.sample.paymentPending')}</span>}
                </dd>
              </div>
              {sample.courier !== null && (
                <div>
                  <dt className="inline text-ink-muted">{t('rfq.sample.shipment')}: </dt>
                  <dd className="inline text-ink">
                    {sample.courier} · {sample.trackingNumber} · {formatUtc(sample.shippedAt, intlLocale)}
                  </dd>
                </div>
              )}
              {sample.decisionReason !== null && (
                <div className="sm:col-span-2">
                  <dt className="inline text-ink-muted">{t('rfq.sample.reason')}: </dt>
                  <dd className="inline text-ink">{sample.decisionReason}</dd>
                </div>
              )}
              {sample.referenceCode !== null && (
                <div className="sm:col-span-2">
                  <dt className="inline text-ink-muted">{t('rfq.sample.referenceCode')}: </dt>
                  <dd className="inline font-mono text-ink">{sample.referenceCode}</dd>
                </div>
              )}
            </dl>
            <AttachmentList
              attachments={sample.evidence}
              hrefFor={(attachment) => rfqAttachmentUrl(party === 'BUYER' ? '/rfqs' : '/seller/rfqs', rfqId, attachment.id)}
            />
            {filesAvailable && !['DECLINED', 'CANCELLED'].includes(sample.status) && (
              <label className="inline-flex cursor-pointer text-sm font-medium text-brand">
                <input
                  type="file"
                  className="sr-only"
                  aria-label={t('rfq.sample.addEvidence', { reference: sample.reference })}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file === undefined) return;
                    void uploadRfqAttachment(`${base}/${sample.id}/attachments`, file)
                      .then(refresh)
                      .catch((error: unknown) => {
                        toast.error(errorMessage(t, error));
                      });
                  }}
                />
                {t('rfq.sample.addEvidenceShort')}
              </label>
            )}
            <SampleActions sample={sample} party={party} busy={act.isPending} onAct={(to, body) => { act.mutate({ sample, to, body }); }} />
          </Card>
        ))
      )}
    </div>
  );
}

function SampleActions({
  sample,
  party,
  busy,
  onAct,
}: {
  sample: Sample;
  party: 'BUYER' | 'SUPPLIER';
  busy: boolean;
  onAct: (to: string, body: Record<string, unknown>) => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const { currencies, currency: localeCurrency } = useLocale();
  const [reason, setReason] = useState('');
  const [cost, setCost] = useState('');
  const [currency, setCurrency] = useState(localeCurrency);
  const [courier, setCourier] = useState('');
  const [tracking, setTracking] = useState('');
  if (sample.actions.length === 0) return null;
  const needsReason = sample.actions.some((to) => to === 'REJECTED' || to === 'DECLINED');

  return (
    <div className="space-y-3 border-t border-border-subtle pt-3">
      {needsReason && (
        <Field label={t('rfq.sample.reasonLabel')}>
          {({ inputId }) => (
            <Textarea id={inputId} rows={2} maxLength={1000} value={reason} onChange={(event) => { setReason(event.target.value); }} />
          )}
        </Field>
      )}
      {party === 'SUPPLIER' && sample.actions.includes('ACCEPTED') && (
        <div className="grid grid-cols-[1fr_7rem] gap-2">
          <Field label={t('rfq.sample.costLabel')} hint={t('rfq.sample.costHint')}>
            {({ inputId, describedBy }) => (
              <Input id={inputId} aria-describedby={describedBy} inputMode="decimal" value={cost} onChange={(event) => { setCost(event.target.value); }} />
            )}
          </Field>
          <Field label={t('rfq.field.currency')}>
            {({ inputId }) => (
              <Select id={inputId} value={currency} onChange={(event) => { setCurrency(event.target.value); }}>
                {currencies.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.code}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      )}
      {party === 'SUPPLIER' && sample.actions.includes('SHIPPED') && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t('rfq.sample.courier')} required>
            {({ inputId }) => <Input id={inputId} value={courier} onChange={(event) => { setCourier(event.target.value); }} />}
          </Field>
          <Field label={t('rfq.sample.tracking')} required>
            {({ inputId }) => <Input id={inputId} value={tracking} onChange={(event) => { setTracking(event.target.value); }} />}
          </Field>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {sample.actions.map((to) => (
          <Button
            key={to}
            variant={to === 'APPROVED' || to === 'ACCEPTED' || to === 'SHIPPED' || to === 'DELIVERED' ? 'primary' : 'secondary'}
            disabled={busy}
            onClick={() => {
              const trimmed = reason.trim();
              if (to === 'ACCEPTED') {
                const minor = cost.trim().length === 0 ? null : majorToMinor(cost, currencyExponent(currency));
                onAct(to, { costMinor: minor, currency: minor === null ? null : currency, note: null });
              } else if (to === 'SHIPPED') {
                onAct(to, { courier: courier.trim(), trackingNumber: tracking.trim() });
              } else {
                onAct(to, { reason: trimmed.length === 0 ? null : trimmed });
              }
            }}
          >
            {t(`rfq.sample.action.${to}` as TranslationKey)}
          </Button>
        ))}
      </div>
    </div>
  );
}

function SampleRequestForm({
  rfqId,
  suppliers,
  onDone,
}: {
  rfqId: string;
  suppliers: { sellerAccountId: string; displayName: string }[];
  onDone: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const idempotency = useRef(newIdempotencyKey());
  const [values, setValues] = useState({
    sellerAccountId: suppliers[0]?.sellerAccountId ?? '',
    quantity: '',
    deliveryAddress: '',
    requestedByDate: '',
    approvalCriteria: '',
  });
  const set = (field: keyof typeof values, value: string): void => {
    setValues((current) => ({ ...current, [field]: value }));
  };
  const send = useMutation({
    mutationFn: () =>
      api.post(
        `/rfqs/${rfqId}/samples`,
        { ...values, requestedByDate: values.requestedByDate.length === 0 ? null : values.requestedByDate, quoteId: null, notes: null },
        { idempotencyKey: idempotency.current },
      ),
    onSuccess: () => {
      toast.success(t('rfq.sample.requested'));
      idempotency.current = newIdempotencyKey();
      setValues((current) => ({ ...current, quantity: '', approvalCriteria: '' }));
      onDone();
    },
    onError: (error) => {
      idempotency.current = newIdempotencyKey();
      toast.error(errorMessage(t, error));
    },
  });
  return (
    <Card title={t('rfq.sample.requestTitle')} bodyClassName="grid gap-4 px-6 py-4 sm:grid-cols-2">
      <Field label={t('rfq.detail.col.supplier')} required>
        {({ inputId }) => (
          <Select id={inputId} value={values.sellerAccountId} onChange={(event) => { set('sellerAccountId', event.target.value); }}>
            {suppliers.map((supplier) => (
              <option key={supplier.sellerAccountId} value={supplier.sellerAccountId}>
                {supplier.displayName}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('rfq.field.quantity')} required>
        {({ inputId }) => <Input id={inputId} inputMode="decimal" value={values.quantity} onChange={(event) => { set('quantity', event.target.value); }} />}
      </Field>
      <Field label={t('rfq.sample.address')} required>
        {({ inputId }) => <Textarea id={inputId} rows={2} value={values.deliveryAddress} onChange={(event) => { set('deliveryAddress', event.target.value); }} />}
      </Field>
      <Field label={t('rfq.sample.byDate')}>
        {({ inputId }) => <Input id={inputId} type="date" value={values.requestedByDate} onChange={(event) => { set('requestedByDate', event.target.value); }} />}
      </Field>
      <div className="sm:col-span-2">
        <Field label={t('rfq.sample.criteria')} required hint={t('rfq.sample.criteriaHint')}>
          {({ inputId, describedBy }) => (
            <Textarea id={inputId} aria-describedby={describedBy} rows={3} value={values.approvalCriteria} onChange={(event) => { set('approvalCriteria', event.target.value); }} />
          )}
        </Field>
      </div>
      <div>
        <Button variant="primary" isLoading={send.isPending} onClick={() => { send.mutate(); }}>
          {t('rfq.sample.send')}
        </Button>
      </div>
    </Card>
  );
}
