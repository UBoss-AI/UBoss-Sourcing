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
 *     Every one of them says so in its placeholder rather than leaving an
 *     empty box to be read as an unset zero.
 *   - Turning approvals on with a blank threshold means *every* order needs
 *     approval, and the form says so rather than leaving it to be discovered.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { ConfirmDialog } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  CheckboxField,
  DescriptionList,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { cx } from '@/lib/cx';
import { formatDateTime, humanise, majorToMinor, minorToMajor } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { customerStatusTone } from '@/lib/customers';
import type { CustomerLimits } from '@/lib/customers';
import { VatNumberPanel } from '@/pages/customer/VatNumberPanel';
import { useI18n } from '@/i18n/i18n-context';

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

  /**
   * The EU VAT number, and what VIES made of it.
   *
   * `vatNumberValid` has three states: true, false, and null for "never
   * checked". Only the first zero-rates a cross-border supply.
   */
  vatNumber: string | null;
  vatNumberValid: boolean | null;
  vatNumberCheckedAt: string | null;
  vatNumberReference: string | null;

  customerCode: string | null;
  internalNotes: string | null;
  consentAcceptedAt: string | null;
  /** Null while a self-registered account has not opened its confirmation link. */
  emailVerifiedAt: string | null;
  invitedAt: string | null;
  /** True when they signed themselves up rather than being invited by staff. */
  selfRegistered: boolean;
  preferredCountry: string | null;
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
  const { t } = useI18n();

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
    queryFn: () =>
      api.get<{ localisation: { currencies: { code: string; name: string }[] } }>('/config'),
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

  const unusedCurrencies = allCurrencies.filter((entry) => !(entry.code in draft));

  return (
    <Card
      title={t('customerDetail.orderingLimits')}
      description={t('customerDetail.agreedTermsPerMarketA')}
    >
      <div className="space-y-5 px-5 py-4">
        <CheckboxField
          boxed
          label={t('customerDetail.ordersNeedApproval')}
          description={t('customerDetail.appliesToTheWholeAccount')}
          checked={approval}
          disabled={!canWrite}
          onChange={(event) => {
            setApproval(event.target.checked);
          }}
        />

        <div className="border-t border-border-subtle pt-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
              {t('customerDetail.termsIn')}
            </span>

            {agreed.length === 0 && (
              <span className="text-sm text-warning">
                {t('customerDetail.noneYetThisAccountCannot')}
              </span>
            )}

            {agreed.map((code) => (
              <button
                key={code}
                type="button"
                // `aria-pressed`, because this is a toggle between which set of
                // terms is on screen, not a navigation.
                aria-pressed={code === selected}
                onClick={() => {
                  setSelected(code);
                }}
                className={cx(
                  'h-8 rounded-md px-3 text-xs font-semibold transition-[background-color,border-color,color]',
                  code === selected
                    ? 'bg-accent text-white shadow-card'
                    : 'border border-border-strong bg-surface text-ink hover:border-border-hover hover:bg-surface-hover',
                )}
              >
                {code}
              </button>
            ))}

            {canWrite && unusedCurrencies.length > 0 && (
              <Select
                value=""
                onChange={(event) => {
                  addCurrency(event.target.value);
                }}
                aria-label={t('customerDetail.addTermsForACurrency')}
                className="h-8 w-44 py-0 text-xs"
              >
                <option value="">{t('customerDetail.addCurrency')}</option>
                {unusedCurrencies.map((entry) => (
                  <option key={entry.code} value={entry.code}>
                    {entry.code} — {entry.name}
                  </option>
                ))}
              </Select>
            )}
          </div>

          {current !== undefined && (
            <div className="mt-4 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label={`Minimum per order (${selected})`}
                  hint={t('customerDetail.blankMeansNoMinimum')}
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      inputMode="decimal"
                      className="tabular"
                      placeholder={t('customerDetail.noMinimum')}
                      disabled={!canWrite}
                      value={current.perOrderMin}
                      onChange={(event) => {
                        setField('perOrderMin', event.target.value);
                      }}
                    />
                  )}
                </Field>

                <Field
                  label={`Maximum per order (${selected})`}
                  hint={t('customerDetail.blankMeansNoMaximum')}
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      inputMode="decimal"
                      className="tabular"
                      placeholder={t('customerDetail.noMaximum')}
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
                  hint={t('customerDetail.countsOnlyOrdersPlacedIn')}
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      inputMode="decimal"
                      className="tabular"
                      placeholder={t('customerDetail.noCap')}
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
                      : 'Only used while approvals are on, which they are not.'
                  }
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      inputMode="decimal"
                      className="tabular"
                      placeholder={t('customerDetail.everyOrder')}
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
                // Quiet, and it says what it costs. Removing a market is not a
                // red-button moment, but it is not a tidy-up either.
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-danger hover:bg-danger-soft hover:text-danger"
                  onClick={() => {
                    removeCurrency(selected);
                  }}
                >
                  Remove {selected} terms — this account will no longer be able to order in it
                </Button>
              )}
            </div>
          )}
        </div>

        {formError !== null && (
          <Callout tone="danger" role="alert">
            {formError}
          </Callout>
        )}

        {canWrite && (
          <div className="border-t border-border-subtle pt-4">
            <Button
              type="button"
              variant="primary"
              isLoading={save.isPending}
              onClick={() => {
                save.mutate();
              }}
            >
              {t('customerDetail.saveLimits')}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

export function CustomerDetailPage(): React.JSX.Element {
  const { t } = useI18n();

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

  const approve = useMutation({
    mutationFn: () => api.post(`/admin/customers/${String(id)}/approve`, {}),
    onSuccess: async () => {
      toast.success('Customer approved. They can sign in now.');
      await queryClient.invalidateQueries({ queryKey: ['customer', id] });
      await queryClient.invalidateQueries({ queryKey: ['customers'] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : 'The customer could not be approved.');
    },
  });

  const setStatus = useMutation({
    mutationFn: (active: boolean) => api.patch(`/admin/customers/${String(id)}/status`, { active }),
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
      <>
        <PageHeader
          title={t('customerDetail.customer')}
          back={{ to: '/customers', label: 'Back to customers' }}
        />
        <Card>
          <LoadingState label={t('customerDetail.loadingTheCustomer')} />
        </Card>
      </>
    );
  }

  if (query.isError) {
    return (
      <>
        <PageHeader
          title={t('customerDetail.customer')}
          back={{ to: '/customers', label: 'Back to customers' }}
        />
        <Card>
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        </Card>
      </>
    );
  }

  const customer = query.data.customer;
  const isActive = customer.status === 'ACTIVE';
  const liveAddresses = customer.addresses.filter((address) => address.archivedAt === null);

  return (
    <>
      <PageHeader
        title={customer.fullName ?? customer.email}
        back={{ to: '/customers', label: 'Back to customers' }}
        description={customer.organization ?? customer.email}
        meta={
          <Badge dot tone={customerStatusTone(customer.status)}>
            {humanise(customer.status)}
          </Badge>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-5">
          <Card title={t('customerDetail.account')}>
            <DescriptionList
              className="px-5 py-4"
              items={[
                { label: 'Email', value: customer.email },
                { label: 'Contact', value: customer.fullName ?? '—' },
                { label: 'Organisation', value: customer.organization ?? '—' },
                { label: 'Department', value: customer.department ?? '—' },
                { label: 'Phone', value: customer.phone ?? '—' },
                {
                  label: 'GSTIN',
                  value:
                    customer.gstin === null ? (
                      '—'
                    ) : (
                      <span className="font-mono">{customer.gstin}</span>
                    ),
                },
                {
                  label: 'EU VAT number',
                  value:
                    customer.vatNumber === null ? (
                      '—'
                    ) : (
                      <span className="font-mono">{customer.vatNumber}</span>
                    ),
                },
                {
                  label: 'Customer code',
                  value:
                    customer.customerCode === null ? (
                      '—'
                    ) : (
                      <span className="font-mono">{customer.customerCode}</span>
                    ),
                },
                { label: 'Invited', value: formatDateTime(customer.invitedAt) },
                { label: 'Activated', value: formatDateTime(customer.activatedAt) },
                { label: 'Last sign-in', value: formatDateTime(customer.lastLoginAt) },
              ]}
            />
          </Card>

          <LimitsPanel customer={customer} />

          <Card
            title={t('customerDetail.addresses')}
            description={t('customerDetail.usedAtCheckoutForBilling')}
          >
            {liveAddresses.length === 0 ? (
              <EmptyState
                title={t('customerDetail.noAddressesYet')}
                description={t('customerDetail.theCustomerAddsOneAt')}
              />
            ) : (
              <ul className="divide-y divide-border-subtle">
                {liveAddresses.map((address) => (
                  <li key={address.id} className="px-5 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-ink">{address.contactName}</span>
                      <Badge>
                        {address.kind === 'BOTH' ? 'Billing & shipping' : humanise(address.kind)}
                      </Badge>
                      {address.isDefaultShipping && (
                        <Badge tone="accent">{t('customerDetail.defaultShipping')}</Badge>
                      )}
                      {address.isDefaultBilling && (
                        <Badge tone="accent">{t('customerDetail.defaultBilling')}</Badge>
                      )}
                    </div>
                    <address className="mt-1 text-sm not-italic leading-relaxed text-ink-muted">
                      {address.line1}
                      {address.line2 !== null && `, ${address.line2}`}, {address.city},{' '}
                      {address.state} {address.postalCode}, {address.country}
                      <span className="ml-2 text-ink-subtle">{address.contactPhone}</span>
                    </address>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <VatNumberPanel
            customerId={customer.id}
            state={{
              vatNumber: customer.vatNumber,
              vatNumberValid: customer.vatNumberValid,
              vatNumberCheckedAt: customer.vatNumberCheckedAt,
              vatNumberReference: customer.vatNumberReference,
            }}
          />
        </div>

        <div className="space-y-5">
          <Card title={t('customerDetail.status')}>
            <div className="space-y-3 px-5 py-4">
              <Badge dot tone={customerStatusTone(customer.status)}>
                {humanise(customer.status)}
              </Badge>

              {/* Three different closed accounts land here and each needs a
                  different sentence and a different button. Collapsing them
                  into one "not activated" warning is how a colleague ends up
                  emailing an invitation to somebody who already has a password
                  and is only waiting to be let in. */}
              {customer.selfRegistered ? (
                <>
                  {customer.emailVerifiedAt === null && customer.status !== 'ACTIVE' && (
                    <Callout tone="warning">
                      Signed up on the website and has not opened the confirmation link yet.
                      There is nothing to approve until they do — until then we have no evidence
                      the address belongs to whoever filled the form in.
                    </Callout>
                  )}

                  {customer.emailVerifiedAt !== null && customer.status === 'PENDING_APPROVAL' && (
                    <Callout tone="warning">
                      Signed up on the website and confirmed their email. They cannot order until
                      you approve them.
                    </Callout>
                  )}

                  {can(Permission.CUSTOMER_STATUS_WRITE) &&
                    customer.status === 'PENDING_APPROVAL' &&
                    customer.emailVerifiedAt !== null && (
                      <div>
                        <Button
                          className="w-full"
                          variant="primary"
                          isLoading={approve.isPending}
                          onClick={() => {
                            approve.mutate();
                          }}
                        >
                          Approve customer
                        </Button>
                        <p className="mt-2 text-xxs leading-relaxed text-ink-muted">
                          Lets them sign in with the password they chose, and emails them to say
                          so. Set their purchasing limits first if this account needs any.
                        </p>
                      </div>
                    )}
                </>
              ) : (
                <>
                  {customer.activatedAt === null && (
                    <Callout tone="warning">{t('customerDetail.thisAccountHasNotBeen')}</Callout>
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
                </>
              )}

              {/* Suspend/reactivate is about an account already agreed to, so it
                  is hidden while a self-registered one is still awaiting that
                  first decision - "Reactivate" would be the wrong word for it,
                  and the wrong button. */}
              {can(Permission.CUSTOMER_STATUS_WRITE) &&
                !(customer.selfRegistered && customer.status === 'PENDING_APPROVAL') && (
                <div className="border-t border-border-subtle pt-3">
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
                  <p className="mt-2 text-xxs leading-relaxed text-ink-muted">
                    {isActive
                      ? 'Stops them signing in and ordering. Existing orders and schedules are untouched.'
                      : 'Lets them sign in and order again on the same terms as before.'}
                  </p>
                </div>
              )}
            </div>
          </Card>

          <Card title={t('customerDetail.consent')}>
            <div className="px-5 py-4 text-sm">
              {customer.consentAcceptedAt === null ? (
                <p className="text-ink-muted">{t('customerDetail.notYetAccepted')}</p>
              ) : (
                <p className="text-ink">Accepted {formatDateTime(customer.consentAcceptedAt)}</p>
              )}
            </div>
          </Card>

          {customer.internalNotes !== null && (
            <Card
              title={t('customerDetail.internalNotes')}
              description={t('customerDetail.staffOnlyTheCustomerNever')}
            >
              <p className="whitespace-pre-wrap px-5 py-4 text-sm leading-relaxed text-ink">
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
        confirmLabel={t('customerDetail.suspendCustomer')}
        isDangerous
        isWorking={setStatus.isPending}
        body="They will not be able to sign in or place orders. Existing orders and recurring schedules are not cancelled."
      />
    </>
  );
}
