/**
 * The terms frozen on each line of a seller order when it was placed (Doc 08),
 * and the controls the seller can still record while the order is NEW.
 *
 * Payment is not acceptance: the acceptance gate may refuse to accept an order
 * until every gap listed here is closed, so the gaps are spelt out in words
 * rather than codes.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, Field, Input, Select, Textarea } from '@/components/ui';
import { useI18n, type Translate, type TranslationKey } from '@/i18n/i18n-context';
import {
  bpsToPercent,
  commercialKeys,
  fetchSellerControls,
  gapLabel,
  gapsOf,
  saveSellerControls,
  type CommercialLine,
  type ControlsInput,
} from '@/lib/commercial-policy';
import { errorMessage } from '@/lib/errors';
import { currencyExponent, formatMoneyMinor, humanise, majorToMinor } from '@/lib/format';
import type { SellerOrderDetail } from '@/lib/seller';

const importerLabel = (t: Translate, value: string): string =>
  t(`commercial.importer.${value}` as TranslationKey, { defaultValue: humanise(value) });

function Fact({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="text-sm text-ink">{value}</dd>
    </div>
  );
}

function LineTerms({ line, name }: { line: CommercialLine; name: string }): React.JSX.Element {
  const { t } = useI18n();
  const dash = '—';
  const gaps = gapsOf(line);
  return (
    <li className="space-y-3 px-6 py-4">
      <p className="font-medium text-ink">{name}</p>
      <dl className="grid gap-3 sm:grid-cols-3">
        <Fact label={t('commercial.terms.seller')} value={line.sellerAccountId === null ? t('commercial.terms.operatorLine') : t('commercial.terms.you')} />
        <Fact label={t('commercial.terms.manufacturer')} value={line.manufacturerName ?? dash} />
        <Fact label={t('commercial.terms.versionSite')} value={`${line.productVersion ?? dash} · ${line.facilityRef ?? dash}`} />
        <Fact label={t('commercial.terms.country')} value={`${line.sellerCountry ?? dash} → ${line.destinationCountry}`} />
        <Fact label={t('commercial.terms.channel')} value={line.channel} />
        <Fact label={t('commercial.terms.deliveryTerm')} value={line.namedPlace === null ? line.deliveryTerm : `${line.deliveryTerm} · ${line.namedPlace}`} />
        <Fact label={t('commercial.terms.importer')} value={importerLabel(t, line.importerOfRecord)} />
        <Fact label={t('commercial.terms.commissionRate')} value={bpsToPercent(line.commissionBps)} />
        <Fact label={t('commercial.terms.commissionBase')} value={formatMoneyMinor(line.commissionBaseMinor, line.currency)} />
        <Fact label={t('commercial.terms.commissionAmount')} value={formatMoneyMinor(line.commissionMinor, line.currency)} />
        <Fact label={t('commercial.terms.source')} value={humanise(line.commissionSource)} />
        <Fact label={t('commercial.terms.ruleVersion')} value={line.commissionRuleVersion ?? dash} />
        <Fact label={t('commercial.terms.rounding')} value={humanise(line.rounding)} />
      </dl>
      {gaps.length > 0 ? (
        <div className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm">
          <p className="font-medium text-ink">{t('commercial.terms.gapsTitle')}</p>
          <ul className="mt-1 list-disc pl-5">
            {gaps.map((gap) => (
              <li key={gap}>{gapLabel(t, gap)}</li>
            ))}
          </ul>
        </div>
      ) : (
        <Badge tone="success">{t('commercial.terms.noGaps')}</Badge>
      )}
    </li>
  );
}

interface ControlsDraft {
  returnRoute: string;
  packagingNote: string;
  transportReviewed: boolean;
  insuranceDecided: boolean;
  insuranceArrangement: string;
  insuredValue: string;
  namedPlace: string;
  leadTimeDays: string;
  technicalAcceptanceDays: string;
  titleTransferPoint: string;
  riskTransferPoint: string;
  election: '' | 'FCA' | 'DDP';
  approvalReference: string;
}

const EMPTY: ControlsDraft = {
  returnRoute: '',
  packagingNote: '',
  transportReviewed: false,
  insuranceDecided: false,
  insuranceArrangement: '',
  insuredValue: '',
  namedPlace: '',
  leadTimeDays: '',
  technicalAcceptanceDays: '',
  titleTransferPoint: '',
  riskTransferPoint: '',
  election: '',
  approvalReference: '',
};

/** Only what the seller filled in: a blank field leaves the recorded value alone. */
function toInput(d: ControlsDraft, currency: string): ControlsInput {
  const text = (value: string): string | undefined => (value.trim() === '' ? undefined : value.trim());
  const int = (value: string): number | undefined => (value.trim() === '' ? undefined : Number.parseInt(value, 10));
  const input: ControlsInput = {};
  const assign = <K extends keyof ControlsInput>(key: K, value: ControlsInput[K] | undefined): void => {
    if (value !== undefined) input[key] = value;
  };
  assign('returnRoute', text(d.returnRoute));
  assign('packagingNote', text(d.packagingNote));
  if (d.transportReviewed) input.transportRestrictionsReviewed = true;
  if (d.insuranceDecided) {
    input.insurance = {
      decided: true,
      arrangement: d.insuranceArrangement.trim(),
      insuredValueMinor: d.insuredValue.trim() === '' ? null : majorToMinor(d.insuredValue, currencyExponent(currency)),
    };
  }
  assign('namedPlace', text(d.namedPlace));
  assign('leadTimeDays', int(d.leadTimeDays));
  assign('technicalAcceptanceDays', int(d.technicalAcceptanceDays));
  assign('titleTransferPoint', text(d.titleTransferPoint));
  assign('riskTransferPoint', text(d.riskTransferPoint));
  if (d.election !== '') input.election = { term: d.election, approvalReference: d.approvalReference.trim() };
  return input;
}

function ControlsDialog({ orderId, currency, onClose }: { orderId: string; currency: string; onClose: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [d, setD] = useState<ControlsDraft>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<ControlsDraft>): void => {
    setD((current) => ({ ...current, ...patch }));
  };
  const save = useMutation({
    mutationFn: () => saveSellerControls(orderId, toInput(d, currency)),
    onSuccess: async () => {
      toast.success(t('commercial.terms.saved'));
      await queryClient.invalidateQueries({ queryKey: commercialKeys.sellerControls(orderId) });
      onClose();
    },
    onError: (failure) => { setError(errorMessage(t, failure)); },
  });
  const text = (key: keyof ControlsDraft, label: TranslationKey, multiline = false): React.JSX.Element => (
    <Field label={t(label)}>
      {({ inputId }) =>
        multiline ? (
          <Textarea id={inputId} rows={2} value={String(d[key])} onChange={(event) => { set({ [key]: event.target.value }); }} />
        ) : (
          <Input id={inputId} value={String(d[key])} onChange={(event) => { set({ [key]: event.target.value }); }} />
        )
      }
    </Field>
  );
  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title={t('commercial.terms.formTitle')}
      description={t('commercial.terms.formHint')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" isLoading={save.isPending} onClick={() => { setError(null); save.mutate(); }}>{t('common.save')}</Button>
        </>
      }
    >
      <div className="space-y-4">
        {text('returnRoute', 'commercial.terms.returnRoute', true)}
        {text('packagingNote', 'commercial.terms.packagingNote', true)}
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={d.transportReviewed} onChange={(event) => { set({ transportReviewed: event.target.checked }); }} />
          <span>{t('commercial.terms.transportReviewed')}</span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={d.insuranceDecided} onChange={(event) => { set({ insuranceDecided: event.target.checked }); }} />
          <span>{t('commercial.terms.insuranceDecided')}</span>
        </label>
        {d.insuranceDecided && (
          <div className="grid gap-4 sm:grid-cols-2">
            {text('insuranceArrangement', 'commercial.terms.insuranceArrangement')}
            <Field label={t('commercial.terms.insuredValue', { currency })}>
              {({ inputId }) => <Input id={inputId} inputMode="decimal" value={d.insuredValue} onChange={(event) => { set({ insuredValue: event.target.value }); }} />}
            </Field>
          </div>
        )}
        {text('namedPlace', 'commercial.terms.namedPlace')}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('commercial.terms.leadTimeDays')}>
            {({ inputId }) => <Input id={inputId} inputMode="numeric" value={d.leadTimeDays} onChange={(event) => { set({ leadTimeDays: event.target.value.replace(/\D/g, '') }); }} />}
          </Field>
          <Field label={t('commercial.terms.technicalAcceptanceDays')}>
            {({ inputId }) => <Input id={inputId} inputMode="numeric" value={d.technicalAcceptanceDays} onChange={(event) => { set({ technicalAcceptanceDays: event.target.value.replace(/\D/g, '') }); }} />}
          </Field>
          {text('titleTransferPoint', 'commercial.terms.titleTransferPoint')}
          {text('riskTransferPoint', 'commercial.terms.riskTransferPoint')}
          <Field label={t('commercial.terms.election')} hint={t('commercial.terms.electionHint')}>
            {({ inputId, describedBy }) => (
              <Select id={inputId} aria-describedby={describedBy} value={d.election} onChange={(event) => { set({ election: event.target.value as ControlsDraft['election'] }); }}>
                <option value="">{t('commercial.terms.electionNone')}</option>
                <option value="FCA">FCA</option>
                <option value="DDP">DDP</option>
              </Select>
            )}
          </Field>
          {d.election !== '' && text('approvalReference', 'commercial.terms.approvalReference')}
        </div>
        {error !== null && (
          <p role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">{error}</p>
        )}
      </div>
    </Modal>
  );
}

export function SellerOrderTermsCard({ order }: { order: SellerOrderDetail }): React.JSX.Element | null {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const query = useQuery({ queryKey: commercialKeys.sellerControls(order.id), queryFn: () => fetchSellerControls(order.id) });
  if (query.isPending || query.isError) return null;
  const controls = query.data;
  if (controls.lines.length === 0) return null;
  const names = new Map(order.lines.map((line) => [line.orderItemId, line.productName]));
  return (
    <Card
      title={t('commercial.terms.title')}
      description={t('commercial.terms.paymentIsNotAcceptance')}
      actions={
        controls.editable ? (
          <Button variant="secondary" size="sm" onClick={() => { setEditing(true); }}>
            {t('commercial.terms.record')}
          </Button>
        ) : undefined
      }
    >
      <ul className="divide-y divide-border">
        {controls.lines.map((line) => (
          <LineTerms key={line.id} line={line} name={names.get(line.orderItemId) ?? line.orderItemId} />
        ))}
      </ul>
      {editing && <ControlsDialog orderId={order.id} currency={order.currency} onClose={() => { setEditing(false); }} />}
    </Card>
  );
}
