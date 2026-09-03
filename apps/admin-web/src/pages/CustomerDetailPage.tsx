/**
 * Customer detail.
 *
 * The limits panel is the consequential one. These numbers decide what the
 * customer can order and what has to be approved first, so:
 *
 *   - Amounts are typed in major units and sent in minor units by digit
 *     shifting. Never `value * 100`.
 *   - **Blank means no limit.** Zero would block every order, and the two must
 *     never be confused — so the fields send `null`, not `"0"`, when empty.
 *   - Turning approvals on with a blank threshold means *every* order needs
 *     approval, and the form says so rather than leaving it to be discovered.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { ConfirmDialog } from '@/components/Modal';
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
import { applyApiErrors } from '@/lib/forms';
import { formatDateTime, majorToMinor, minorToMajor } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { customerStatusTone } from '@/lib/customers';
import type { CustomerLimits } from '@/lib/customers';

interface CustomerAddress {
  id: string;
  kind: string;
  label: string | null;
  contactName: string;
  contactPhone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  isDefaultBilling: boolean;
  isDefaultShipping: boolean;
  archivedAt: string | null;
}

interface CustomerDetail {
  id: string;
  userId: string;
  email: string;
  status: string;
  fullName: string | null;
  organization: string | null;
  department: string | null;
  phone: string | null;
  gstin: string | null;
  customerCode: string | null;
  internalNotes: string | null;
  consentAcceptedAt: string | null;
  invitedAt: string | null;
  activatedAt: string | null;
  lastLoginAt: string | null;
  limits: CustomerLimits;
  addresses: CustomerAddress[];
}

/** Blank is allowed and means "no limit". Zero is not the same thing. */
const optionalMoney = z.union([
  z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'Enter an amount like 5000.00, or leave blank.'),
  z.literal(''),
]);

const limitsSchema = z
  .object({
    perOrderMin: optionalMoney,
    perOrderMax: optionalMoney,
    monthlyCap: optionalMoney,
    requiresOrderApproval: z.boolean(),
    approvalThreshold: optionalMoney,
  })
  .superRefine((values, ctx) => {
    if (values.perOrderMin !== '' && values.perOrderMax !== '') {
      const min = majorToMinor(values.perOrderMin);
      const max = majorToMinor(values.perOrderMax);
      if (min !== null && max !== null && BigInt(max) < BigInt(min)) {
        // Otherwise no order value satisfies both and the customer is locked
        // out with no explanation at checkout.
        ctx.addIssue({
          code: 'custom',
          path: ['perOrderMax'],
          message: 'The maximum cannot be below the minimum, or no order would be allowed at all.',
        });
      }
    }
  });

type LimitsForm = z.output<typeof limitsSchema>;

function LimitsPanel({ customer }: { customer: CustomerDetail }): React.JSX.Element {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useSession();
  const [formError, setFormError] = useState<string | null>(null);

  const toMajor = (minor: string | null): string => (minor === null ? '' : minorToMajor(minor));

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setError,
    formState: { errors, isDirty },
  } = useForm<LimitsForm>({
    resolver: zodResolver(limitsSchema),
    defaultValues: {
      perOrderMin: toMajor(customer.limits.perOrderMinMinor),
      perOrderMax: toMajor(customer.limits.perOrderMaxMinor),
      monthlyCap: toMajor(customer.limits.monthlySpendCapMinor),
      requiresOrderApproval: customer.limits.requiresOrderApproval,
      approvalThreshold: toMajor(customer.limits.approvalThresholdMinor),
    },
  });

  useEffect(() => {
    reset({
      perOrderMin: toMajor(customer.limits.perOrderMinMinor),
      perOrderMax: toMajor(customer.limits.perOrderMaxMinor),
      monthlyCap: toMajor(customer.limits.monthlySpendCapMinor),
      requiresOrderApproval: customer.limits.requiresOrderApproval,
      approvalThreshold: toMajor(customer.limits.approvalThresholdMinor),
    });
  }, [customer.limits, reset]);

  const save = useMutation({
    mutationFn: (values: LimitsForm) =>
      api.patch(`/admin/customers/${customer.id}/limits`, {
        // null, not "0" - an empty field means no limit, and zero would stop
        // every order.
        perOrderMinMinor: values.perOrderMin === '' ? null : majorToMinor(values.perOrderMin),
        perOrderMaxMinor: values.perOrderMax === '' ? null : majorToMinor(values.perOrderMax),
        monthlySpendCapMinor: values.monthlyCap === '' ? null : majorToMinor(values.monthlyCap),
        requiresOrderApproval: values.requiresOrderApproval,
        approvalThresholdMinor:
          values.approvalThreshold === '' ? null : majorToMinor(values.approvalThreshold),
      }),
    onSuccess: async () => {
      setFormError(null);
      toast.success('Limits saved.');
      await queryClient.invalidateQueries({ queryKey: ['customer', customer.id] });
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
    onError: (error) => {
      setFormError(
        applyApiErrors(error, setError, [
          'perOrderMin',
          'perOrderMax',
          'monthlyCap',
          'approvalThreshold',
        ]),
      );
    },
  });

  const canWrite = can(Permission.CUSTOMER_LIMITS_WRITE);
  const requiresApproval = watch('requiresOrderApproval');
  const threshold = watch('approvalThreshold');

  return (
    <Card
      title="Ordering limits"
      description="Enforced at checkout. Leave a field blank for no limit."
    >
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

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Minimum per order" error={errors.perOrderMin?.message}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                inputMode="decimal"
                className="tabular"
                placeholder="No minimum"
                aria-describedby={describedBy}
                invalid={errors.perOrderMin !== undefined}
                disabled={!canWrite}
                {...register('perOrderMin')}
              />
            )}
          </Field>

          <Field label="Maximum per order" error={errors.perOrderMax?.message}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                inputMode="decimal"
                className="tabular"
                placeholder="No maximum"
                aria-describedby={describedBy}
                invalid={errors.perOrderMax !== undefined}
                disabled={!canWrite}
                {...register('perOrderMax')}
              />
            )}
          </Field>

          <Field label="Monthly spend cap" error={errors.monthlyCap?.message}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                inputMode="decimal"
                className="tabular"
                placeholder="No cap"
                aria-describedby={describedBy}
                invalid={errors.monthlyCap !== undefined}
                disabled={!canWrite}
                {...register('monthlyCap')}
              />
            )}
          </Field>
        </div>

        <div className="space-y-3 border-t border-border pt-4">
          <label className="flex items-start gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-border-strong text-accent"
              disabled={!canWrite}
              {...register('requiresOrderApproval')}
            />
            <span>Orders from this customer need approval before they are confirmed</span>
          </label>

          {requiresApproval && (
            <>
              <Field
                label="Approval threshold"
                hint="Orders at or above this value need approval. Blank means every order does."
                error={errors.approvalThreshold?.message}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    inputMode="decimal"
                    className="tabular sm:w-56"
                    placeholder="Every order"
                    aria-describedby={describedBy}
                    invalid={errors.approvalThreshold !== undefined}
                    disabled={!canWrite}
                    {...register('approvalThreshold')}
                  />
                )}
              </Field>

              {threshold === '' && (
                <p role="status" className="text-xs text-warning">
                  With no threshold, every order this customer places will wait for a Finance
                  Approver.
                </p>
              )}
            </>
          )}
        </div>

        {canWrite && (
          <Button type="submit" variant="primary" isLoading={save.isPending} disabled={!isDirty}>
            Save limits
          </Button>
        )}
      </form>
    </Card>
  );
}

export function CustomerDetailPage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [suspending, setSuspending] = useState(false);

  const query = useQuery({
    queryKey: ['customer', id],
    queryFn: () => api.get<{ customer: CustomerDetail }>(`/admin/customers/${String(id)}`),
    enabled: id !== undefined,
  });

  const invite = useMutation({
    mutationFn: () => api.post(`/admin/customers/${String(id)}/invite`),
    onSuccess: async () => {
      toast.success('Invitation sent.');
      await queryClient.invalidateQueries({ queryKey: ['customer', id] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'The invitation could not be sent.');
    },
  });

  const setStatus = useMutation({
    mutationFn: (active: boolean) =>
      api.patch(`/admin/customers/${String(id)}/status`, { active }),
    onSuccess: async (_result, active) => {
      setSuspending(false);
      toast.success(active ? 'Customer reactivated.' : 'Customer suspended.');
      await queryClient.invalidateQueries({ queryKey: ['customer', id] });
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
    onError: (error) => {
      setSuspending(false);
      toast.error(error instanceof ApiError ? error.message : 'The status could not be changed.');
    },
  });

  if (query.isPending) {
    return (
      <Card>
        <LoadingState label="Loading the customer" />
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      </Card>
    );
  }

  const customer = query.data.customer;
  const isActive = customer.status === 'ACTIVE';

  return (
    <>
      <PageHeader
        title={customer.fullName ?? customer.email}
        description={customer.organization ?? customer.email}
        actions={
          <Link
            to="/customers"
            className="inline-flex h-9 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-sunken"
          >
            Back to customers
          </Link>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-5">
          <Card title="Account">
            <dl className="grid gap-x-6 gap-y-3 px-5 py-4 text-sm sm:grid-cols-2">
              {[
                ['Email', customer.email],
                ['Contact', customer.fullName ?? '—'],
                ['Organisation', customer.organization ?? '—'],
                ['Department', customer.department ?? '—'],
                ['Phone', customer.phone ?? '—'],
                ['GSTIN', customer.gstin ?? '—'],
                ['Customer code', customer.customerCode ?? '—'],
                ['Invited', formatDateTime(customer.invitedAt)],
                ['Activated', formatDateTime(customer.activatedAt)],
                ['Last sign-in', formatDateTime(customer.lastLoginAt)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                    {label}
                  </dt>
                  <dd className="mt-0.5 text-ink">{value}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <LimitsPanel customer={customer} />

          <Card title="Addresses" description="Used at checkout for billing and delivery.">
            {customer.addresses.length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-ink-muted">
                No addresses yet. The customer can add one at checkout.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {customer.addresses
                  .filter((address) => address.archivedAt === null)
                  .map((address) => (
                    <li key={address.id} className="px-5 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-ink">{address.contactName}</span>
                        <Badge>{address.kind === 'BOTH' ? 'Billing & shipping' : address.kind}</Badge>
                        {address.isDefaultShipping && <Badge tone="accent">Default shipping</Badge>}
                        {address.isDefaultBilling && <Badge tone="accent">Default billing</Badge>}
                      </div>
                      <address className="mt-1 text-sm not-italic text-ink-muted">
                        {address.line1}
                        {address.line2 !== null && `, ${address.line2}`}, {address.city},{' '}
                        {address.state} {address.postalCode}, {address.country}
                        <span className="ml-2">{address.contactPhone}</span>
                      </address>
                    </li>
                  ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card title="Status">
            <div className="space-y-3 px-5 py-4">
              <Badge tone={customerStatusTone(customer.status)}>{humaniseStatus(customer.status)}</Badge>

              {customer.activatedAt === null && (
                <p className="text-xs text-ink-muted">
                  This account has not been activated. The customer sets their own password from the
                  invitation — nobody here can set it for them.
                </p>
              )}

              {can(Permission.CUSTOMER_INVITE) && customer.activatedAt === null && (
                <Button
                  className="w-full"
                  isLoading={invite.isPending}
                  onClick={() => {
                    invite.mutate();
                  }}
                >
                  {customer.invitedAt === null ? 'Send invitation' : 'Resend invitation'}
                </Button>
              )}

              {can(Permission.CUSTOMER_STATUS_WRITE) && (
                <Button
                  className="w-full"
                  variant={isActive ? 'danger' : 'primary'}
                  isLoading={setStatus.isPending}
                  onClick={() => {
                    if (isActive) setSuspending(true);
                    else setStatus.mutate(true);
                  }}
                >
                  {isActive ? 'Suspend customer' : 'Reactivate customer'}
                </Button>
              )}
            </div>
          </Card>

          <Card title="Consent">
            <div className="px-5 py-4 text-sm">
              {customer.consentAcceptedAt === null ? (
                <p className="text-ink-muted">Not yet accepted.</p>
              ) : (
                <p className="text-ink">
                  Accepted {formatDateTime(customer.consentAcceptedAt)}
                </p>
              )}
            </div>
          </Card>

          {customer.internalNotes !== null && (
            <Card title="Internal notes" description="Staff only.">
              <p className="whitespace-pre-wrap px-5 py-4 text-sm text-ink">
                {customer.internalNotes}
              </p>
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        isOpen={suspending}
        onClose={() => {
          setSuspending(false);
        }}
        onConfirm={() => {
          setStatus.mutate(false);
        }}
        title={`Suspend ${customer.fullName ?? customer.email}?`}
        confirmLabel="Suspend customer"
        isDangerous
        isWorking={setStatus.isPending}
        body="They will not be able to sign in or place orders. Existing orders and recurring schedules are not cancelled."
      />
    </>
  );
}

function humaniseStatus(status: string): string {
  return status.charAt(0) + status.slice(1).toLowerCase();
}
