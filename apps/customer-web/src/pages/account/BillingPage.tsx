/**
 * Billing information — where the invoice goes, and what it charges.
 *
 * Two things on one screen because they are the same question in two halves:
 * the tax identifiers decide the amount, and the billing address decides who
 * the document names.
 *
 * The one field here worth understanding before changing anything: **an EU VAT
 * number is safe to let a customer edit, and it is not taken on trust.**
 * Entering a number does not zero-rate anything. Until VIES confirms it, the
 * sale is taxed — Art. 138(1)(b) puts the burden of the customer's status on
 * the seller, so an unverified or wrong number costs the buyer their reverse
 * charge and never costs the seller the tax. Editing it also clears whatever
 * VIES last said, on the server, because carrying an old verdict forward would
 * zero-rate a supply on the strength of a different company's registration.
 *
 * The address itself is not edited here. It is one of the customer's saved
 * addresses, marked as the billing default, and `AddressesPage` is where that
 * happens — a second address form on this screen would be a second place a
 * postal code could be wrong.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { CountryFlag } from '@/components/CountryFlag';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
} from '@/components/ui';
import { ChevronRightIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import type { AccountResponse, Address } from '@/lib/types';
import { AccountPanel, PanelRow } from './AccountPanel';

const taxSchema = z.object({
  vatNumber: z.string().trim().max(32),
  gstin: z.string().trim().max(32),
});

type TaxForm = z.output<typeof taxSchema>;

export function BillingPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const { isCustomer } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  useDocumentMeta(
    { title: t('account.nav.billingInformation'), noIndex: true },
    business.displayName,
  );

  const [isEditing, setIsEditing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const account = useQuery({
    queryKey: ['account-profile'],
    queryFn: () => api.get<AccountResponse>('/account/profile'),
    enabled: isCustomer,
  });

  const addresses = useQuery({
    queryKey: ['addresses'],
    queryFn: () => api.get<{ addresses: Address[] }>('/account/addresses'),
    enabled: isCustomer,
  });

  const profile = account.data?.profile ?? null;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<TaxForm>({
    resolver: zodResolver(taxSchema),
    defaultValues: { vatNumber: '', gstin: '' },
  });

  useEffect(() => {
    if (profile === null) return;
    reset({ vatNumber: profile.vatNumber ?? '', gstin: profile.gstin ?? '' });
  }, [isEditing, profile, reset]);

  const save = useMutation({
    mutationFn: (values: TaxForm) =>
      api.patch('/account/profile', {
        vatNumber: values.vatNumber === '' ? null : values.vatNumber,
        gstin: values.gstin === '' ? null : values.gstin,
      }),
    onSuccess: async () => {
      setFormError(null);
      setIsEditing(false);
      toast.success(t('billing.saved'));
      await queryClient.invalidateQueries({ queryKey: ['account-profile'] });
    },
    onError: (error) => {
      setFormError(errorMessage(t, error, t('billing.couldNotSave')));
    },
  });

  if (account.isPending) return <LoadingState label={t('billing.loading')} />;

  if (account.isError || profile === null) {
    return (
      <ErrorState
        error={account.error}
        onRetry={() => {
          void account.refetch();
        }}
      />
    );
  }

  const billingAddress =
    (addresses.data?.addresses ?? []).find((entry) => entry.isDefaultBilling) ?? null;

  /**
   * What VIES said, as three distinct states rather than two.
   *
   * Null means "never checked", which is not the same as invalid: one is a
   * step nobody has taken yet, the other is a problem with the number. Showing
   * them the same way is how a customer concludes their valid number was
   * rejected.
   */
  const vatBadge =
    profile.vatNumber === null || profile.vatNumber === '' ? null : profile.vatNumberValid ===
      null ? (
      <Badge tone="neutral">{t('billing.notCheckedYet')}</Badge>
    ) : profile.vatNumberValid ? (
      <Badge tone="success">{t('billing.confirmedByVies')}</Badge>
    ) : (
      <Badge tone="danger">{t('billing.viesDidNotRecognise')}</Badge>
    );

  return (
    <>
      <PageHeader
        title={t('account.nav.billingInformation')}
        description={t('billing.description')}
      />

      <div className="space-y-6">
        <AccountPanel
          title={t('billing.taxIdentifiers')}
          description={t('billing.taxIdentifiersHint')}
          isEditing={isEditing}
          onEdit={() => {
            setFormError(null);
            setIsEditing(true);
          }}
        >
          {isEditing ? (
            <form
              className="space-y-4"
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

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field
                  label={t('billing.vatNumber')}
                  hint={t('billing.vatNumberHint')}
                  error={errors.vatNumber?.message}
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      // Uppercase as typed: a VAT number carries a member-state
                      // prefix and is conventionally written in capitals, and
                      // the server upper-cases it anyway — matching that here
                      // means the field does not appear to change on save.
                      className="uppercase"
                      aria-describedby={describedBy}
                      {...register('vatNumber')}
                    />
                  )}
                </Field>

                <Field
                  label={t('billing.gstin')}
                  hint={t('billing.gstinHint')}
                  error={errors.gstin?.message}
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      className="uppercase"
                      aria-describedby={describedBy}
                      {...register('gstin')}
                    />
                  )}
                </Field>
              </div>

              <p className="max-w-prose rounded-md border border-border bg-surface-sunken px-3 py-2.5 text-xs leading-relaxed text-ink-muted">
                {t('billing.vatCheckExplainer')}
              </p>

              <div className="flex items-center gap-2">
                <Button type="submit" variant="primary" isLoading={isSubmitting || save.isPending}>
                  {t('common.save')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setIsEditing(false);
                    setFormError(null);
                  }}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            </form>
          ) : (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
              <PanelRow
                label={t('billing.vatNumber')}
                value={profile.vatNumber}
                badge={vatBadge}
                {...(profile.vatNumberCheckedAt === null
                  ? {}
                  : {
                      hint: t('billing.lastChecked', {
                        date: formatDateTime(profile.vatNumberCheckedAt),
                      }),
                    })}
              />
              <PanelRow label={t('billing.gstin')} value={profile.gstin} />
            </dl>
          )}
        </AccountPanel>

        <AccountPanel
          title={t('billing.billingAddress')}
          description={t('billing.billingAddressHint')}
        >
          {billingAddress === null ? (
            <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
              {t('billing.noBillingAddress')}
            </p>
          ) : (
            <address className="flex items-start gap-3 not-italic">
              <CountryFlag code={billingAddress.country} className="mt-0.5 h-3.5 w-5" />
              <span className="min-w-0 text-sm leading-relaxed text-ink">
                <span className="block font-medium">{billingAddress.contactName}</span>
                <span className="block text-ink-muted">
                  {billingAddress.line1}
                  {billingAddress.line2 !== null && `, ${billingAddress.line2}`}
                </span>
                <span className="block text-ink-muted">
                  {billingAddress.city}, {billingAddress.state} {billingAddress.postalCode}
                </span>
                <span className="block text-ink-muted">{billingAddress.country}</span>
              </span>
            </address>
          )}

          <p className="mt-4 border-t border-border-subtle pt-4">
            <Link
              to="/account/addresses"
              className="inline-flex items-center gap-1 rounded text-sm font-medium text-brand hover:underline"
            >
              {t('account.nav.manageAddresses')}
              <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />
            </Link>
          </p>
        </AccountPanel>
      </div>
    </>
  );
}
