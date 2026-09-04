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
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
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
interface CurrencyTermsDraft {
  perOrderMin: string;
  perOrderMax: string;
  monthlyCap: string;
  approvalThreshold: string;
}

const blankTerms = (): CurrencyTermsDraft => ({
  perOrderMin: '',
  perOrderMax: '',
  monthlyCap: '',
  approvalThreshold: '',
});

/**
 * Ordering limits, one set of terms per currency.
 *
 * The amounts have to be per currency: a 5,000 figure means nothing until you
 * know whether it counts rupees or dollars, and reading one market's number
 * against another's cart is how a Rs 500 minimum silently becomes a $500 one.
 *
 * `requiresOrderApproval` sits outside the grid because it is a policy about
 * the account, not an amount.
 *
 * One currency is edited at a time rather than showing every market's four
 * fields at once - eight currencies would be thirty-two inputs on a screen
 * where each one changes what a customer is allowed to spend.
 */
function LimitsPanel({ customer }: { customer: CustomerDetail }): React.JSX.Element {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useSession();

  const [formError, setFormError] = useState<string | null>(null);
  const [approval, setApproval] = useState(customer.limits.requiresOrderApproval);
  const [selected, setSelected] = useState<string>(
    () => customer.limits.perCurrency[0]?.currencyCode ?? '',
  );

  const toMajor = (minor: string | null): string => (minor === null ? '' : minorToMajor(minor));

  /** Everything typed so far, keyed by currency, in major units. */
  const [draft, setDraft] = useState<Record<string, CurrencyTermsDraft>>(() =>
    Object.fromEntries(
      customer.limits.perCurrency.map((row) => [
        row.currencyCode,
        {
          perOrderMin: toMajor(row.perOrderMinMinor),
          perOrderMax: toMajor(row.perOrderMaxMinor),
          monthlyCap: toMajor(row.monthlySpendCapMinor),
          approvalThreshold: toMajor(row.approvalThresholdMinor),
        },
      ]),
    ),
  );

  const canWrite = can(Permission.CUSTOMER_LIMITS_WRITE);

  // The currency list comes from the public config - the same list the
  // storefront prices in, so staff cannot agree terms in a market that does
  // not exist.
  const config = useQuery({
    queryKey: ['storefront-config'],
    queryFn: () => api.get<{ localisation: { currencies: { code: string; name: string }[] } }>('/config'),
    staleTime: 5 * 60_000,
  });

  const allCurrencies = config.data?.localisation.currencies ?? [];
  const agreed = Object.keys(draft).sort();
  const current = selected === '' ? undefined : draft[selected];

  const setField = (field: keyof CurrencyTermsDraft, value: string): void => {
    if (selected === '') return;
    setDraft((previous) => ({
      ...previous,
      [selected]: { ...blankTerms(), ...previous[selected], [field]: value },
    }));
  };

  const addCurrency = (code: string): void => {
    if (code === '' || code in draft) return;
    setDraft((previous) => ({ ...previous, [code]: blankTerms() }));
    setSelected(code);
    setFormError(null);
  };

  const removeCurrency = (code: string): void => {
    setDraft((previous) =>
      Object.fromEntries(Object.entries(previous).filter(([key]) => key !== code)),
    );
    setSelected((prior) => (prior === code ? '' : prior));
  };

  const save = useMutation({
    mutationFn: () => {
      const perCurrency: Record<string, unknown>[] = [];

      for (const [code, terms] of Object.entries(draft)) {
        const amount = (value: string): string | null =>
          value.trim() === '' ? null : majorToMinor(value.trim());

        const min = amount(terms.perOrderMin);
        const max = amount(terms.perOrderMax);

        if (min !== null && max !== null && BigInt(max) < BigInt(min)) {
          throw new Error(`The maximum ${code} order value cannot be lower than the minimum.`);
        }

        perCurrency.push({
          currencyCode: code,
          perOrderMinMinor: min,
          perOrderMaxMinor: max,
          monthlySpendCapMinor: amount(terms.monthlyCap),
          approvalThresholdMinor: amount(terms.approvalThreshold),
        });
      }

      return api.patch(`/admin/customers/${customer.id}/limits`, {
        requiresOrderApproval: approval,
        perCurrency,
      });
    },
    onSuccess: async () => {
      toast.success('Limits saved.');
      setFormError(null);
      await queryClient.invalidateQueries({ queryKey: ['customer', customer.id] });
    },
    onError: (error: unknown) => {
      setFormError(
        error instanceof ApiError || error instanceof Error
          ? error.message
          : 'Those limits could not be saved.',
      );
    },
  });

  return (
    <Card
      title="Ordering limits"
      description="Agreed terms per market. A currency with no terms is one this account cannot order in."
    >
      <div className="space-y-5 px-5 py-4">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            checked={approval}
            disabled={!canWrite}
            onChange={(event) => {
              setApproval(event.target.checked);
            }}
            className="mt-0.5"
          />
          <span className="text-sm text-ink">
            Orders need approval
            <span className="block text-xs text-ink-muted">
              Applies to the whole account. The value that triggers it is set per currency below.
            </span>
          </span>
        </label>

        <div className="border-t border-border pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
              Terms in
            </span>

            {agreed.length === 0 && (
              <span className="text-sm text-ink-muted">
                None yet — this account cannot order in any currency.
              </span>
            )}

            {agreed.map((code) => (
              <button
                key={code}
                type="button"
                onClick={() => {
                  setSelected(code);
                }}
                className={
                  code === selected
                    ? 'rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-white'
                    : 'rounded-md border border-border-strong px-2.5 py-1 text-xs font-medium text-ink hover:border-accent'
                }
              >
                {code}
              </button>
            ))}

            {canWrite && (
              <select
                value=""
                onChange={(event) => {
                  addCurrency(event.target.value);
                }}
                aria-label="Add terms for a currency"
                className="rounded-md border border-border-strong bg-surface px-2 py-1 text-xs text-ink"
              >
                <option value="">Add currency…</option>
                {allCurrencies
                  .filter((entry) => !(entry.code in draft))
                  .map((entry) => (
                    <option key={entry.code} value={entry.code}>
                      {entry.code} — {entry.name}
                    </option>
                  ))}
              </select>
            )}
          </div>

          {current !== undefined && (
            <div className="mt-4 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={`Minimum per order (${selected})`}>
                  {({ inputId }) => (
                    <Input
                      id={inputId}
                      inputMode="decimal"
                      className="tabular"
                      placeholder="No minimum"
                      disabled={!canWrite}
                      value={current.perOrderMin}
                      onChange={(event) => {
                        setField('perOrderMin', event.target.value);
                      }}
                    />
                  )}
                </Field>

                <Field label={`Maximum per order (${selected})`}>
                  {({ inputId }) => (
                    <Input
                      id={inputId}
                      inputMode="decimal"
                      className="tabular"
                      placeholder="No maximum"
                      disabled={!canWrite}
                      value={current.perOrderMax}
                      onChange={(event) => {
                        setField('perOrderMax', event.target.value);
                      }}
                    />
                  )}
                </Field>

                <Field
                  label={`Monthly cap (${selected})`}
                  hint="Counts only orders placed in this currency."
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      inputMode="decimal"
                      className="tabular"
                      placeholder="No cap"
                      disabled={!canWrite}
                      value={current.monthlyCap}
                      onChange={(event) => {
                        setField('monthlyCap', event.target.value);
                      }}
                    />
                  )}
                </Field>

                <Field
                  label={`Approval above (${selected})`}
                  hint={
                    approval
                      ? 'Blank means every order needs approval.'
                      : 'Only used while approvals are on.'
                  }
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      inputMode="decimal"
                      className="tabular"
                      placeholder="Every order"
                      disabled={!canWrite}
                      value={current.approvalThreshold}
                      onChange={(event) => {
                        setField('approvalThreshold', event.target.value);
                      }}
                    />
                  )}
                </Field>
              </div>

              {canWrite && (
                <button
                  type="button"
                  onClick={() => {
                    removeCurrency(selected);
                  }}
                  className="text-xs font-medium text-danger hover:underline"
                >
                  Remove {selected} terms — this account will not be able to order in it
                </button>
              )}
            </div>
          )}
        </div>

        {formError !== null && (
          <p role="alert" className="text-sm font-medium text-danger">
            {formError}
          </p>
        )}

        {canWrite && (
          <Button
            type="button"
            variant="primary"
            isLoading={save.isPending}
            onClick={() => {
              save.mutate();
            }}
          >
            Save limits
          </Button>
        )}
      </div>
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
