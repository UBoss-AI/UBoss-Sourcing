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
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { applyApiErrors, nullIfBlank } from '@/lib/forms';
import { formatNumber, humanise } from '@/lib/format';
import { Permission } from '@/lib/permissions';

interface BusinessProfile {
  id: string;
  legalName: string;
  displayName: string;
  supportEmail: string;
  supportPhone: string | null;
  gstin: string | null;
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
  supportEmail: z.string().trim().min(1, 'A support email is required.').pipe(z.email('Enter a valid email address.')),
  supportPhone: z.string().trim().max(32),
  gstin: z.string().trim().max(32),
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
  'timezone',
  'invoicePrefix',
  'orderPrefix',
] as const;

function BusinessPanel(): React.JSX.Element {
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
      <Card title="Business profile">
        <LoadingState label="Loading the business profile" />
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card title="Business profile">
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
      title="Business profile"
      description="Appears on invoices, emails and the customer site."
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

          {!canWrite && (
            <Callout tone="neutral">
              You can read these settings but not change them. The fields are shown as they stand.
            </Callout>
          )}

          <FieldGroup legend="Identity" hint="How the business names itself to customers and on paper.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Legal name"
                hint="The registered entity, used on invoices."
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
                label="Display name"
                hint="What customers see on the storefront and in emails."
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

              <Field label="GSTIN" error={errors.gstin?.message}>
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
                label="Timezone"
                hint="IANA name, e.g. Asia/Kolkata. Recurring schedules run on this clock."
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
          </FieldGroup>

          <FieldGroup
            legend="Support contact"
            hint="Where customers are told to write when something goes wrong."
            className="border-t border-border-subtle pt-5"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Support email" error={errors.supportEmail?.message} required>
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

              <Field label="Support phone" error={errors.supportPhone?.message}>
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
            hint="Prefixes apply to numbers issued from now on. Numbers already assigned keep the prefix they were issued with."
            className="border-t border-border-subtle pt-5"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Order number prefix" error={errors.orderPrefix?.message}>
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

              <Field label="Invoice number prefix" error={errors.invoicePrefix?.message}>
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
                Currency
              </p>
              <p className="mt-0.5 text-sm font-semibold text-ink">{query.data.business.currency}</p>
              <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">
                Fixed once any order exists. Every stored amount is minor units of this currency, so
                changing the label would silently reprice all of history.
              </p>
            </div>
          </FieldGroup>
        </div>

        {canWrite && (
          <div className="flex flex-wrap items-center gap-3 border-t border-border-subtle bg-surface-sunken px-5 py-3">
            <Button type="submit" variant="primary" isLoading={save.isPending} disabled={!isDirty}>
              Save profile
            </Button>
            {isDirty && (
              <p role="status" className="text-xs font-medium text-warning">
                You have unsaved changes.
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
      isInclusive: editing?.isInclusive ?? false,
      isDefault: editing?.isDefault ?? false,
      isActive: editing?.isActive ?? true,
    },
  });

  const mutation = useMutation({
    mutationFn: (values: TaxForm) =>
      editing === null
        ? api.post<{ id: string }>('/admin/settings/tax-classes', values)
        : api.patch(`/admin/settings/tax-classes/${editing.id}`, values),
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
      description="Every product carries exactly one tax class."
      footer={
        <>
          <Button onClick={onClose} disabled={mutation.isPending}>
            Cancel
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
          <Field label="Code" hint="Used in imports and exports." error={errors.code?.message} required>
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

          <Field label="Name" error={errors.name?.message} required>
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

        <Field label="Rate (%)" error={errors.ratePercent?.message} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              inputMode="decimal"
              className="tabular sm:w-40"
              aria-describedby={describedBy}
              invalid={errors.ratePercent !== undefined}
              {...register('ratePercent')}
            />
          )}
        </Field>

        <div className="space-y-2 border-t border-border-subtle pt-4">
          <CheckboxField
            label="Prices already include this tax"
            description={
              isInclusive
                ? 'The tax is extracted from the listed price — the customer pays exactly what is shown.'
                : 'The tax is added on top of the listed price — the customer pays more than is shown.'
            }
            {...register('isInclusive')}
          />

          <CheckboxField
            label="Use as the default for new products"
            {...(isDefault && editing?.isDefault !== true
              ? {
                  description:
                    'Exactly one tax class is the default, so whichever one holds it now will lose it.',
                }
              : {})}
            {...register('isDefault')}
          />

          <CheckboxField
            label="Active"
            description="An inactive class cannot be chosen for new products. Products already on it are unaffected."
            {...register('isActive')}
          />
        </div>
      </form>
    </Modal>
  );
}

function TaxClassesPanel(): React.JSX.Element {
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
            {row.isDefault && <Badge tone="accent">Default</Badge>}
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
            Active
          </Badge>
        ) : (
          <Badge dot tone="warning">
            Inactive
          </Badge>
        ),
    },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
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
            Edit
            <span className="sr-only"> {row.name}</span>
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <Card
        title="Tax classes"
        description="Exactly one is the default, and every product carries one. Changing a rate applies to new orders — orders already placed keep the tax they were charged."
        actions={
          canWrite ? (
            <Button
              size="sm"
              onClick={() => {
                setEditorFor(null);
              }}
            >
              New tax class
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
      api.get<FlagImpactResponse>(
        `/admin/settings/feature-flags/${String(disabling?.key)}/impact`,
      ),
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
      <Card
        title="Feature flags"
        description="Whole parts of the system, on or off. Turning one on is immediate and harmless; turning one off can stop work that is already in flight, so it asks what that would cost first."
      >
        {query.isPending && <LoadingState label="Loading feature flags" />}
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
              <li key={flag.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
                <div className="min-w-56 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-ink">{humanise(flag.key)}</p>
                    {flag.enabled ? (
                      <Badge dot tone="success">
                        On
                      </Badge>
                    ) : (
                      <Badge dot tone="neutral">
                        Off
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
        confirmLabel="Turn it off"
        isDangerous
        isWorking={toggle.isPending}
        body={
          <div className="space-y-3">
            <p>{disabling?.description}</p>

            {impact.isPending && <p className="text-ink-subtle">Checking what this affects…</p>}

            {consequence !== null &&
              (consequence.count > 0 ? (
                <Callout tone="warning" title="Turning this off will:">
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
  return (
    <>
      <PageHeader
        title="Settings"
        description="Business identity, tax, and what the system does. Three panels, each with a rule the server enforces whatever this screen shows."
      />

      <div className="space-y-5">
        <BusinessPanel />
        <TaxClassesPanel />
        <FeatureFlagsPanel />
      </div>
    </>
  );
}
