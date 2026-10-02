/**
 * Write a request for quotation: `/account/rfqs/new` and
 * `/account/rfqs/:id/edit` (drafts only).
 *
 * One form in sections, saved as a DRAFT as often as the buyer likes. "Send
 * to suppliers" saves once more and submits; the server checks everything
 * again and its refusal names each field, which is shown beside that field
 * and in the summary at the top.
 *
 * `?categoryId=` and `?title=` prefill a new request - that is how "Request
 * quotes" on a category or product page arrives here.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { track } from '@/lib/analytics';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale } from '@/app/locale-context';
import { useStorefront } from '@/app/storefront-context';
import { ConfirmDialog } from '@/components/Modal';
import { AttachmentList } from '@/components/rfq/RfqParts';
import { SupplierPicker } from '@/components/rfq/SupplierPicker';
import { useToast } from '@/components/toast-context';
import {
  Button,
  Card,
  ErrorState,
  ErrorSummary,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { api, ApiError } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { currencyExponent, majorToMinor, minorToMajor } from '@/lib/format';
import { countryOptions } from '@/lib/iso-countries';
import {
  EMPTY_REQUIREMENT,
  INCOTERMS_NEEDING_DESTINATION,
  amendRfqRequirement,
  requirementOnly,
  createRfqDraft,
  deleteRfqDraft,
  draftFrom,
  fetchRfq,
  fetchRfqFormOptions,
  fromDeadlineInput,
  newIdempotencyKey,
  previewRfqMatches,
  removeRfqAttachment,
  rfqAttachmentUrl,
  saveRfqDraft,
  submitRfq,
  toDeadlineInput,
  uploadRfqAttachment,
  type BuyerRfq,
  type RfqDraftInput,
  type SupplierCard,
} from '@/lib/rfq';
import type { CategoryNode } from '@/lib/types';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

const QUANTITY = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,3})?$/;

type FieldErrors = Partial<Record<string, string>>;

function flatten(nodes: CategoryNode[], out: { id: string; name: string; depth: number }[] = []) {
  for (const node of nodes) {
    if (!node.isActive) continue;
    out.push({ id: node.id, name: node.name, depth: node.depth });
    flatten(node.children, out);
  }
  return out;
}

/** The form's own checks, worded before anything is sent. */
function localProblems(draft: RfqDraftInput, priceText: string, priceMinor: string | null): FieldErrors {
  const problems: FieldErrors = {};
  if (draft.quantity !== null && (!QUANTITY.test(draft.quantity) || Number(draft.quantity) <= 0)) {
    problems['quantity'] = 'QUANTITY';
  }
  if (draft.annualVolume !== null && (!QUANTITY.test(draft.annualVolume) || Number(draft.annualVolume) <= 0)) {
    problems['annualVolume'] = 'QUANTITY';
  }
  if (priceText.trim().length > 0 && (priceMinor === null || priceMinor === '0')) problems['targetUnitPriceMinor'] = 'PRICE';
  if ((priceText.trim().length > 0) !== (draft.targetCurrency !== null)) {
    problems[priceText.trim().length > 0 ? 'targetCurrency' : 'targetUnitPriceMinor'] = 'PAIR_REQUIRED';
  }
  if (draft.responseDeadline !== null && new Date(draft.responseDeadline).getTime() <= Date.now()) {
    problems['responseDeadline'] = 'IN_PAST';
  }
  return problems;
}

export function RfqEditPage(): React.JSX.Element {
  useEffect(() => {
    track('rfq_started', '/account/rfqs/new');
  }, []);
  const { id } = useParams<{ id: string }>();
  const { t } = useI18n();
  const { business } = useStorefront();
  useDocumentMeta({ title: id === undefined ? t('rfq.form.newTitle') : t('rfq.form.editTitle'), noIndex: true }, business.displayName);

  const existing = useQuery({ queryKey: ['rfq', id], queryFn: () => fetchRfq(id ?? ''), enabled: id !== undefined });
  const options = useQuery({ queryKey: ['rfq', 'form-options'], queryFn: fetchRfqFormOptions, staleTime: 5 * 60_000 });

  if (options.isPending || (id !== undefined && existing.isPending)) return <LoadingState label={t('rfq.form.loading')} />;
  if (options.isError || existing.isError) {
    return (
      <ErrorState
        error={options.error ?? existing.error}
        onRetry={() => {
          void options.refetch();
          void existing.refetch();
        }}
      />
    );
  }
  if (existing.data !== undefined && existing.data.status !== 'DRAFT') {
    return <ErrorState error={new Error(t('rfq.form.notDraft'))} />;
  }
  return <RfqForm key={existing.data?.id ?? 'new'} rfq={existing.data ?? null} options={options.data} mode="draft" />;
}

/**
 * `/account/rfqs/:id/amend`: the same form for a request already sent, which
 * publishes a new, visible version of the requirement instead of saving over
 * it. The category is fixed; the buyer says what changed and why.
 */
export function RfqAmendPage(): React.JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const { t } = useI18n();
  const existing = useQuery({ queryKey: ['rfq', id], queryFn: () => fetchRfq(id) });
  const options = useQuery({ queryKey: ['rfq', 'form-options'], queryFn: fetchRfqFormOptions, staleTime: 5 * 60_000 });
  if (options.isPending || existing.isPending) return <LoadingState label={t('rfq.form.loading')} />;
  if (options.isError || existing.isError) {
    return (
      <ErrorState
        error={options.error ?? existing.error}
        onRetry={() => {
          void options.refetch();
          void existing.refetch();
        }}
      />
    );
  }
  if (!existing.data.actions.canAmend) return <ErrorState error={new Error(t('errors.rfq.RFQ_TRANSITION_NOT_ALLOWED'))} />;
  return <RfqForm key={existing.data.id} rfq={existing.data} options={options.data} mode="amend" />;
}

function RfqForm({
  rfq,
  options,
  mode,
}: {
  rfq: BuyerRfq | null;
  options: Awaited<ReturnType<typeof fetchRfqFormOptions>>;
  mode: 'draft' | 'amend';
}): React.JSX.Element {
  const amending = mode === 'amend';
  const [changeSummary, setChangeSummary] = useState('');
  const { t, language } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { currencies } = useLocale();
  const [params] = useSearchParams();

  const [draft, setDraft] = useState<RfqDraftInput>(() =>
    rfq === null
      ? {
          ...EMPTY_REQUIREMENT,
          categoryId: params.get('categoryId'),
          title: (params.get('title') ?? '').slice(0, 200),
        }
      : draftFrom(rfq),
  );
  const [picked, setPicked] = useState<SupplierCard[]>(rfq?.selection.include ?? []);
  const [priceText, setPriceText] = useState(() =>
    rfq?.requirement.targetUnitPriceMinor != null && rfq.requirement.targetCurrency !== null
      ? minorToMajor(rfq.requirement.targetUnitPriceMinor, currencyExponent(rfq.requirement.targetCurrency))
      : '',
  );
  const [certText, setCertText] = useState((rfq?.requirement.certifications ?? []).join('\n'));
  const [version, setVersion] = useState(rfq?.version ?? 0);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [summary, setSummary] = useState<{ field?: string; message: string }[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const submitKey = useRef(newIdempotencyKey());
  const createKey = useRef(newIdempotencyKey());

  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ categories: CategoryNode[] }>('/catalog/categories'),
    staleTime: 5 * 60_000,
  });
  const categoryOptions = useMemo(() => flatten(categories.data?.categories ?? []), [categories.data]);
  const countries = useMemo(() => countryOptions(language), [language]);

  const rfqId = rfq?.id ?? null;
  const matches = useQuery({
    queryKey: ['rfq', rfqId, 'matches', draft.categoryId, draft.destinationCountry, version],
    queryFn: () => previewRfqMatches(rfqId ?? ''),
    enabled: rfqId !== null && draft.categoryId !== null && draft.destinationCountry !== null,
  });

  const priceMinor = useMemo(() => {
    if (priceText.trim().length === 0 || draft.targetCurrency === null) return null;
    return majorToMinor(priceText, currencyExponent(draft.targetCurrency));
  }, [priceText, draft.targetCurrency]);

  const set = <K extends keyof RfqDraftInput>(field: K, value: RfqDraftInput[K]): void => {
    setDraft((current) => ({ ...current, [field]: value }));
  };
  const text = (value: string): string | null => (value.trim().length === 0 ? null : value);

  const payload = (): RfqDraftInput => ({
    ...draft,
    title: draft.title.trim(),
    targetUnitPriceMinor: priceText.trim().length === 0 ? null : priceMinor,
    certifications: certText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    specs: draft.specs.filter((line) => line.key.trim().length > 0 && line.value.trim().length > 0),
    includeSellerIds: picked.map((supplier) => supplier.sellerAccountId),
  });

  const fieldMessage = (code: string, meta?: Record<string, unknown>): string =>
    t(`rfq.fieldError.${code}` as TranslationKey, {
      days: typeof meta?.['maxDays'] === 'number' ? String(meta['maxDays']) : String(options.maxResponseDays),
      defaultValue: t('rfq.fieldError.INVALID'),
    });

  const showServerErrors = (error: unknown): void => {
    if (error instanceof ApiError && error.details.length > 0) {
      const next: FieldErrors = {};
      const lines: { field?: string; message: string }[] = [];
      for (const detail of error.details) {
        const field = detail.field ?? '';
        const restrictionReason = detail.meta?.['reason'];
        const message = error.code === 'RFQ_DESTINATION_BLOCKED' && detail.code === 'BLOCKED'
          ? typeof restrictionReason === 'string' && restrictionReason.trim().length > 0
            ? restrictionReason
            : error.message
          : fieldMessage(detail.code ?? 'INVALID', detail.meta);
        if (field.length > 0 && next[field] === undefined) next[field] = message;
        lines.push({ field, message: field.length > 0 ? `${t(`rfq.fieldName.${field}` as TranslationKey, { defaultValue: field })}: ${message}` : message });
      }
      setErrors(next);
      setSummary(lines);
      return;
    }
    setErrors({});
    setSummary([{ message: errorMessage(t, error) }]);
  };

  const validateLocally = (): boolean => {
    const problems = localProblems(draft, priceText, priceMinor);
    const entries = Object.entries(problems).filter((entry): entry is [string, string] => entry[1] !== undefined);
    if (entries.length === 0) return true;
    const next: FieldErrors = {};
    for (const [field, code] of entries) next[field] = fieldMessage(code);
    setErrors(next);
    setSummary(entries.map(([field, code]) => ({ field, message: `${t(`rfq.fieldName.${field}` as TranslationKey)}: ${fieldMessage(code)}` })));
    return false;
  };

  const save = useMutation({
    mutationFn: async (): Promise<BuyerRfq> =>
      rfqId === null ? createRfqDraft(payload(), createKey.current) : saveRfqDraft(rfqId, payload(), version),
    onSuccess: (saved) => {
      setErrors({});
      setSummary([]);
      setVersion(saved.version);
      queryClient.setQueryData(['rfq', saved.id], saved);
      void queryClient.invalidateQueries({ queryKey: ['rfqs'] });
      toast.success(t('rfq.form.saved'));
      if (rfqId === null) void navigate(`/account/rfqs/${saved.id}/edit`, { replace: true });
    },
    onError: showServerErrors,
  });

  const send = useMutation({
    mutationFn: async (): Promise<BuyerRfq> => {
      if (amending && rfq !== null) {
        return amendRfqRequirement(rfq.id, requirementOnly(payload()), rfq.version, changeSummary.trim());
      }
      const saved = rfqId === null ? await createRfqDraft(payload(), createKey.current) : await saveRfqDraft(rfqId, payload(), version);
      setVersion(saved.version);
      return submitRfq(saved.id, saved.version, submitKey.current);
    },
    onSuccess: (sent) => {
      queryClient.setQueryData(['rfq', sent.id], sent);
      void queryClient.invalidateQueries({ queryKey: ['rfqs'] });
      toast.success(amending ? t('rfq.form.published') : t('rfq.form.sent'));
      void navigate(`/account/rfqs/${sent.id}`);
    },
    onError: (error) => {
      // A refused submission may be fixed and pressed again: that is a new attempt.
      submitKey.current = newIdempotencyKey();
      showServerErrors(error);
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteRfqDraft(rfqId ?? ''),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rfqs'] });
      toast.success(t('rfq.form.deleted'));
      void navigate('/account/rfqs');
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  const attachments = rfq?.attachments ?? [];
  const [files, setFiles] = useState(attachments);
  useEffect(() => {
    setFiles(rfq?.attachments ?? []);
  }, [rfq?.attachments]);
  const [uploading, setUploading] = useState(false);

  const upload = async (file: File): Promise<void> => {
    if (rfqId === null) return;
    setUploading(true);
    try {
      const stored = await uploadRfqAttachment(`/rfqs/${rfqId}/attachments`, file);
      setFiles((current) => [...current, stored]);
    } catch (error) {
      toast.error(errorMessage(t, error));
    } finally {
      setUploading(false);
    }
  };

  const busy = save.isPending || send.isPending;
  const needsDestination = draft.incoterm !== null && INCOTERMS_NEEDING_DESTINATION.includes(draft.incoterm);
  const excluded = new Set(draft.excludeSellerIds);

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (validateLocally()) send.mutate();
      }}
      className="space-y-6"
    >
      <PageHeader
        title={amending ? t('rfq.form.amendTitle') : rfq === null ? t('rfq.form.newTitle') : t('rfq.form.editTitle')}
        description={
          amending && rfq !== null
            ? `${rfq.reference} · ${t('rfq.form.amendDescription')}`
            : rfq === null
              ? t('rfq.form.description')
              : `${rfq.reference} · ${t('rfq.status.DRAFT')}`
        }
      />

      <ErrorSummary title={t('rfq.form.problemsTitle')} errors={summary} />

      <Card title={t('rfq.form.section.what')} bodyClassName="space-y-4 px-6 py-5">
        <Field label={t('rfq.field.category')} required error={errors['categoryId']}>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              invalid={errors['categoryId'] !== undefined}
              disabled={amending}
              value={draft.categoryId ?? ''}
              onChange={(event) => {
                set('categoryId', event.target.value.length === 0 ? null : event.target.value);
              }}
            >
              <option value="">{t('rfq.form.chooseCategory')}</option>
              {categoryOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {`${'  '.repeat(option.depth)}${option.name}`}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('rfq.field.title')} required error={errors['title']} hint={t('rfq.form.titleHint')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={errors['title'] !== undefined}
              maxLength={200}
              value={draft.title}
              onChange={(event) => {
                set('title', event.target.value);
              }}
            />
          )}
        </Field>
        <Field label={t('rfq.field.specification')} required error={errors['specification']} hint={t('rfq.form.specificationHint')}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              invalid={errors['specification'] !== undefined}
              rows={6}
              maxLength={20_000}
              value={draft.specification ?? ''}
              onChange={(event) => {
                set('specification', text(event.target.value));
              }}
            />
          )}
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-ink">{t('rfq.field.specs')}</legend>
          <p className="text-xs text-ink-muted">{t('rfq.form.specsHint')}</p>
          {draft.specs.map((line, index) => (
            <div key={String(index)} className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]">
              <Input
                aria-label={t('rfq.form.specKey', { row: String(index + 1) })}
                maxLength={80}
                value={line.key}
                onChange={(event) => {
                  set('specs', draft.specs.map((entry, at) => (at === index ? { ...entry, key: event.target.value } : entry)));
                }}
              />
              <Input
                aria-label={t('rfq.form.specValue', { row: String(index + 1) })}
                maxLength={400}
                value={line.value}
                onChange={(event) => {
                  set('specs', draft.specs.map((entry, at) => (at === index ? { ...entry, value: event.target.value } : entry)));
                }}
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  set('specs', draft.specs.filter((_entry, at) => at !== index));
                }}
                aria-label={t('rfq.form.removeSpec', { row: String(index + 1) })}
              >
                {t('rfq.form.remove')}
              </Button>
            </div>
          ))}
          {draft.specs.length < 40 && (
            <Button
              type="button"
              size="sm"
              onClick={() => {
                set('specs', [...draft.specs, { key: '', value: '' }]);
              }}
            >
              {t('rfq.form.addSpec')}
            </Button>
          )}
        </fieldset>
      </Card>

      <Card title={t('rfq.form.section.quantity')} bodyClassName="grid gap-4 px-6 py-5 sm:grid-cols-2">
        <Field label={t('rfq.field.quantity')} required error={errors['quantity']}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={errors['quantity'] !== undefined}
              inputMode="decimal"
              value={draft.quantity ?? ''}
              onChange={(event) => {
                set('quantity', text(event.target.value.trim()));
              }}
            />
          )}
        </Field>
        <Field label={t('rfq.field.unitOfMeasure')} required error={errors['unitOfMeasure']}>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              invalid={errors['unitOfMeasure'] !== undefined}
              value={draft.unitOfMeasure ?? ''}
              onChange={(event) => {
                set('unitOfMeasure', text(event.target.value));
              }}
            >
              <option value="">{t('rfq.form.choose')}</option>
              {options.unitsOfMeasure.map((unit) => (
                <option key={unit} value={unit}>
                  {t(`rfq.unit.${unit}` as TranslationKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('rfq.field.annualVolume')} hint={t('rfq.form.optional')} error={errors['annualVolume']}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={errors['annualVolume'] !== undefined}
              inputMode="decimal"
              value={draft.annualVolume ?? ''}
              onChange={(event) => {
                set('annualVolume', text(event.target.value.trim()));
              }}
            />
          )}
        </Field>
        <div className="grid grid-cols-[1fr_7rem] gap-2">
          <Field label={t('rfq.field.targetPrice')} hint={t('rfq.form.targetPriceHint')} error={errors['targetUnitPriceMinor']}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={errors['targetUnitPriceMinor'] !== undefined}
                inputMode="decimal"
                value={priceText}
                onChange={(event) => {
                  setPriceText(event.target.value);
                }}
              />
            )}
          </Field>
          <Field label={t('rfq.field.currency')} error={errors['targetCurrency']}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                invalid={errors['targetCurrency'] !== undefined}
                value={draft.targetCurrency ?? ''}
                onChange={(event) => {
                  set('targetCurrency', text(event.target.value));
                }}
              >
                <option value="">—</option>
                {currencies.map((currency) => (
                  <option key={currency.code} value={currency.code}>
                    {currency.code}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Card>

      <Card title={t('rfq.form.section.delivery')} bodyClassName="grid gap-4 px-6 py-5 sm:grid-cols-2">
        <Field label={t('rfq.field.destinationCountry')} required error={errors['destinationCountry']}>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              invalid={errors['destinationCountry'] !== undefined}
              value={draft.destinationCountry ?? ''}
              onChange={(event) => {
                set('destinationCountry', text(event.target.value));
              }}
            >
              <option value="">{t('rfq.form.chooseCountry')}</option>
              {countries.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('rfq.field.incoterm')} required error={errors['incoterm']} hint={t('rfq.form.incotermHint')}>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              invalid={errors['incoterm'] !== undefined}
              value={draft.incoterm ?? ''}
              onChange={(event) => {
                set('incoterm', text(event.target.value));
              }}
            >
              <option value="">{t('rfq.form.choose')}</option>
              {options.incoterms.map((code) => (
                <option key={code} value={code}>
                  {`${code} — ${t(`rfq.incoterm.${code}` as TranslationKey)}`}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label={t('rfq.field.destinationPort')}
          required={needsDestination}
          hint={needsDestination ? t('rfq.form.destinationNeeded') : t('rfq.form.optional')}
          error={errors['destinationPort']}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={errors['destinationPort'] !== undefined}
              maxLength={120}
              value={draft.destinationPort ?? ''}
              onChange={(event) => {
                set('destinationPort', text(event.target.value));
              }}
            />
          )}
        </Field>
        <Field label={t('rfq.field.destinationAddress')} hint={t('rfq.form.optional')} error={errors['destinationAddress']}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              rows={2}
              maxLength={500}
              value={draft.destinationAddress ?? ''}
              onChange={(event) => {
                set('destinationAddress', text(event.target.value));
              }}
            />
          )}
        </Field>
      </Card>

      <Card title={t('rfq.form.section.conditions')} bodyClassName="grid gap-4 px-6 py-5 sm:grid-cols-2">
        <Field label={t('rfq.field.certifications')} hint={t('rfq.form.certificationsHint')} error={errors['certifications']}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              rows={3}
              value={certText}
              onChange={(event) => {
                setCertText(event.target.value);
              }}
            />
          )}
        </Field>
        <div className="space-y-4">
          <Field label={t('rfq.field.sample')}>
            {({ inputId }) => (
              <Select
                id={inputId}
                value={draft.sampleRequirement}
                onChange={(event) => {
                  set('sampleRequirement', event.target.value);
                }}
              >
                {options.sampleRequirements.map((value) => (
                  <option key={value} value={value}>
                    {t(`rfq.sample.${value}` as TranslationKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('rfq.field.inspection')}>
            {({ inputId }) => (
              <Select
                id={inputId}
                value={draft.inspectionRequirement}
                onChange={(event) => {
                  set('inspectionRequirement', event.target.value);
                }}
              >
                {options.inspectionRequirements.map((value) => (
                  <option key={value} value={value}>
                    {t(`rfq.inspection.${value}` as TranslationKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Card>

      <Card title={t('rfq.form.section.timing')} bodyClassName="grid gap-4 px-6 py-5 sm:grid-cols-2">
        <Field
          label={t('rfq.field.deadlineUtc')}
          required
          hint={t('rfq.form.deadlineHint', { days: String(options.maxResponseDays) })}
          error={errors['responseDeadline']}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="datetime-local"
              aria-describedby={describedBy}
              invalid={errors['responseDeadline'] !== undefined}
              value={toDeadlineInput(draft.responseDeadline)}
              onChange={(event) => {
                set('responseDeadline', fromDeadlineInput(event.target.value));
              }}
            />
          )}
        </Field>
        <Field label={t('rfq.field.deliveryDate')} hint={t('rfq.form.optional')} error={errors['deliveryTargetDate']}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="date"
              aria-describedby={describedBy}
              invalid={errors['deliveryTargetDate'] !== undefined}
              value={draft.deliveryTargetDate ?? ''}
              onChange={(event) => {
                set('deliveryTargetDate', text(event.target.value));
              }}
            />
          )}
        </Field>
        <div className="sm:col-span-2">
          <Field label={t('rfq.field.notes')} hint={t('rfq.form.optional')} error={errors['notes']}>
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                rows={3}
                maxLength={5_000}
                value={draft.notes ?? ''}
                onChange={(event) => {
                  set('notes', text(event.target.value));
                }}
              />
            )}
          </Field>
        </div>
      </Card>

      <Card title={t('rfq.form.section.files')} description={t('rfq.form.filesHint')} bodyClassName="space-y-3 px-6 py-5">
        {rfqId === null ? (
          <p className="text-sm text-ink-muted">{t('rfq.form.saveFirstForFiles')}</p>
        ) : !options.attachments.available ? (
          <p className="text-sm text-ink-muted">{t('rfq.files.unavailable')}</p>
        ) : (
          <>
            <AttachmentList
              attachments={files}
              hrefFor={(attachment) => rfqAttachmentUrl('/rfqs', rfqId, attachment.id)}
              canRemove={(attachment) => attachment.requirementVersion === null}
              onRemove={(attachment) => {
                void removeRfqAttachment(rfqId, attachment.id)
                  .then(() => {
                    setFiles((current) => current.filter((entry) => entry.id !== attachment.id));
                  })
                  .catch((error: unknown) => {
                    toast.error(errorMessage(t, error));
                  });
              }}
            />
            <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium text-brand">
              <input
                type="file"
                className="sr-only"
                accept={options.attachments.types.join(',')}
                disabled={uploading || files.length >= options.attachments.maxFiles}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file !== undefined) void upload(file);
                }}
              />
              {uploading ? t('rfq.files.uploading') : t('rfq.files.add')}
            </label>
            <p className="text-xs text-ink-muted">
              {t('rfq.files.rules', { size: String(Math.round(options.attachments.maxBytes / 1_048_576)) })}
            </p>
          </>
        )}
      </Card>

      {amending ? (
        <Card title={t('rfq.form.changeSummary')} bodyClassName="px-6 py-5">
          <Field label={t('rfq.form.changeSummary')} required hint={t('rfq.form.changeSummaryHint')} error={errors['changeSummary']}>
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                invalid={errors['changeSummary'] !== undefined}
                rows={3}
                maxLength={1000}
                value={changeSummary}
                onChange={(event) => {
                  setChangeSummary(event.target.value);
                }}
              />
            )}
          </Field>
        </Card>
      ) : (
      <Card title={t('rfq.form.section.suppliers')} description={t('rfq.form.suppliersHint')} bodyClassName="space-y-4 px-6 py-5">
        {rfqId === null || draft.categoryId === null || draft.destinationCountry === null ? (
          <p className="text-sm text-ink-muted">{t('rfq.form.matchesNeedSave')}</p>
        ) : matches.isPending ? (
          <LoadingState label={t('rfq.form.matchesLoading')} />
        ) : matches.isError ? (
          <ErrorState
            error={matches.error}
            onRetry={() => {
              void matches.refetch();
            }}
          />
        ) : matches.data.outcome === 'BLOCKED' ? (
          <p role="alert" className="text-sm text-danger">
            {t('rfq.form.matchesBlocked', { reason: matches.data.blockedReason ?? '' })}
          </p>
        ) : matches.data.suppliers.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('rfq.form.noMatches')}</p>
        ) : (
          <fieldset>
            <legend className="text-sm font-medium text-ink">
              {t('rfq.form.matchedSuppliers', { matched: String(matches.data.suppliers.length) })}
            </legend>
            {/* Invite everyone matched, or start from nobody and pick (JOURNEY-014). */}
            <p className="mt-1 flex flex-wrap gap-x-4 text-sm">
              <button type="button" className="min-h-9 text-brand underline-offset-2 hover:underline" onClick={() => { set('excludeSellerIds', []); }}>
                {t('rfq.match.inviteAll')}
              </button>
              <button
                type="button"
                className="min-h-9 text-brand underline-offset-2 hover:underline"
                onClick={() => { set('excludeSellerIds', matches.data.suppliers.map((supplier) => supplier.sellerAccountId)); }}
              >
                {t('rfq.match.excludeAll')}
              </button>
            </p>
            <ul className="mt-2 space-y-2">
              {matches.data.suppliers.map((supplier) => (
                <li key={supplier.sellerAccountId}>
                  <label className="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={!excluded.has(supplier.sellerAccountId)}
                      onChange={(event) => {
                        const next = new Set(draft.excludeSellerIds);
                        if (event.target.checked) next.delete(supplier.sellerAccountId);
                        else next.add(supplier.sellerAccountId);
                        set('excludeSellerIds', [...next]);
                      }}
                    />
                    <span>{supplier.displayName}</span>
                    {supplier.verifiedAt !== null && <span className="text-xs text-success">{t('rfq.supplier.verified')}</span>}
                  </label>
                  {/* Why this supplier, and what to know first (JOURNEY-014). */}
                  {(supplier.reasons ?? []).length + (supplier.flags ?? []).length > 0 && (
                    <p className="ml-6 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                      {(supplier.reasons ?? []).map((reason) => (
                        <span key={reason} className="text-ink-muted">{t(`rfq.match.reason.${reason}` as 'rfq.match.reason.LIVE_IN_CATEGORY')}</span>
                      ))}
                      {(supplier.flags ?? []).map((flag) => (
                        <span key={flag} className="font-medium text-warning">{t(`rfq.match.flag.${flag}` as 'rfq.match.flag.CAPACITY_UNKNOWN')}</span>
                      ))}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <SupplierPicker
          categoryId={draft.categoryId}
          country={draft.destinationCountry}
          picked={picked}
          onPick={(supplier) => {
            if (!picked.some((entry) => entry.sellerAccountId === supplier.sellerAccountId)) setPicked([...picked, supplier]);
          }}
          onRemove={(supplier) => {
            setPicked(picked.filter((entry) => entry.sellerAccountId !== supplier.sellerAccountId));
          }}
        />
      </Card>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {!amending && (
          <Button
            type="button"
            disabled={busy}
            isLoading={save.isPending}
            onClick={() => {
              if (validateLocally()) save.mutate();
            }}
          >
            {t('rfq.form.saveDraft')}
          </Button>
          )}
          {rfqId !== null && !amending && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setConfirmDelete(true);
              }}
            >
              {t('rfq.form.deleteDraft')}
            </Button>
          )}
        </div>
        <Button type="submit" variant="primary" disabled={busy} isLoading={send.isPending}>
          {amending ? t('rfq.form.publish') : t('rfq.form.send')}
        </Button>
      </div>

      <ConfirmDialog
        isOpen={confirmDelete}
        onClose={() => {
          setConfirmDelete(false);
        }}
        onConfirm={() => {
          remove.mutate();
        }}
        title={t('rfq.form.deleteTitle')}
        body={t('rfq.form.deleteBody')}
        confirmLabel={t('rfq.form.deleteDraft')}
        isDangerous
        isWorking={remove.isPending}
      />
    </form>
  );
}
