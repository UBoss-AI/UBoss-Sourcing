/**
 * The two forms on Seller Hub -> Compliance: asking for a qualification, and
 * adding (or replacing) a compliance document.
 *
 * Both are checked here before anything is sent, and the server checks again:
 * a category the seller does not sell in, a site that is not theirs or a file
 * that failed its scan is refused there whatever this form allowed.
 *
 * Each submit attempt carries one Idempotency-Key, kept across a retry of the
 * same attempt and replaced once the attempt succeeds or the form changes.
 */
import { useRef, useState } from 'react';
import { useMutation, useQueries, useQueryClient } from '@tanstack/react-query';
import { Button, Field, Input, Select, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { newIdempotencyKey } from '@/lib/api';
import {
  DOCUMENT_TYPES,
  SUPPLY_ROLES,
  complianceKeys,
  createComplianceDocument,
  documentTypeLabel,
  fetchApprovedRequirements,
  requestComplianceCase,
  supplyRoleLabel,
  type CategoryGate,
  type ComplianceDocument,
  type ComplianceDocumentType,
  type SupplyRole,
} from '@/lib/compliance';
import { errorMessage } from '@/lib/errors';
import { uploadEvidenceFile, type Factory } from '@/lib/factories';

/** One key per attempt: reused on a retry, replaced when the attempt is over or the input changes. */
function useAttemptKey(): { current: () => string; reset: () => void } {
  const key = useRef<string | null>(null);
  return {
    current: () => {
      key.current ??= newIdempotencyKey();
      return key.current;
    },
    reset: () => {
      key.current = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Ask for a qualification
// ---------------------------------------------------------------------------

type MarketChoice = '' | 'EU' | 'COUNTRY';

interface RequestErrors {
  categoryId?: TranslationKey;
  supplyRole?: TranslationKey;
  country?: TranslationKey;
}

export function CaseRequestForm({
  categories,
  factories,
  initialCategoryId,
  onDone,
}: {
  categories: CategoryGate[];
  factories: Factory[];
  initialCategoryId: string;
  onDone: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const cache = useQueryClient();
  const attempt = useAttemptKey();
  const [categoryId, setCategoryId] = useState(initialCategoryId);
  const [supplyRole, setSupplyRole] = useState<SupplyRole | ''>('');
  const [market, setMarket] = useState<MarketChoice>('');
  const [country, setCountry] = useState('');
  const [factoryId, setFactoryId] = useState('');
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<RequestErrors>({});

  const changed = (): void => {
    attempt.reset();
  };

  const send = useMutation({
    mutationFn: () =>
      requestComplianceCase(
        {
          level: 'SELLER_CATEGORY',
          categoryId,
          supplyRole: supplyRole as SupplyRole,
          destinationMarket: market === 'COUNTRY' ? country.trim().toUpperCase() : market,
          factoryId: factoryId === '' ? null : factoryId,
          message: message.trim() === '' ? null : message.trim(),
        },
        attempt.current(),
      ),
    onSuccess: async (result) => {
      attempt.reset();
      toast.success(
        result.created
          ? t('compliance.request.sent', { caseNumber: result.caseNumber })
          : t('compliance.request.alreadyOpen', { caseNumber: result.caseNumber }),
      );
      await cache.invalidateQueries({ queryKey: complianceKeys.overview });
      onDone();
    },
    onError: (failure) => {
      toast.error(errorMessage(t, failure));
    },
  });

  const submit = (event: React.SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const next: RequestErrors = {};
    if (categoryId === '') next.categoryId = 'compliance.request.errorCategory';
    if (supplyRole === '') next.supplyRole = 'compliance.request.errorRole';
    if (market === 'COUNTRY' && !/^[A-Za-z]{2}$/.test(country.trim())) next.country = 'compliance.request.errorCountry';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    send.mutate();
  };

  return (
    <form noValidate onSubmit={submit} className="grid gap-4 sm:grid-cols-2" aria-label={t('compliance.request.title')}>
      <Field label={t('compliance.request.category')} required error={errors.categoryId === undefined ? undefined : t(errors.categoryId)}>
        {({ inputId, describedBy }) => (
          <Select
            id={inputId}
            aria-describedby={describedBy}
            invalid={errors.categoryId !== undefined}
            value={categoryId}
            onChange={(event) => {
              changed();
              setCategoryId(event.target.value);
            }}
          >
            <option value="">{t('compliance.request.chooseCategory')}</option>
            {categories.map((category) => (
              <option key={category.categoryId} value={category.categoryId}>
                {category.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('compliance.request.role')} required error={errors.supplyRole === undefined ? undefined : t(errors.supplyRole)}>
        {({ inputId, describedBy }) => (
          <Select
            id={inputId}
            aria-describedby={describedBy}
            invalid={errors.supplyRole !== undefined}
            value={supplyRole}
            onChange={(event) => {
              changed();
              setSupplyRole(event.target.value as SupplyRole | '');
            }}
          >
            <option value="">{t('compliance.request.chooseRole')}</option>
            {SUPPLY_ROLES.map((role) => (
              <option key={role} value={role}>
                {supplyRoleLabel(t, role)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('compliance.request.market')} hint={t('compliance.request.marketHint')}>
        {({ inputId, describedBy }) => (
          <Select
            id={inputId}
            aria-describedby={describedBy}
            value={market}
            onChange={(event) => {
              changed();
              setMarket(event.target.value as MarketChoice);
            }}
          >
            <option value="">{t('compliance.market.any')}</option>
            <option value="EU">{t('compliance.market.EU')}</option>
            <option value="COUNTRY">{t('compliance.request.oneCountry')}</option>
          </Select>
        )}
      </Field>
      {market === 'COUNTRY' && (
        <Field label={t('compliance.request.country')} required error={errors.country === undefined ? undefined : t(errors.country)}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              invalid={errors.country !== undefined}
              value={country}
              maxLength={2}
              autoCapitalize="characters"
              onChange={(event) => {
                changed();
                setCountry(event.target.value);
              }}
            />
          )}
        </Field>
      )}
      <Field label={t('compliance.request.site')} hint={t('compliance.request.siteHint')}>
        {({ inputId, describedBy }) => (
          <Select
            id={inputId}
            aria-describedby={describedBy}
            value={factoryId}
            onChange={(event) => {
              changed();
              setFactoryId(event.target.value);
            }}
          >
            <option value="">{t('compliance.request.anySite')}</option>
            {factories.map((factory) => (
              <option key={factory.id} value={factory.id}>
                {factory.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="sm:col-span-2">
        <Field label={t('compliance.request.message')}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              rows={3}
              maxLength={2000}
              value={message}
              onChange={(event) => {
                changed();
                setMessage(event.target.value);
              }}
            />
          )}
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={send.isPending}>
          {t('compliance.request.submit')}
        </Button>
        <p className="text-xs text-ink-muted">{t('compliance.request.reviewerDecides')}</p>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Add or replace a document
// ---------------------------------------------------------------------------

interface DocumentForm {
  documentType: ComplianceDocumentType | '';
  standard: string;
  certificateNumber: string;
  issuer: string;
  issuingCountry: string;
  legalEntityName: string;
  factoryId: string;
  categoryScopeIds: string[];
  requirementCodes: string[];
  modelScope: string;
  scope: string;
  issuedOn: string;
  expiresOn: string;
  noExpiryReason: string;
}

type DocumentErrors = Partial<Record<keyof DocumentForm | 'file', TranslationKey>>;

function startingForm(replacing: ComplianceDocument | null): DocumentForm {
  if (replacing === null) {
    return {
      documentType: '',
      standard: '',
      certificateNumber: '',
      issuer: '',
      issuingCountry: '',
      legalEntityName: '',
      factoryId: '',
      categoryScopeIds: [],
      requirementCodes: [],
      modelScope: '',
      scope: '',
      issuedOn: '',
      expiresOn: '',
      noExpiryReason: '',
    };
  }
  return {
    documentType: (DOCUMENT_TYPES as readonly string[]).includes(replacing.documentType) ? (replacing.documentType as ComplianceDocumentType) : '',
    standard: replacing.standard,
    certificateNumber: replacing.certificateNumber ?? '',
    issuer: replacing.issuer,
    issuingCountry: replacing.issuingCountry ?? '',
    legalEntityName: replacing.legalEntityName ?? '',
    factoryId: replacing.factoryId ?? '',
    categoryScopeIds: replacing.categoryScopeIds,
    requirementCodes: replacing.requirementCodes,
    modelScope: replacing.modelScope ?? '',
    scope: replacing.scope ?? '',
    // New dates: a replacement is a new document, usually with a new validity.
    issuedOn: '',
    expiresOn: '',
    noExpiryReason: '',
  };
}

/** What is wrong with the form, as message keys; empty when it may be sent. */
function validateDocument(form: DocumentForm, file: File | null): DocumentErrors {
  const errors: DocumentErrors = {};
  if (form.documentType === '') errors.documentType = 'compliance.doc.errorType';
  if (form.standard.trim().length < 2) errors.standard = 'compliance.doc.errorStandard';
  if (form.issuer.trim().length < 2) errors.issuer = 'compliance.doc.errorIssuer';
  if (form.issuingCountry.trim() !== '' && !/^[A-Za-z]{2}$/.test(form.issuingCountry.trim())) errors.issuingCountry = 'compliance.request.errorCountry';
  if (form.categoryScopeIds.length === 0) errors.categoryScopeIds = 'compliance.doc.errorCategories';
  if (form.expiresOn === '' && form.noExpiryReason.trim() === '') errors.noExpiryReason = 'compliance.doc.errorExpiry';
  if (form.expiresOn !== '' && form.issuedOn !== '' && form.expiresOn < form.issuedOn) errors.expiresOn = 'compliance.doc.errorDates';
  if (file === null) errors.file = 'compliance.doc.errorFile';
  return errors;
}

export function ComplianceDocumentForm({
  categories,
  factories,
  replacing,
  onDone,
}: {
  categories: CategoryGate[];
  factories: Factory[];
  replacing: ComplianceDocument | null;
  onDone: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const cache = useQueryClient();
  const attempt = useAttemptKey();
  const [form, setForm] = useState<DocumentForm>(() => startingForm(replacing));
  const [file, setFile] = useState<File | null>(null);
  // The uploaded file's id, so a retry after a failed save does not upload it twice.
  const [uploadedId, setUploadedId] = useState<string | null>(null);
  const [errors, setErrors] = useState<DocumentErrors>({});

  const requirementQueries = useQueries({
    queries: form.categoryScopeIds.map((categoryId) => ({
      queryKey: complianceKeys.requirements(categoryId),
      queryFn: () => fetchApprovedRequirements(categoryId),
    })),
  });
  const requirements = new Map<string, string>();
  for (const query of requirementQueries) for (const rule of query.data ?? []) requirements.set(rule.code, rule.name);

  const update = <K extends keyof DocumentForm>(key: K, value: DocumentForm[K]): void => {
    attempt.reset();
    setForm((current) => ({ ...current, [key]: value }));
  };
  const toggle = (key: 'categoryScopeIds' | 'requirementCodes', value: string): void => {
    attempt.reset();
    setForm((current) => ({
      ...current,
      [key]: current[key].includes(value) ? current[key].filter((entry) => entry !== value) : [...current[key], value],
    }));
  };

  const save = useMutation({
    mutationFn: async (submit: boolean) => {
      let documentId = uploadedId;
      if (documentId === null) {
        documentId = (await uploadEvidenceFile(file as File, 'certificate')).id;
        setUploadedId(documentId);
      }
      const optional = (value: string): string | null => (value.trim() === '' ? null : value.trim());
      return createComplianceDocument(
        {
          documentType: form.documentType as ComplianceDocumentType,
          standard: form.standard.trim(),
          certificateNumber: optional(form.certificateNumber),
          issuer: form.issuer.trim(),
          issuingCountry: optional(form.issuingCountry)?.toUpperCase() ?? null,
          legalEntityName: optional(form.legalEntityName),
          factoryId: form.factoryId === '' ? null : form.factoryId,
          categoryScopeIds: form.categoryScopeIds,
          productScopeIds: [],
          modelScope: optional(form.modelScope),
          scope: optional(form.scope),
          requirementCodes: form.requirementCodes.filter((code) => requirements.has(code) || replacing?.requirementCodes.includes(code) === true),
          issuedOn: form.issuedOn === '' ? null : form.issuedOn,
          expiresOn: form.expiresOn === '' ? null : form.expiresOn,
          noExpiryReason: form.expiresOn === '' ? optional(form.noExpiryReason) : null,
          documentId,
          replacesId: replacing?.id ?? null,
          submit,
        },
        attempt.current(),
      );
    },
    onSuccess: async (_created, submit) => {
      attempt.reset();
      toast.success(submit ? t('compliance.doc.sent') : t('compliance.doc.savedDraft'));
      await cache.invalidateQueries({ queryKey: complianceKeys.overview });
      onDone();
    },
    onError: (failure) => {
      toast.error(errorMessage(t, failure));
    },
  });

  const run = (submit: boolean): void => {
    const next = validateDocument(form, file);
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    save.mutate(submit);
  };

  const err = (key: keyof DocumentErrors): string | undefined => (errors[key] === undefined ? undefined : t(errors[key]));

  const text = (key: 'standard' | 'certificateNumber' | 'issuer' | 'issuingCountry' | 'legalEntityName', label: TranslationKey, options: { required?: boolean; maxLength: number; hint?: TranslationKey }): React.JSX.Element => (
    <Field label={t(label)} required={options.required === true} error={err(key)} {...(options.hint === undefined ? {} : { hint: t(options.hint) })}>
      {({ inputId, describedBy }) => (
        <Input
          id={inputId}
          aria-describedby={describedBy}
          invalid={errors[key] !== undefined}
          value={form[key]}
          maxLength={options.maxLength}
          onChange={(event) => {
            update(key, event.target.value);
          }}
        />
      )}
    </Field>
  );

  return (
    <form
      noValidate
      aria-label={replacing === null ? t('compliance.doc.addTitle') : t('compliance.doc.replaceTitle', { standard: replacing.standard })}
      className="grid gap-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        run(true);
      }}
    >
      {replacing !== null && (
        <p className="rounded-md bg-surface-sunken px-3 py-2 text-sm sm:col-span-2">
          {t('compliance.doc.replacingNote', { revision: String(replacing.revision) })}
        </p>
      )}
      <Field label={t('compliance.doc.type')} required error={err('documentType')}>
        {({ inputId, describedBy }) => (
          <Select
            id={inputId}
            aria-describedby={describedBy}
            invalid={errors.documentType !== undefined}
            value={form.documentType}
            onChange={(event) => {
              update('documentType', event.target.value as ComplianceDocumentType | '');
            }}
          >
            <option value="">{t('compliance.doc.chooseType')}</option>
            {DOCUMENT_TYPES.map((type) => (
              <option key={type} value={type}>
                {documentTypeLabel(t, type)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {text('standard', 'compliance.doc.standard', { required: true, maxLength: 80, hint: 'compliance.doc.standardHint' })}
      {text('issuer', 'compliance.doc.issuer', { required: true, maxLength: 160 })}
      {text('certificateNumber', 'compliance.doc.number', { maxLength: 120 })}
      {text('issuingCountry', 'compliance.doc.issuingCountry', { maxLength: 2, hint: 'compliance.doc.issuingCountryHint' })}
      {text('legalEntityName', 'compliance.doc.legalEntity', { maxLength: 255, hint: 'compliance.doc.legalEntityHint' })}
      <Field label={t('compliance.request.site')} hint={t('compliance.doc.siteHint')}>
        {({ inputId, describedBy }) => (
          <Select
            id={inputId}
            aria-describedby={describedBy}
            value={form.factoryId}
            onChange={(event) => {
              update('factoryId', event.target.value);
            }}
          >
            <option value="">{t('compliance.request.anySite')}</option>
            {factories.map((factory) => (
              <option key={factory.id} value={factory.id}>
                {factory.name}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <fieldset className="space-y-2 sm:col-span-2" aria-describedby="compliance-doc-categories-error">
        <legend className="text-sm font-medium text-ink">
          {t('compliance.doc.categories')}
          <span className="ml-1 text-danger" aria-hidden="true">*</span>
        </legend>
        <p className="text-xs text-ink-muted">{t('compliance.doc.categoriesHint')}</p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {categories.map((category) => (
            <label key={category.categoryId} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.categoryScopeIds.includes(category.categoryId)}
                onChange={() => {
                  toggle('categoryScopeIds', category.categoryId);
                }}
              />
              {category.name}
            </label>
          ))}
        </div>
        {errors.categoryScopeIds !== undefined && (
          <p id="compliance-doc-categories-error" className="text-xs text-danger">
            {t(errors.categoryScopeIds)}
          </p>
        )}
      </fieldset>

      {form.categoryScopeIds.length > 0 && (
        <fieldset className="space-y-2 sm:col-span-2">
          <legend className="text-sm font-medium text-ink">{t('compliance.doc.requirements')}</legend>
          <p className="text-xs text-ink-muted">{t('compliance.doc.requirementsHint')}</p>
          {requirements.size === 0 ? (
            <p className="text-sm text-ink-muted">{t('compliance.doc.noRequirements')}</p>
          ) : (
            <div className="space-y-1.5">
              {[...requirements.entries()].map(([code, name]) => (
                <label key={code} className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={form.requirementCodes.includes(code)}
                    onChange={() => {
                      toggle('requirementCodes', code);
                    }}
                  />
                  <span>
                    {name} <span className="text-ink-muted">({code})</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
      )}

      <div className="sm:col-span-2">
        <Field label={t('compliance.doc.modelScope')} hint={t('compliance.doc.modelScopeHint')}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              rows={2}
              maxLength={4000}
              value={form.modelScope}
              onChange={(event) => {
                update('modelScope', event.target.value);
              }}
            />
          )}
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label={t('compliance.doc.scope')} hint={t('compliance.doc.scopeHint')}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              rows={2}
              maxLength={4000}
              value={form.scope}
              onChange={(event) => {
                update('scope', event.target.value);
              }}
            />
          )}
        </Field>
      </div>

      <Field label={t('compliance.doc.issuedOn')} error={err('issuedOn')}>
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            type="date"
            aria-describedby={describedBy}
            value={form.issuedOn}
            onChange={(event) => {
              update('issuedOn', event.target.value);
            }}
          />
        )}
      </Field>
      <Field label={t('compliance.doc.expiresOn')} error={err('expiresOn')}>
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            type="date"
            aria-describedby={describedBy}
            invalid={errors.expiresOn !== undefined}
            value={form.expiresOn}
            onChange={(event) => {
              update('expiresOn', event.target.value);
            }}
          />
        )}
      </Field>
      {form.expiresOn === '' && (
        <div className="sm:col-span-2">
          <Field label={t('compliance.doc.noExpiryReason')} required hint={t('compliance.doc.noExpiryReasonHint')} error={err('noExpiryReason')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={errors.noExpiryReason !== undefined}
                maxLength={1024}
                value={form.noExpiryReason}
                onChange={(event) => {
                  update('noExpiryReason', event.target.value);
                }}
              />
            )}
          </Field>
        </div>
      )}

      <div className="sm:col-span-2">
        <Field label={t('compliance.doc.file')} required hint={t('compliance.doc.fileHint')} error={err('file')}>
          {({ inputId, describedBy }) => (
            <input
              id={inputId}
              type="file"
              aria-describedby={describedBy}
              className="block w-full text-sm"
              onChange={(event) => {
                attempt.reset();
                setUploadedId(null);
                setFile(event.target.files?.[0] ?? null);
              }}
            />
          )}
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <Button type="submit" variant="primary" disabled={save.isPending}>
          {t('compliance.doc.submit')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={save.isPending}
          onClick={() => {
            run(false);
          }}
        >
          {t('compliance.doc.saveDraft')}
        </Button>
        <p className="text-xs text-ink-muted">{t('compliance.doc.reviewedNotAuthenticated')}</p>
      </div>
    </form>
  );
}
