/**
 * Settings.
 *
 * Three panels, and each has a rule worth knowing before touching it:
 *
 *   - **Currency is effectively permanent.** The server refuses to change it
 *     once any order exists, because every stored amount is minor units *of
 *     that currency* and changing the label would silently reprice history.
 *     The field says so rather than letting someone find out by being refused.
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
  Card,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { applyApiErrors, nullIfBlank } from '@/lib/forms';
import { formatNumber } from '@/lib/format';
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
        <LoadingState />
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
    <Card title="Business profile" description="Appears on invoices, emails and the customer site.">
      <form
        className="space-y-4 px-5 py-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit((values) => save.mutateAsync(values))();
        }}
      >
        {formError !== null && (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
          >
            {formError}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Legal name" error={errors.legalName?.message} required>
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

          <Field label="Display name" error={errors.displayName?.message} required>
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

        <div className="rounded-md border border-border bg-surface-sunken px-3 py-2.5">
          <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">Currency</p>
          <p className="mt-0.5 text-sm font-medium text-ink">{query.data.business.currency}</p>
          <p className="mt-1 text-xs text-ink-muted">
            Fixed once any order exists. Every stored amount is minor units of this currency, so
            changing the label would silently reprice all of history.
          </p>
        </div>

        {canWrite && (
          <Button type="submit" variant="primary" isLoading={save.isPending} disabled={!isDirty}>
            Save profile
          </Button>
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

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={editing === null ? 'New tax class' : `Edit ${editing.name}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" isLoading={mutation.isPending} onClick={submit}>
            {editing === null ? 'Create tax class' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {formError !== null && (
          <div
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
          >
            {formError}
          </div>
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

        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-border-strong text-accent"
              {...register('isInclusive')}
            />
            <span>
              Prices already include this tax
              <span className="mt-0.5 block text-xs text-ink-muted">
                {isInclusive
                  ? 'The tax is extracted from the listed price.'
                  : 'The tax is added on top of the listed price.'}
              </span>
            </span>
          </label>

          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border-strong text-accent"
              {...register('isDefault')}
            />
            Use as the default for new products
          </label>

          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border-strong text-accent"
              {...register('isActive')}
            />
            Active
          </label>
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
        <div>
          <p className="font-medium text-ink">{row.name}</p>
          <p className="font-mono text-xxs text-ink-subtle">{row.code}</p>
        </div>
      ),
    },
    { key: 'rate', header: 'Rate', align: 'right', render: (row) => `${row.ratePercent}%` },
    {
      key: 'inclusive',
      header: 'Applied',
      render: (row) => <Badge>{row.isInclusive ? 'Included in price' : 'Added to price'}</Badge>,
    },
    {
      key: 'default',
      header: 'Default',
      render: (row) => (row.isDefault ? <Badge tone="accent">Default</Badge> : null),
    },
    {
      key: 'products',
      header: 'Products',
      align: 'right',
      secondary: true,
      render: (row) => formatNumber(row.productCount),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) =>
        row.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="warning">Inactive</Badge>,
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
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <Card
        title="Tax classes"
        description="Exactly one is the default. Every product carries one."
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
          emptyTitle="No tax classes"
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
      <Card title="Feature flags" description="Turn parts of the system on and off.">
        {query.isPending && <LoadingState />}
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
              <li key={flag.key} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <div className="min-w-56 flex-1">
                  <p className="text-sm font-medium text-ink">
                    {flag.key
                      .split('_')
                      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
                      .join(' ')}
                  </p>
                  <p className="text-xs text-ink-muted">{flag.description}</p>
                </div>

                {flag.enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}

                {canWrite && (
                  <Button
                    size="sm"
                    onClick={() => {
                      // Turning something on has no downstream victims; turning
                      // it off can stop work that is already in flight.
                      if (flag.enabled) setDisabling(flag);
                      else toggle.mutate({ key: flag.key, enabled: true });
                    }}
                  >
                    {flag.enabled ? 'Turn off' : 'Turn on'}
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
        title={`Turn off ${disabling?.key ?? 'this feature'}?`}
        confirmLabel="Turn it off"
        isDangerous
        isWorking={toggle.isPending}
        body={
          <div className="space-y-2">
            <p>{disabling?.description}</p>

            {impact.isPending && <p className="text-ink-subtle">Checking what this affects…</p>}

            {consequence !== null &&
              (consequence.count > 0 ? (
                <div className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5">
                  <p className="font-medium text-warning">Turning this off will:</p>
                  <p className="mt-1 text-ink">{consequence.message}</p>
                </div>
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
      <PageHeader title="Settings" description="Business identity, tax, and what the system does." />

      <div className="space-y-5">
        <BusinessPanel />
        <TaxClassesPanel />
        <FeatureFlagsPanel />
      </div>
    </>
  );
}
