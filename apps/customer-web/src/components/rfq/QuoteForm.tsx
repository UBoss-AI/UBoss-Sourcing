/**
 * The seller's quote on a request for quotation (Master row 18).
 *
 * Prices are typed in major units and sent as minor-unit strings, converted
 * by digit shifting in the chosen currency's exponent, never through a float.
 * A term left empty is sent as null and the buyer reads "Not provided".
 */
import { useState } from 'react';
import { EXPORT_DOCUMENTS, type ExportDocument } from '@/lib/rfq-quote';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocale } from '@/app/locale-context';
import { useToast } from '@/components/toast-context';
import { Button, ErrorSummary, Field, Input, Select, Textarea } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { currencyExponent, majorToMinor } from '@/lib/format';
import { fromDeadlineInput, type RfqRequirement } from '@/lib/rfq';
import { submitSellerQuote, uploadSellerRfqFile, type QuoteInput } from '@/lib/rfq-quote';

const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];

export function QuoteForm({
  rfqId,
  requirement,
  filesAvailable,
}: {
  rfqId: string;
  requirement: RfqRequirement;
  filesAvailable: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { currencies, currency: localeCurrency } = useLocale();
  const [values, setValues] = useState<Record<string, string>>({
    currency: requirement.targetCurrency ?? localeCurrency,
    unitPrice: '',
    quantity: requirement.quantity ?? '',
    moq: '',
    leadTimeDays: '',
    capacityPerMonth: '',
    incoterm: requirement.incoterm ?? '',
    incotermPlace: requirement.destinationPort ?? '',
    paymentTerms: '',
    inspectionTerms: '',
    warranty: '',
    tooling: '',
    sampleCost: '',
    shippingEstimate: '',
    taxesDisclosure: '',
    comment: '',
    expiresAt: '',
  });
  const [tiers, setTiers] = useState<{ minQuantity: string; price: string }[]>([]);
  // The export documents promised with this quote (JOURNEY-016).
  const [documents, setDocuments] = useState<ExportDocument[]>([]);
  const [files, setFiles] = useState<{ id: string; name: string }[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const set = (field: string, value: string): void => {
    setValues((current) => ({ ...current, [field]: value }));
  };
  const exponent = (): number => {
    try {
      return currencyExponent(values['currency'] ?? '');
    } catch {
      return 2;
    }
  };
  const minor = (text: string): string | null => (text.trim().length === 0 ? null : majorToMinor(text, exponent()));
  const orNull = (text: string | undefined): string | null => (text === undefined || text.trim().length === 0 ? null : text.trim());

  const build = (): { input: QuoteInput | null; problems: Record<string, string> } => {
    const problems: Record<string, string> = {};
    const unitPriceMinor = minor(values['unitPrice'] ?? '');
    if (unitPriceMinor === null || unitPriceMinor === '0') problems['unitPriceMinor'] = t('rfq.fieldError.PRICE');
    for (const [field, key] of [['tooling', 'toolingMinor'], ['sampleCost', 'sampleCostMinor'], ['shippingEstimate', 'shippingEstimateMinor']] as const) {
      if ((values[field] ?? '').trim().length > 0 && minor(values[field] ?? '') === null) problems[key] = t('rfq.fieldError.PRICE');
    }
    if (!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,3})?$/.test(values['quantity'] ?? '')) problems['quantity'] = t('rfq.fieldError.QUANTITY');
    const expiresAt = fromDeadlineInput(values['expiresAt'] ?? '');
    if (expiresAt === null) problems['expiresAt'] = t('rfq.fieldError.REQUIRED');
    else if (new Date(expiresAt).getTime() <= Date.now()) problems['expiresAt'] = t('rfq.fieldError.IN_PAST');
    const tierRows = tiers.map((tier) => ({ minQuantity: tier.minQuantity.trim(), unitPriceMinor: minor(tier.price) }));
    if (tierRows.some((tier) => tier.unitPriceMinor === null || tier.minQuantity.length === 0)) problems['tiers'] = t('rfq.fieldError.INVALID');
    const leadTime = orNull(values['leadTimeDays']);
    if (Object.keys(problems).length > 0 || unitPriceMinor === null || expiresAt === null) return { input: null, problems };
    return {
      problems,
      input: {
        currency: values['currency'] ?? '',
        unitPriceMinor,
        quantity: values['quantity'] ?? '',
        moq: orNull(values['moq']),
        leadTimeDays: leadTime === null ? null : Number.parseInt(leadTime, 10),
        capacityPerMonth: orNull(values['capacityPerMonth']),
        incoterm: orNull(values['incoterm']),
        incotermPlace: orNull(values['incotermPlace']),
        paymentTerms: orNull(values['paymentTerms']),
        inspectionTerms: orNull(values['inspectionTerms']),
        warranty: orNull(values['warranty']),
        toolingMinor: minor(values['tooling'] ?? ''),
        sampleCostMinor: minor(values['sampleCost'] ?? ''),
        shippingEstimateMinor: minor(values['shippingEstimate'] ?? ''),
        taxesDisclosure: orNull(values['taxesDisclosure']),
        tiers: tierRows.map((tier) => ({ minQuantity: tier.minQuantity, unitPriceMinor: tier.unitPriceMinor ?? '' })),
        exportDocuments: EXPORT_DOCUMENTS.filter((code) => documents.includes(code)),
        comment: orNull(values['comment']),
        expiresAt,
        attachmentIds: files.map((file) => file.id),
      },
    };
  };

  const submit = useMutation({
    mutationFn: (input: QuoteInput) => submitSellerQuote(rfqId, input),
    onSuccess: () => {
      toast.success(t('rfq.quote.sent'));
      void queryClient.invalidateQueries({ queryKey: ['seller', 'rfq', rfqId] });
      void queryClient.invalidateQueries({ queryKey: ['seller', 'rfq-quote', rfqId] });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.details.length > 0) {
        const next: Record<string, string> = {};
        for (const detail of error.details) {
          if (detail.field !== undefined) {
            next[detail.field] = t(`rfq.fieldError.${detail.code ?? 'INVALID'}` as TranslationKey, { days: '', defaultValue: t('rfq.fieldError.INVALID') });
          }
        }
        setErrors(next);
      }
      toast.error(errorMessage(t, error));
    },
  });

  const text = (field: string, label: string, options: { required?: boolean; hint?: string; errorKey?: string; multiline?: boolean; inputMode?: 'decimal' | 'numeric'; type?: string } = {}): React.JSX.Element => (
    <Field
      label={label}
      required={options.required === true}
      {...(options.hint === undefined ? {} : { hint: options.hint })}
      error={errors[options.errorKey ?? field]}
    >
      {({ inputId, describedBy }) =>
        options.multiline === true ? (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            rows={2}
            value={values[field] ?? ''}
            onChange={(event) => {
              set(field, event.target.value);
            }}
          />
        ) : (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            invalid={errors[options.errorKey ?? field] !== undefined}
            {...(options.inputMode === undefined ? {} : { inputMode: options.inputMode })}
            {...(options.type === undefined ? {} : { type: options.type })}
            value={values[field] ?? ''}
            onChange={(event) => {
              set(field, event.target.value);
            }}
          />
        )
      }
    </Field>
  );

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        const { input, problems } = build();
        setErrors(problems);
        if (input !== null) submit.mutate(input);
      }}
    >
      <ErrorSummary errors={Object.values(errors).map((message) => ({ message }))} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={t('rfq.field.currency')} required>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={values['currency']}
              onChange={(event) => {
                set('currency', event.target.value);
              }}
            >
              {currencies.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.code}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {text('unitPrice', t('rfq.quote.unitPrice'), { required: true, errorKey: 'unitPriceMinor', inputMode: 'decimal' })}
        {text('quantity', t('rfq.field.quantity'), { required: true, inputMode: 'decimal' })}
        {text('moq', t('rfq.compare.row.moq'), { hint: t('rfq.form.optional'), inputMode: 'decimal' })}
        {text('leadTimeDays', t('rfq.quote.leadTimeDays'), { hint: t('rfq.form.optional'), inputMode: 'numeric' })}
        {text('capacityPerMonth', t('rfq.compare.row.capacity'), { hint: t('rfq.form.optional'), inputMode: 'decimal' })}
        <Field label={t('rfq.field.incoterm')}>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={values['incoterm']}
              onChange={(event) => {
                set('incoterm', event.target.value);
              }}
            >
              <option value="">—</option>
              {INCOTERMS.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {text('incotermPlace', t('rfq.quote.incotermPlace'), { hint: t('rfq.form.optional') })}
        {text('expiresAt', t('rfq.quote.validUntil'), { required: true, hint: t('rfq.quote.validUntilHint'), type: 'datetime-local' })}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {text('paymentTerms', t('rfq.compare.row.payment'), { multiline: true })}
        {text('inspectionTerms', t('rfq.compare.row.inspection'), { multiline: true })}
        {text('warranty', t('rfq.compare.row.warranty'), { multiline: true })}
        {text('taxesDisclosure', t('rfq.compare.row.taxes'), { multiline: true, hint: t('rfq.quote.taxesHint') })}
      <fieldset className="mt-4">
        <legend className="text-sm font-medium text-ink">{t('rfq.compare.row.exportDocuments')}</legend>
        <div className="mt-1 grid gap-x-4 sm:grid-cols-2">
          {EXPORT_DOCUMENTS.map((code) => (
            <label key={code} className="flex min-h-11 items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border-strong text-brand"
                checked={documents.includes(code)}
                onChange={(event) => {
                  setDocuments(event.target.checked ? [...documents, code] : documents.filter((entry) => entry !== code));
                }}
              />
              {t(`rfq.exportDocument.${code}` as 'rfq.exportDocument.PACKING_LIST')}
            </label>
          ))}
        </div>
      </fieldset>
        {text('tooling', t('rfq.compare.row.tooling'), { errorKey: 'toolingMinor', inputMode: 'decimal', hint: t('rfq.form.optional') })}
        {text('sampleCost', t('rfq.compare.row.sample'), { errorKey: 'sampleCostMinor', inputMode: 'decimal', hint: t('rfq.form.optional') })}
        {text('shippingEstimate', t('rfq.compare.row.shipping'), { errorKey: 'shippingEstimateMinor', inputMode: 'decimal', hint: t('rfq.form.optional') })}
        {text('comment', t('rfq.quote.comment'), { multiline: true, hint: t('rfq.form.optional') })}
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-ink">{t('rfq.compare.row.tiers')}</legend>
        {tiers.map((tier, index) => (
          <div key={String(index)} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Input
              aria-label={t('rfq.quote.tierQuantity', { row: String(index + 1) })}
              inputMode="decimal"
              value={tier.minQuantity}
              onChange={(event) => {
                setTiers(tiers.map((entry, at) => (at === index ? { ...entry, minQuantity: event.target.value } : entry)));
              }}
            />
            <Input
              aria-label={t('rfq.quote.tierPrice', { row: String(index + 1) })}
              inputMode="decimal"
              value={tier.price}
              onChange={(event) => {
                setTiers(tiers.map((entry, at) => (at === index ? { ...entry, price: event.target.value } : entry)));
              }}
            />
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setTiers(tiers.filter((_entry, at) => at !== index));
              }}
            >
              {t('rfq.form.remove')}
            </Button>
          </div>
        ))}
        {tiers.length < 10 && (
          <Button
            type="button"
            size="sm"
            onClick={() => {
              setTiers([...tiers, { minQuantity: '', price: '' }]);
            }}
          >
            {t('rfq.quote.addTier')}
          </Button>
        )}
      </fieldset>
      {filesAvailable && (
        <div className="space-y-1">
          <p className="text-sm font-medium text-ink">{t('rfq.form.section.files')}</p>
          <ul className="text-sm text-ink-muted">
            {files.map((file) => (
              <li key={file.id}>{file.name}</li>
            ))}
          </ul>
          <label className="inline-flex cursor-pointer text-sm font-medium text-brand">
            <input
              type="file"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file === undefined) return;
                void uploadSellerRfqFile(rfqId, 'QUOTE', file)
                  .then((stored) => {
                    setFiles((current) => [...current, { id: stored.id, name: stored.fileName }]);
                  })
                  .catch((error: unknown) => {
                    toast.error(errorMessage(t, error));
                  });
              }}
            />
            {t('rfq.files.add')}
          </label>
        </div>
      )}
      <Button type="submit" variant="primary" isLoading={submit.isPending}>
        {t('rfq.quote.send')}
      </Button>
    </form>
  );
}
