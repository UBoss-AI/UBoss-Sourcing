/**
 * Settings.
 *
 * Three panels, and each has a rule worth knowing before touching it. All
 * three rules are printed on the screen rather than left in this comment,
 * because they are the sort of thing people discover by being refused:
 *
 *   - **Currency is effectively permanent.** The server refuses to change it
 *     once any order exists, because every stored amount is minor units *of
 *     that currency* and changing the label would silently reprice history.
 *     It is shown as a fact, not as a field.
 *   - **Exactly one tax class is the default.** Marking a new one default
 *     clears the old one; the server does that in one transaction so there is
 *     never a moment with none.
 *   - **Turning a feature flag off has consequences.** The impact endpoint is
 *     asked *before* the switch flips, so "1 active recurring schedule will
 *     stop producing orders" is read at decision time, not discovered after.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { ConfirmDialog, Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  CheckboxField,
  ErrorState,
  Field,
  FieldGroup,
  Input,
  LoadingState,
  PageHeader,
  Select,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { applyApiErrors, nullIfBlank } from '@/lib/forms';
import { formatNumber, humanise } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';
import { ExchangeRatesPanel } from './settings/ExchangeRatesPanel';
import { CatalogueTranslationPanel } from './settings/CatalogueTranslationPanel';
import { VatRatesPanel } from './settings/VatRatesPanel';
import { ProcessorsPanel } from './settings/ProcessorsPanel';

interface BusinessProfile {
  id: string;
  legalName: string;
  displayName: string;
  supportEmail: string;
  supportPhone: string | null;
  gstin: string | null;
  /** The seller's EU VAT number. Art. 226(3) requires it on every invoice. */
  vatNumber: string | null;
  /**
   * The member state the business is established in for VAT.
   *
   * The single switch for the whole EU VAT engine. Null means every order is
   * taxed at its tax class's own flat rate, exactly as before EU VAT existed
   * in this system.
   */
  vatCountry: string | null;
  /** Whether a listing must satisfy GPSR Art. 19 before it can publish. */
  gpsrEnforced: boolean;
  currency: string;
  timezone: string;
  invoicePrefix: string;
  orderPrefix: string;
  updatedAt: string;
}

interface TaxClass {
  id: string;
  code: string;
  name: string;
  ratePercent: string;
  /**
   * Which EU rate band this class falls in.
   *
   * Null means the class has no EU meaning: the flat rate above is used
   * wherever it is sold, which is correct for GST and for any deployment not
   * selling into the EU. Set it and the rate becomes a lookup against the
   * destination member state.
   */
  vatCategory: 'STANDARD' | 'REDUCED' | 'SUPER_REDUCED' | 'ZERO' | 'EXEMPT' | null;
  isInclusive: boolean;
  isDefault: boolean;
  isActive: boolean;
  productCount: number;
}

interface FeatureFlag {
  key: string;
  enabled: boolean;
  description: string;
  updatedAt: string;
}

/**
 * What turning a flag off would do.
 *
 * The server answers with a count and a sentence written for a person -
 * "1 active recurring schedule(s) will stop producing orders" - rather than a
 * machine-readable list this page would have to turn back into prose.
 */
interface FlagImpactResponse {
  impact: {
    count: number;
    message: string;
  };
}

const businessSchema = z.object({
  legalName: z.string().trim().min(1, 'A legal name is required.').max(255),
  displayName: z.string().trim().min(1, 'A display name is required.').max(255),
  supportEmail: z
    .string()
    .trim()
    .min(1, 'A support email is required.')
    .pipe(z.email('Enter a valid email address.')),
  supportPhone: z.string().trim().max(32),
  gstin: z.string().trim().max(32),
  vatNumber: z.string().trim().max(32),
  // Two letters or blank. Blank is the meaningful value: it turns EU VAT
  // resolution off, which is what a non-EU deployment wants.
  vatCountry: z
    .string()
    .trim()
    .toUpperCase()
    .refine((value) => value.length === 0 || value.length === 2, {
      message: 'Use a two-letter country code, or leave it blank.',
    }),
  gpsrEnforced: z.boolean(),
  timezone: z.string().trim().min(1).max(64),
  invoicePrefix: z.string().trim().max(16),
  orderPrefix: z.string().trim().max(16),
});

type BusinessForm = z.output<typeof businessSchema>;

const BUSINESS_FIELDS = [
  'legalName',
  'displayName',
  'supportEmail',
  'supportPhone',
  'gstin',
  'vatNumber',
  'vatCountry',
  'timezone',
  'invoicePrefix',
  'orderPrefix',
] as const;

function BusinessPanel(): React.JSX.Element {
  const { t } = useI18n();

  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const [formError, setFormError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['business-profile'],
    queryFn: () => api.get<{ business: BusinessProfile }>('/admin/settings/business'),
  });

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isDirty },
  } = useForm<BusinessForm>({
    resolver: zodResolver(businessSchema),
    defaultValues: {
      legalName: '',
      displayName: '',
      supportEmail: '',
      supportPhone: '',
      gstin: '',
      vatNumber: '',
      vatCountry: '',
      gpsrEnforced: false,
      timezone: '',
      invoicePrefix: '',
      orderPrefix: '',
    },
  });

  useEffect(() => {
    const business = query.data?.business;
    if (business === undefined) return;

    reset({
      legalName: business.legalName,
      displayName: business.displayName,
      supportEmail: business.supportEmail,
      supportPhone: business.supportPhone ?? '',
      gstin: business.gstin ?? '',
      vatNumber: business.vatNumber ?? '',
      vatCountry: business.vatCountry ?? '',
      gpsrEnforced: business.gpsrEnforced,
      timezone: business.timezone,
      invoicePrefix: business.invoicePrefix,
      orderPrefix: business.orderPrefix,
    });
  }, [query.data, reset]);

  const save = useMutation({
    mutationFn: (values: BusinessForm) =>
      api.patch('/admin/settings/business', {
        legalName: values.legalName,
        displayName: values.displayName,
        supportEmail: values.supportEmail,
        supportPhone: nullIfBlank(values.supportPhone),
        gstin: nullIfBlank(values.gstin),
        vatNumber: nullIfBlank(values.vatNumber),
        vatCountry: nullIfBlank(values.vatCountry),
        gpsrEnforced: values.gpsrEnforced,
        timezone: values.timezone,
        invoicePrefix: values.invoicePrefix,
        orderPrefix: values.orderPrefix,
      }),
    onSuccess: async () => {
      setFormError(null);
      toast.success('Business profile saved.');
      await queryClient.invalidateQueries({ queryKey: ['business-profile'] });
    },
    onError: (error) => {
      setFormError(applyApiErrors(error, setError, BUSINESS_FIELDS));
    },
  });

  const canWrite = can(Permission.SETTINGS_WRITE);

  if (query.isPending) {
    return (
      <Card title={t('settings.businessProfile')}>
        <LoadingState label={t('settings.loadingTheBusinessProfile')} />
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card title={t('settings.businessProfile')}>
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      </Card>
    );
  }

  return (
    <Card
      title={t('settings.businessProfile')}
      description={t('settings.appearsOnInvoicesEmailsAnd')}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit((values) => save.mutateAsync(values))();
        }}
      >
        <div className="space-y-6 px-5 py-4">
          {formError !== null && (
            <Callout tone="danger" role="alert">
              {formError}
            </Callout>
          )}

          {!canWrite && <Callout tone="neutral">{t('settings.youCanReadTheseSettings')}</Callout>}

          <FieldGroup legend="Identity" hint={t('settings.howTheBusinessNamesItself')}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t('settings.legalName')}
                hint={t('settings.theRegisteredEntityUsedOn')}
                error={errors.legalName?.message}
                required
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    invalid={errors.legalName !== undefined}
                    disabled={!canWrite}
                    {...register('legalName')}
                  />
                )}
              </Field>

              <Field
                label={t('settings.displayName')}
                hint={t('settings.whatCustomersSeeOnThe')}
                error={errors.displayName?.message}
                required
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    invalid={errors.displayName !== undefined}
                    disabled={!canWrite}
                    {...register('displayName')}
                  />
                )}
              </Field>

              <Field
                label="GSTIN"
                hint={t('settings.theIndianRegistration')}
                error={errors.gstin?.message}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    className="font-mono"
                    aria-describedby={describedBy}
                    disabled={!canWrite}
                    {...register('gstin')}
                  />
                )}
              </Field>

              <Field
                label={t('settings.euVatNumber')}
                hint={t('settings.euVatNumberHint')}
                error={errors.vatNumber?.message}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    className="font-mono"
                    placeholder="NL123456789B01"
                    aria-describedby={describedBy}
                    disabled={!canWrite}
                    {...register('vatNumber')}
                  />
                )}
              </Field>

              <Field
                label={t('settings.timezone')}
                hint={t('settings.ianaNameEGAsia')}
                error={errors.timezone?.message}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    disabled={!canWrite}
                    {...register('timezone')}
                  />
                )}
              </Field>
            </div>

            {/* The two switches that decide whether this deployment is held to
                EU rules at all. Kept together and under the identity fields,
                because both are answers to "where do we sell?" rather than to
                "what are we called?". */}
            <div className="mt-5 space-y-3 border-t border-border pt-5">
              <Field
                label={t('settings.vatCountry')}
                hint={t('settings.vatCountryHint')}
                error={errors.vatCountry?.message}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    className="font-mono sm:w-32"
                    maxLength={2}
                    placeholder="NL"
                    aria-describedby={describedBy}
                    invalid={errors.vatCountry !== undefined}
                    disabled={!canWrite}
                    {...register('vatCountry')}
                  />
                )}
              </Field>

              <CheckboxField
                boxed
                disabled={!canWrite}
                label={t('settings.gpsrEnforced')}
                description={t('settings.gpsrEnforcedHint')}
                {...register('gpsrEnforced')}
              />
            </div>
          </FieldGroup>

          <FieldGroup
            legend="Support contact"
            hint={t('settings.whereCustomersAreToldTo')}
            className="border-t border-border-subtle pt-5"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t('settings.supportEmail')}
                error={errors.supportEmail?.message}
                required
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    type="email"
                    aria-describedby={describedBy}
                    invalid={errors.supportEmail !== undefined}
                    disabled={!canWrite}
                    {...register('supportEmail')}
                  />
                )}
              </Field>

              <Field label={t('settings.supportPhone')} error={errors.supportPhone?.message}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    type="tel"
                    aria-describedby={describedBy}
                    disabled={!canWrite}
                    {...register('supportPhone')}
                  />
                )}
              </Field>
            </div>
          </FieldGroup>

          <FieldGroup
            legend="Numbering and currency"
            hint={t('settings.prefixesApplyToNumbersIssued')}
            className="border-t border-border-subtle pt-5"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('settings.orderNumberPrefix')} error={errors.orderPrefix?.message}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    className="font-mono"
                    aria-describedby={describedBy}
                    disabled={!canWrite}
                    {...register('orderPrefix')}
                  />
                )}
              </Field>

              <Field
                label={t('settings.invoiceNumberPrefix')}
                error={errors.invoicePrefix?.message}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    className="font-mono"
                    aria-describedby={describedBy}
                    disabled={!canWrite}
                    {...register('invoicePrefix')}
                  />
                )}
              </Field>
            </div>

            {/* Not a field, because it is not editable. Presenting it as a
                disabled input would invite people to try. */}
            <div className="mt-4 rounded-md border border-border bg-surface-sunken px-3 py-2.5">
              <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                {t('settings.currency')}
              </p>
              <p className="mt-0.5 text-sm font-semibold text-ink">
                {query.data.business.currency}
              </p>
              <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">
                {t('settings.fixedOnceAnyOrderExists')}
              </p>
            </div>
          </FieldGroup>
        </div>

        {canWrite && (
          <div className="flex flex-wrap items-center gap-3 border-t border-border-subtle bg-surface-sunken px-5 py-3">
            <Button type="submit" variant="primary" isLoading={save.isPending} disabled={!isDirty}>
              {t('settings.saveProfile')}
            </Button>
            {isDirty && (
              <p role="status" className="text-xs font-medium text-warning">
                {t('settings.youHaveUnsavedChanges')}
              </p>
            )}
          </div>
        )}
      </form>
    </Card>
  );
}

const taxSchema = z.object({
  code: z.string().trim().min(1, 'A code is required.').max(32),
  name: z.string().trim().min(1, 'A name is required.').max(128),
  ratePercent: z
    .string()
    .trim()
    .regex(/^\d+(\.\d+)?$/, 'Enter a rate like 18 or 18.5.'),
  // '' is the meaningful empty value here, not undefined: it means "this
  // class has no EU band", which is a choice rather than an omission.
  vatCategory: z.enum(['', 'STANDARD', 'REDUCED', 'SUPER_REDUCED', 'ZERO', 'EXEMPT']),
  isInclusive: z.boolean(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
});

type TaxForm = z.output<typeof taxSchema>;

function TaxClassDialog({
  editing,
  onClose,
}: {
  editing: TaxClass | null;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();

  const queryClient = useQueryClient();
  const toast = useToast();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors },
  } = useForm<TaxForm>({
    resolver: zodResolver(taxSchema),
    defaultValues: {
      code: editing?.code ?? '',
      name: editing?.name ?? '',
      ratePercent: editing?.ratePercent ?? '',
      vatCategory: editing?.vatCategory ?? '',
      isInclusive: editing?.isInclusive ?? false,
      isDefault: editing?.isDefault ?? false,
      isActive: editing?.isActive ?? true,
    },
  });

  const mutation = useMutation({
    mutationFn: (values: TaxForm) => {
      const body = {
        ...values,
        vatCategory: values.vatCategory === '' ? null : values.vatCategory,
      };

      return editing === null
        ? api.post<{ id: string }>('/admin/settings/tax-classes', body)
        : api.patch(`/admin/settings/tax-classes/${editing.id}`, body);
    },
    onSuccess: async () => {
      toast.success(editing === null ? 'Tax class created.' : 'Tax class saved.');
      await queryClient.invalidateQueries({ queryKey: ['tax-classes'] });
      onClose();
    },
    onError: (error) => {
      setFormError(applyApiErrors(error, setError, ['code', 'name', 'ratePercent']));
    },
  });

  const submit = (): void => {
    void handleSubmit((values) => mutation.mutateAsync(values))();
  };

  const isInclusive = watch('isInclusive');
  const isDefault = watch('isDefault');

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={editing === null ? 'New tax class' : `Edit ${editing.name}`}
      description={t('settings.everyProductCarriesExactlyOne')}
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            {t('settings.cancel')}
          </Button>
          <Button variant="primary" isLoading={mutation.isPending} onClick={submit}>
            {editing === null ? 'Create tax class' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {formError !== null && (
          <Callout tone="danger" role="alert">
            {formError}
          </Callout>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('settings.code')}
            hint={t('settings.usedInImportsAndExports')}
            error={errors.code?.message}
            required
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                className="font-mono"
                aria-describedby={describedBy}
                invalid={errors.code !== undefined}
                {...register('code')}
              />
            )}
          </Field>

          <Field label={t('settings.name')} error={errors.name?.message} required>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                invalid={errors.name !== undefined}
                {...register('name')}
              />
            )}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('settings.rate')} error={errors.ratePercent?.message} required>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                inputMode="decimal"
                className="tabular"
                aria-describedby={describedBy}
                invalid={errors.ratePercent !== undefined}
                {...register('ratePercent')}
              />
            )}
          </Field>

          <Field label={t('settings.vatBand')} hint={t('settings.vatBandHint')}>
            {({ inputId, describedBy }) => (
              <Select id={inputId} aria-describedby={describedBy} {...register('vatCategory')}>
                <option value="">{t('settings.noEuBand')}</option>
                <option value="STANDARD">{t('vatRates.category.STANDARD')}</option>
                <option value="REDUCED">{t('vatRates.category.REDUCED')}</option>
                <option value="SUPER_REDUCED">{t('vatRates.category.SUPER_REDUCED')}</option>
                <option value="ZERO">{t('vatRates.category.ZERO')}</option>
                <option value="EXEMPT">{t('vatRates.category.EXEMPT')}</option>
              </Select>
            )}
          </Field>
        </div>

        <div className="space-y-2 border-t border-border-subtle pt-4">
          <CheckboxField
            label={t('settings.pricesAlreadyIncludeThisTax')}
            description={
              isInclusive
                ? 'The tax is extracted from the listed price — the customer pays exactly what is shown.'
                : 'The tax is added on top of the listed price — the customer pays more than is shown.'
            }
            {...register('isInclusive')}
          />

          <CheckboxField
            label={t('settings.useAsTheDefaultFor')}
            {...(isDefault && editing?.isDefault !== true
              ? {
                  description:
                    'Exactly one tax class is the default, so whichever one holds it now will lose it.',
                }
              : {})}
            {...register('isDefault')}
          />

          <CheckboxField
            label={t('settings.active')}
            description={t('settings.anInactiveClassCannotBe')}
            {...register('isActive')}
          />
        </div>
      </form>
    </Modal>
  );
}

function TaxClassesPanel(): React.JSX.Element {
  const { t } = useI18n();

  const { can } = useSession();
  const [editorFor, setEditorFor] = useState<TaxClass | null | undefined>(undefined);

  const query = useQuery({
    queryKey: ['tax-classes'],
    queryFn: () => api.get<{ taxClasses: TaxClass[] }>('/admin/settings/tax-classes'),
  });

  const canWrite = can(Permission.SETTINGS_WRITE);

  const columns: Column<TaxClass>[] = [
    {
      key: 'name',
      header: 'Tax class',
      render: (row) => (
        <div className="min-w-40">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-ink">{row.name}</p>
            {row.isDefault && <Badge tone="accent">{t('settings.default')}</Badge>}
          </div>
          <p className="font-mono text-xxs text-ink-subtle">{row.code}</p>
        </div>
      ),
    },
    {
      key: 'rate',
      header: 'Rate',
      align: 'right',
      nowrap: true,
      render: (row) => <span className="font-medium text-ink">{row.ratePercent}%</span>,
    },
    {
      key: 'inclusive',
      header: 'Applied',
      render: (row) => <Badge>{row.isInclusive ? 'Included in price' : 'Added to price'}</Badge>,
    },
    {
      key: 'products',
      header: 'Products',
      align: 'right',
      secondary: true,
      render: (row) =>
        row.productCount === 0 ? (
          <span className="text-ink-subtle">0</span>
        ) : (
          formatNumber(row.productCount)
        ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) =>
        row.isActive ? (
          <Badge dot tone="success">
            {t('settings.active')}
          </Badge>
        ) : (
          <Badge dot tone="warning">
            {t('settings.inactive')}
          </Badge>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">{t('settings.actions')}</span>,
      align: 'right',
      render: (row) =>
        canWrite ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditorFor(row);
            }}
          >
            {t('settings.edit')}
            <span className="sr-only"> {row.name}</span>
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <Card
        title={t('settings.taxClasses')}
        description={t('settings.exactlyOneIsTheDefault')}
        actions={
          canWrite ? (
            <Button
              size="sm"
              onClick={() => {
                setEditorFor(null);
              }}
            >
              {t('settings.newTaxClass')}
            </Button>
          ) : undefined
        }
      >
        <DataTable
          caption="Tax classes"
          columns={columns}
          rows={query.data?.taxClasses}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          error={query.isError ? query.error : undefined}
          loadingLabel="Loading tax classes"
          minWidth="48rem"
          onRetry={() => {
            void query.refetch();
          }}
          emptyTitle="No tax classes"
          emptyDescription="A product cannot be saved without one, so at least one is needed before the catalogue opens."
        />
      </Card>

      {editorFor !== undefined && (
        <TaxClassDialog
          editing={editorFor}
          onClose={() => {
            setEditorFor(undefined);
          }}
        />
      )}
    </>
  );
}

function FeatureFlagsPanel(): React.JSX.Element {
  const { t } = useI18n();

  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const [disabling, setDisabling] = useState<FeatureFlag | null>(null);

  const query = useQuery({
    queryKey: ['feature-flags'],
    queryFn: () => api.get<{ flags: FeatureFlag[] }>('/admin/settings/feature-flags'),
  });

  // Asked before the switch flips, so the consequence is read at decision time
  // rather than discovered afterwards.
  const impact = useQuery({
    queryKey: ['flag-impact', disabling?.key],
    queryFn: () =>
      api.get<FlagImpactResponse>(`/admin/settings/feature-flags/${String(disabling?.key)}/impact`),
    enabled: disabling !== null,
  });

  const toggle = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      api.patch(`/admin/settings/feature-flags/${key}`, { enabled }),
    onSuccess: async () => {
      setDisabling(null);
      toast.success('Feature flag updated.');
      await queryClient.invalidateQueries({ queryKey: ['feature-flags'] });
    },
    onError: (error) => {
      setDisabling(null);
      toast.error(error instanceof ApiError ? error.message : 'The flag could not be changed.');
    },
  });

  const canWrite = can(Permission.FEATURE_FLAG_WRITE);

  const consequence = impact.data?.impact ?? null;

  return (
    <>
      <Card title={t('settings.featureFlags')} description={t('settings.wholePartsOfTheSystem')}>
        {query.isPending && <LoadingState label={t('settings.loadingFeatureFlags')} />}
        {query.isError && (
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        )}

        {query.data !== undefined && (
          <ul className="divide-y divide-border">
            {query.data.flags.map((flag) => (
              <li
                key={flag.key}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5"
              >
                <div className="min-w-56 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-ink">{humanise(flag.key)}</p>
                    {flag.enabled ? (
                      <Badge dot tone="success">
                        On
                      </Badge>
                    ) : (
                      <Badge dot tone="neutral">
                        {t('settings.off')}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 max-w-prose text-xs leading-relaxed text-ink-muted">
                    {flag.description}
                  </p>
                </div>

                {canWrite && (
                  <Button
                    size="sm"
                    // Turning something on has no downstream victims, so it is
                    // the plain primary. Turning it off is the one that needs
                    // a moment's thought, and it goes through a confirmation
                    // that has read the impact first.
                    variant={flag.enabled ? 'secondary' : 'primary'}
                    onClick={() => {
                      if (flag.enabled) setDisabling(flag);
                      else toggle.mutate({ key: flag.key, enabled: true });
                    }}
                    // Only the "turn on" path spins here; "turn off" hands over
                    // to the confirmation dialog, which does its own waiting.
                    isLoading={
                      toggle.isPending &&
                      toggle.variables.key === flag.key &&
                      toggle.variables.enabled
                    }
                  >
                    {flag.enabled ? 'Turn off' : 'Turn on'}
                    <span className="sr-only"> {humanise(flag.key)}</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        isOpen={disabling !== null}
        onClose={() => {
          setDisabling(null);
        }}
        onConfirm={() => {
          if (disabling !== null) toggle.mutate({ key: disabling.key, enabled: false });
        }}
        title={`Turn off ${disabling === null ? 'this feature' : humanise(disabling.key)}?`}
        confirmLabel={t('settings.turnItOff')}
        isDangerous
        isWorking={toggle.isPending}
        body={
          <div className="space-y-3">
            <p>{disabling?.description}</p>

            {impact.isPending && (
              <p className="text-ink-subtle">{t('settings.checkingWhatThisAffects')}</p>
            )}

            {consequence !== null &&
              (consequence.count > 0 ? (
                <Callout tone="warning" title={t('settings.turningThisOffWill')}>
                  {consequence.message}
                </Callout>
              ) : (
                <p className="text-ink-muted">{consequence.message}</p>
              ))}
          </div>
        }
      />
    </>
  );
}

export function SettingsPage(): React.JSX.Element {
  const { t } = useI18n();

  return (
    <>
      <PageHeader
        title={t('settings.settings')}
        description={t('settings.businessIdentityTaxAndWhat')}
      />

      <div className="space-y-5">
        <BusinessPanel />
        <TaxClassesPanel />
        {/* Directly under the tax classes: a class carries the BAND, this
            carries the percentage that band means in each member state, and
            neither is readable without the other. */}
        <VatRatesPanel />
        {/* Below tax because it is downstream of it: a converted price is still
            taxed by the class on the product. Above feature flags because this
            one changes what customers are charged. */}
        <ExchangeRatesPanel />
        {/* Beside the exchange rate panel because they are the same job seen
            twice: what a market is quoted in, and what it reads. */}
        <CatalogueTranslationPanel />
        <FeatureFlagsPanel />
        {/* Last, because it is a report rather than a setting - nothing on it
            is editable, and it is read against a register rather than used to
            change anything. */}
        <ProcessorsPanel />
      </div>
    </>
  );
}
