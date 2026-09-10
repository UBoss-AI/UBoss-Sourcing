/**
 * Company information — who is ordering, on whose behalf.
 *
 * Split from Profile information rather than folded into it, because these are
 * facts about an organisation and those are facts about a person. On a
 * purchasing account the two frequently belong to different people: the buyer
 * changes, the company does not, and a screen that mixed them would put "your
 * job title" one field away from the legal entity name on every invoice.
 *
 * The delivery contact number lives here rather than on the profile, and the
 * distinction is real: `users.phone` identifies the account and only moves
 * through a confirmation link, while this one is the number a courier rings
 * about a delivery. They are two columns for two questions. The profile screen
 * states both and says which is which.
 *
 * The tax identifiers are on Billing information, not here — they decide what
 * an invoice charges, which is a money question rather than an identity one.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { useToast } from '@/components/toast-context';
import { Button, ErrorState, Field, Input, LoadingState, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import type { AccountResponse } from '@/lib/types';
import { AccountPanel, PanelRow } from './AccountPanel';

const companySchema = z.object({
  organization: z.string().trim().max(255),
  department: z.string().trim().max(128),
  phone: z.string().trim().max(32),
});

type CompanyForm = z.output<typeof companySchema>;

export function CompanyInformationPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const { isCustomer } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  useDocumentMeta(
    { title: t('account.nav.companyInformation'), noIndex: true },
    business.displayName,
  );

  const [isEditing, setIsEditing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['account-profile'],
    queryFn: () => api.get<AccountResponse>('/account/profile'),
    enabled: isCustomer,
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CompanyForm>({
    resolver: zodResolver(companySchema),
    defaultValues: { organization: '', department: '', phone: '' },
  });

  const profile = query.data?.profile ?? null;

  useEffect(() => {
    if (profile === null) return;

    reset({
      organization: profile.organization ?? '',
      department: profile.department ?? '',
      phone: profile.phone ?? '',
    });
  }, [isEditing, profile, reset]);

  const save = useMutation({
    mutationFn: (values: CompanyForm) =>
      api.patch('/account/profile', {
        // Empty means "cleared", which is a null on the server and not an
        // empty string: a blank organisation is an absent one, and a row
        // holding '' would print an empty line on a delivery note.
        organization: values.organization === '' ? null : values.organization,
        department: values.department === '' ? null : values.department,
        phone: values.phone === '' ? null : values.phone,
      }),
    onSuccess: async () => {
      setFormError(null);
      setIsEditing(false);
      toast.success(t('profile.profileSaved'));
      await queryClient.invalidateQueries({ queryKey: ['account-profile'] });
    },
    onError: (error) => {
      setFormError(errorMessage(t, error, t('profile.profileCouldNotBeSaved')));
    },
  });

  if (query.isPending) return <LoadingState label={t('profile.loadingYourProfile')} />;

  if (query.isError || profile === null) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  return (
    <>
      <PageHeader
        title={t('account.nav.companyInformation')}
        description={t('company.description')}
      />

      <AccountPanel
        title={t('company.whoIsOrdering')}
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
                label={t('company.companyName')}
                hint={t('company.companyNameHint')}
                error={errors.organization?.message}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    autoComplete="organization"
                    aria-describedby={describedBy}
                    {...register('organization')}
                  />
                )}
              </Field>

              <Field
                label={t('company.department')}
                hint={t('company.departmentHint')}
                error={errors.department?.message}
              >
                {({ inputId, describedBy }) => (
                  <Input id={inputId} aria-describedby={describedBy} {...register('department')} />
                )}
              </Field>

              <Field
                label={t('company.deliveryContactNumber')}
                hint={t('company.deliveryContactNumberHint')}
                error={errors.phone?.message}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    type="tel"
                    autoComplete="tel"
                    aria-describedby={describedBy}
                    {...register('phone')}
                  />
                )}
              </Field>
            </div>

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
            <PanelRow label={t('company.companyName')} value={profile.organization} />
            <PanelRow label={t('company.department')} value={profile.department} />
            <PanelRow
              label={t('company.deliveryContactNumber')}
              value={profile.phone}
              hint={t('company.deliveryContactNumberHint')}
            />
          </dl>
        )}
      </AccountPanel>
    </>
  );
}
