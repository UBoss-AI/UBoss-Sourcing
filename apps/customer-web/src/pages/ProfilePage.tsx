/**
 * Your profile.
 *
 * Also where purchasing limits are shown, because a customer whose order is
 * rejected at checkout for exceeding a cap deserves to have seen that cap
 * somewhere first. The limits are read-only here — they are set by the
 * supplier, not the buyer, and pretending otherwise would be a form that never
 * saves.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { useStorefront } from '@/app/storefront-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, ErrorState, Field, Input, LoadingState } from '@/components/ui';
import { ApiError, NetworkError, api } from '@/lib/api';
import { formatDateTime, minorToMajor } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { AccountResponse } from '@/lib/types';

const profileSchema = z.object({
  fullName: z.string().trim().min(1, 'Tell us who to address deliveries to.').max(255),
  phone: z.string().trim().max(32),
  department: z.string().trim().max(128),
});

type ProfileForm = z.output<typeof profileSchema>;

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.'),
    newPassword: z
      .string()
      .min(12, 'Use at least 12 characters.')
      .max(128, 'Use at most 128 characters.'),
    confirmPassword: z.string(),
  })
  .refine((values) => values.newPassword === values.confirmPassword, {
    path: ['confirmPassword'],
    message: 'The two passwords do not match.',
  });

type PasswordForm = z.output<typeof passwordSchema>;

/** An amount from the account API, which sends bare minor units. */
function money(minor: string | null, currency: string): string {
  if (minor === null) return 'No limit';
  return `${currency} ${minorToMajor(minor)}`;
}

function LimitsPanel({ account }: { account: AccountResponse }): React.JSX.Element {
  const { purchasingLimits: limits, spend } = account;

  return (
    <section aria-labelledby="limits-heading" className="rounded-lg border border-border bg-surface p-5">
      <h2 id="limits-heading" className="text-base font-semibold text-ink">
        Your purchasing limits
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        Set by us on your account. Checkout applies them, so it is worth knowing them before you
        build a large order.
      </p>

      <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Minimum per order</dt>
          <dd className="mt-0.5 tabular text-ink">
            {money(limits.perOrderMinMinor, limits.currency)}
          </dd>
        </div>

        <div>
          <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Maximum per order</dt>
          <dd className="mt-0.5 tabular text-ink">
            {money(limits.perOrderMaxMinor, limits.currency)}
          </dd>
        </div>

        <div>
          <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Spent this month</dt>
          <dd className="mt-0.5 tabular text-ink">
            {money(spend.monthToDateMinor, spend.currency)}
            {spend.capMinor !== null && (
              <span className="text-ink-muted"> of {money(spend.capMinor, spend.currency)}</span>
            )}
          </dd>
        </div>

        <div>
          <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Approvals</dt>
          <dd className="mt-0.5 text-ink">
            {limits.requiresOrderApproval ? (
              <Badge tone="warning">Orders need approval</Badge>
            ) : (
              <span className="text-ink-muted">Not required</span>
            )}
          </dd>
        </div>
      </dl>

      {spend.remainingMinor !== null && (
        <p className="mt-4 border-t border-border pt-4 text-sm text-ink">
          You have{' '}
          <span className="font-medium tabular">
            {money(spend.remainingMinor, spend.currency)}
          </span>{' '}
          left to spend this month.
        </p>
      )}
    </section>
  );
}

function PasswordPanel(): React.JSX.Element {
  const toast = useToast();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<PasswordForm>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  const change = useMutation({
    mutationFn: (values: PasswordForm) =>
      api.post('/auth/password/change', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      }),
    onSuccess: () => {
      setFormError(null);
      reset();
      toast.success('Password changed. Your other sessions have been signed out.');
    },
    onError: (error) => {
      if (error instanceof NetworkError) {
        setFormError(error.message);
        return;
      }
      setFormError(
        error instanceof ApiError ? error.message : 'The password could not be changed.',
      );
    },
  });

  return (
    <section aria-labelledby="password-heading" className="rounded-lg border border-border bg-surface p-5">
      <h2 id="password-heading" className="text-base font-semibold text-ink">
        Change your password
      </h2>

      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit((values) => change.mutateAsync(values))();
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

        <Field label="Current password" error={errors.currentPassword?.message} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="password"
              autoComplete="current-password"
              aria-describedby={describedBy}
              invalid={errors.currentPassword !== undefined}
              {...register('currentPassword')}
            />
          )}
        </Field>

        <Field
          label="New password"
          hint="At least 12 characters."
          error={errors.newPassword?.message}
          required
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              invalid={errors.newPassword !== undefined}
              {...register('newPassword')}
            />
          )}
        </Field>

        <Field label="Confirm the new password" error={errors.confirmPassword?.message} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              type="password"
              autoComplete="new-password"
              aria-describedby={describedBy}
              invalid={errors.confirmPassword !== undefined}
              {...register('confirmPassword')}
            />
          )}
        </Field>

        <Button type="submit" variant="primary" isLoading={isSubmitting || change.isPending}>
          Change password
        </Button>
      </form>
    </section>
  );
}

export function ProfilePage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { business } = useStorefront();
  const [formError, setFormError] = useState<string | null>(null);

  useDocumentMeta({ title: 'Your profile', noIndex: true }, business.displayName);

  const query = useQuery({
    queryKey: ['account-profile'],
    queryFn: () => api.get<AccountResponse>('/account/profile'),
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<ProfileForm>({
    resolver: zodResolver(profileSchema),
    defaultValues: { fullName: '', phone: '', department: '' },
  });

  useEffect(() => {
    const profile = query.data?.profile;
    if (profile === undefined) return;

    reset({
      fullName: profile.fullName ?? '',
      phone: profile.phone ?? '',
      department: profile.department ?? '',
    });
  }, [query.data, reset]);

  const save = useMutation({
    mutationFn: (values: ProfileForm) =>
      api.patch('/account/profile', {
        fullName: values.fullName,
        phone: values.phone === '' ? null : values.phone,
        department: values.department === '' ? null : values.department,
      }),
    onSuccess: async () => {
      setFormError(null);
      toast.success('Profile saved.');
      await queryClient.invalidateQueries({ queryKey: ['account-profile'] });
    },
    onError: (error) => {
      setFormError(error instanceof ApiError ? error.message : 'Your profile could not be saved.');
    },
  });

  if (query.isPending) return <LoadingState label="Loading your profile" />;

  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const { profile } = query.data;

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-ink">Your profile</h1>

      <div className="space-y-6">
        <section aria-labelledby="details-heading" className="rounded-lg border border-border bg-surface p-5">
          <h2 id="details-heading" className="text-base font-semibold text-ink">
            Your details
          </h2>

          <form
            className="mt-4 space-y-4"
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
              <Field label="Your name" error={errors.fullName?.message} required>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    autoComplete="name"
                    aria-describedby={describedBy}
                    invalid={errors.fullName !== undefined}
                    {...register('fullName')}
                  />
                )}
              </Field>

              <Field label="Phone" error={errors.phone?.message}>
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

              <Field label="Department" error={errors.department?.message}>
                {({ inputId, describedBy }) => (
                  <Input id={inputId} aria-describedby={describedBy} {...register('department')} />
                )}
              </Field>
            </div>

            <Button
              type="submit"
              variant="primary"
              disabled={!isDirty}
              isLoading={isSubmitting || save.isPending}
            >
              Save changes
            </Button>
          </form>

          <dl className="mt-6 grid gap-x-6 gap-y-3 border-t border-border pt-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Email address</dt>
              {/* Read-only: it identifies the account and is how invitations,
                  payment links and order emails reach you. */}
              <dd className="mt-0.5 text-ink">{profile.email}</dd>
            </div>

            {profile.organization !== null && (
              <div>
                <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Organisation</dt>
                <dd className="mt-0.5 text-ink">{profile.organization}</dd>
              </div>
            )}

            <div>
              <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Member since</dt>
              <dd className="mt-0.5 text-ink">{formatDateTime(profile.activatedAt)}</dd>
            </div>

            <div>
              <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Orders placed</dt>
              <dd className="mt-0.5 text-ink">{profile.orderCount}</dd>
            </div>
          </dl>

          <p className="mt-3 text-xs text-ink-muted">
            To change your email address or organisation, get in touch — they identify your account.
          </p>
        </section>

        <LimitsPanel account={query.data} />
        <PasswordPanel />
      </div>
    </>
  );
}
