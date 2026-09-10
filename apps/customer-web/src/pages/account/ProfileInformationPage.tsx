/**
 * Profile information — the account's own details, and the two that identify
 * it.
 *
 * The page is a column of panels, each one a heading with an Edit beside it
 * that swaps a read view for a form. That shape is not decoration: a screen
 * of twenty inputs, all live, all savable together, is a screen where somebody
 * correcting a phone number can accidentally blank their job title and not
 * notice for a month. One panel open at a time, one Save, one thing changed.
 *
 * Three things here are not like the others.
 *
 * **The name is captured in two parts and composed on the server.** The
 * canonical name — the one on every order, invoice and delivery note — stays
 * `fullName`, and it is built from the parts by `updateCustomer`. This page
 * never splits a stored `fullName` to fill the two boxes: "Van der Berg" is
 * one surname, "Jean Paul" is one forename, and a guessed split is one the
 * customer cannot tell was guessed. An account that has only ever had a single
 * name field therefore opens with the parts empty and the full name shown
 * beside them, which is honest.
 *
 * **The email address and the telephone number are not saved by this form.**
 * Both go through a confirmation link — see `contact-change.service.ts` on the
 * server for why at length. What matters here is what the customer sees: the
 * live value stays live and a pending value is shown as pending, so nobody is
 * ever looking at an address their account does not actually use. Confirming
 * an address signs every session out, and the panel says so *before* the
 * request rather than after it.
 *
 * **Country, language and currency are shown but not edited here.** They are
 * one coupled answer that reprices the whole catalogue, and there are already
 * two places that ask it properly: the market control in the header, and
 * Language and region in this sidebar. A third editor for the same three
 * fields is a third chance for them to disagree, so this states them and links
 * to one of the two.
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
import type { Translate } from '@/i18n/i18n-context';
import { languageOption } from '@/i18n/languages';
import type { AccountResponse } from '@/lib/types';
import { YourDataPanel } from './YourDataPanel';
import { AccountPanel, PanelRow } from './AccountPanel';
import { CloseAccountPanel } from './CloseAccountPanel';
import { ContactFaqPanel } from './ContactFaqPanel';
import { PasswordPanel } from './PasswordPanel';
import { PurchasingLimitsPanel } from './PurchasingLimitsPanel';

const ACCOUNT_PROFILE_KEY = ['account-profile'];

// ---------------------------------------------------------------------------
// Personal information
// ---------------------------------------------------------------------------

function buildNameSchema(t: Translate) {
  return z.object({
    // At least one of the two, checked below. Neither is required on its own,
    // because a mononym is a real name and forcing a surname out of somebody
    // who has one name means forcing them to invent one.
    firstName: z.string().trim().max(120),
    lastName: z.string().trim().max(120),
    jobTitle: z.string().trim().max(128),
  }).refine((values) => `${values.firstName}${values.lastName}`.trim() !== '', {
    path: ['firstName'],
    message: t('profile.tellUsWhoToAddress'),
  });
}

type NameForm = z.output<ReturnType<typeof buildNameSchema>>;

function PersonalInformationPanel({
  account,
}: {
  account: AccountResponse;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [isEditing, setIsEditing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const { profile } = account;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<NameForm>({
    resolver: zodResolver(buildNameSchema(t)),
    defaultValues: { firstName: '', lastName: '', jobTitle: '' },
  });

  // Re-seeded whenever the read lands or the panel opens, so cancelling and
  // reopening shows what is saved rather than what was last typed.
  useEffect(() => {
    reset({
      firstName: profile.firstName ?? '',
      lastName: profile.lastName ?? '',
      jobTitle: profile.jobTitle ?? '',
    });
  }, [isEditing, profile.firstName, profile.jobTitle, profile.lastName, reset]);

  const save = useMutation({
    mutationFn: (values: NameForm) =>
      api.patch('/account/profile', {
        firstName: values.firstName === '' ? null : values.firstName,
        lastName: values.lastName === '' ? null : values.lastName,
        jobTitle: values.jobTitle === '' ? null : values.jobTitle,
      }),
    onSuccess: async () => {
      setFormError(null);
      setIsEditing(false);
      toast.success(t('profile.profileSaved'));
      await queryClient.invalidateQueries({ queryKey: ACCOUNT_PROFILE_KEY });
    },
    onError: (error) => {
      setFormError(errorMessage(t, error, t('profile.profileCouldNotBeSaved')));
    },
  });

  return (
    <AccountPanel
      title={t('profile.personalInformation')}
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
            <Field label={t('profile.firstName')} error={errors.firstName?.message}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  autoComplete="given-name"
                  aria-describedby={describedBy}
                  invalid={errors.firstName !== undefined}
                  {...register('firstName')}
                />
              )}
            </Field>

            <Field label={t('profile.lastName')} error={errors.lastName?.message}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  autoComplete="family-name"
                  aria-describedby={describedBy}
                  {...register('lastName')}
                />
              )}
            </Field>

            <Field
              label={t('profile.jobTitle')}
              hint={t('profile.jobTitleHint')}
              error={errors.jobTitle?.message}
            >
              {({ inputId, describedBy }) => (
                <Input id={inputId} aria-describedby={describedBy} {...register('jobTitle')} />
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
          <PanelRow label={t('profile.firstName')} value={profile.firstName} />
          <PanelRow label={t('profile.lastName')} value={profile.lastName} />
          <PanelRow label={t('profile.jobTitle')} value={profile.jobTitle} />
          {/*
           * The full name, when the parts do not spell it.
           *
           * An account created by invitation or by import has a `fullName` and
           * no parts, and this is the row that says so — without it, somebody
           * whose orders all carry their name would open this panel and see
           * three empty fields.
           */}
          {profile.fullName !== null &&
            profile.fullName !== `${profile.firstName ?? ''} ${profile.lastName ?? ''}`.trim() && (
              <PanelRow
                label={t('profile.nameOnOrders')}
                value={profile.fullName}
                hint={t('profile.nameOnOrdersHint')}
              />
            )}
        </dl>
      )}
    </AccountPanel>
  );
}

// ---------------------------------------------------------------------------
// Email address
// ---------------------------------------------------------------------------

function buildEmailSchema(t: Translate) {
  return z.object({
    // , not the deprecated  method. Trimmed and length-
    // capped first so a pasted address with a trailing space is accepted
    // rather than rejected for a reason nobody can see.
    email: z.email(t('validation.enterAnEmailAddress')).trim().min(3).max(320),
  });
}

type EmailForm = z.output<ReturnType<typeof buildEmailSchema>>;

function EmailPanel({ account }: { account: AccountResponse }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [isEditing, setIsEditing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const { profile } = account;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<EmailForm>({
    resolver: zodResolver(buildEmailSchema(t)),
    defaultValues: { email: '' },
  });

  const request = useMutation({
    mutationFn: (values: EmailForm) => api.post('/account/email-change', { email: values.email }),
    onSuccess: async () => {
      setFormError(null);
      setIsEditing(false);
      reset({ email: '' });
      toast.success(t('profile.checkYourNewInbox'));
      await queryClient.invalidateQueries({ queryKey: ACCOUNT_PROFILE_KEY });
    },
    onError: (error) => {
      setFormError(errorMessage(t, error, t('profile.emailCouldNotBeChanged')));
    },
  });

  const cancel = useMutation({
    mutationFn: () => api.delete('/account/email-change'),
    onSuccess: async () => {
      toast.success(t('profile.emailChangeCancelled'));
      await queryClient.invalidateQueries({ queryKey: ACCOUNT_PROFILE_KEY });
    },
  });

  return (
    <AccountPanel
      title={t('profile.emailAddress')}
      isEditing={isEditing}
      onEdit={() => {
        setFormError(null);
        setIsEditing(true);
      }}
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        <PanelRow
          label={t('profile.currentAddress')}
          value={profile.email}
          badge={
            profile.emailVerifiedAt === null ? (
              <Badge tone="warning">{t('profile.notConfirmed')}</Badge>
            ) : (
              <Badge tone="success">{t('profile.confirmed')}</Badge>
            )
          }
        />
      </dl>

      {/*
       * What is in flight.
       *
       * Shown whether or not the form is open, and above it: somebody who has
       * requested a change and come back a day later needs to see that the
       * change is still waiting on them, not an empty box inviting them to
       * request it again.
       */}
      {profile.pendingEmail !== null && (
        <div
          role="status"
          className="mt-4 rounded-md border border-brand/25 bg-brand-soft/70 p-4"
        >
          <p className="text-sm font-medium text-ink">
            {t('profile.pendingEmailTitle', { email: profile.pendingEmail })}
          </p>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-muted">
            {t('profile.pendingEmailBody')}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              isLoading={cancel.isPending}
              onClick={() => {
                cancel.mutate();
              }}
            >
              {t('profile.cancelThisChange')}
            </Button>
          </div>
        </div>
      )}

      {isEditing && (
        <form
          className="mt-4 space-y-4 border-t border-border-subtle pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit((values) => request.mutateAsync(values))();
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

          <Field
            label={t('profile.newEmailAddress')}
            hint={t('profile.newEmailHint')}
            error={errors.email?.message}
            required
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                type="email"
                autoComplete="email"
                aria-describedby={describedBy}
                invalid={errors.email !== undefined}
                {...register('email')}
              />
            )}
          </Field>

          {/* Said before the request, not after it. Somebody who is about to
              be signed out of every device is owed the chance to finish what
              they were doing first. */}
          <p className="rounded-md border border-warning/30 bg-warning-soft px-3 py-2.5 text-sm leading-relaxed text-warning">
            {t('profile.emailChangeSignsYouOut')}
          </p>

          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" isLoading={isSubmitting || request.isPending}>
              {t('profile.sendConfirmationLink')}
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
      )}
    </AccountPanel>
  );
}

// ---------------------------------------------------------------------------
// Telephone
// ---------------------------------------------------------------------------

function buildPhoneSchema(t: Translate) {
  return z.object({
    phone: z
      .string()
      .trim()
      .min(5, t('validation.enterATelephoneNumber'))
      .max(32, t('validation.enterATelephoneNumber')),
  });
}

type PhoneForm = z.output<ReturnType<typeof buildPhoneSchema>>;

function PhonePanel({ account }: { account: AccountResponse }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [isEditing, setIsEditing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const { profile } = account;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<PhoneForm>({
    resolver: zodResolver(buildPhoneSchema(t)),
    defaultValues: { phone: '' },
  });

  const request = useMutation({
    mutationFn: (values: PhoneForm) => api.post('/account/phone-change', { phone: values.phone }),
    onSuccess: async () => {
      setFormError(null);
      setIsEditing(false);
      reset({ phone: '' });
      toast.success(t('profile.checkYourInboxForTheCode'));
      await queryClient.invalidateQueries({ queryKey: ACCOUNT_PROFILE_KEY });
    },
    onError: (error) => {
      setFormError(errorMessage(t, error, t('profile.phoneCouldNotBeChanged')));
    },
  });

  const cancel = useMutation({
    mutationFn: () => api.delete('/account/phone-change'),
    onSuccess: async () => {
      toast.success(t('profile.phoneChangeCancelled'));
      await queryClient.invalidateQueries({ queryKey: ACCOUNT_PROFILE_KEY });
    },
  });

  return (
    <AccountPanel
      title={t('profile.mobileNumber')}
      isEditing={isEditing}
      onEdit={() => {
        setFormError(null);
        setIsEditing(true);
      }}
    >
      <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        <PanelRow
          label={t('profile.accountNumber')}
          value={profile.accountPhone}
          hint={t('profile.accountNumberHint')}
          badge={
            profile.accountPhone === null ? null : profile.accountPhoneVerifiedAt === null ? (
              <Badge tone="warning">{t('profile.notConfirmed')}</Badge>
            ) : (
              <Badge tone="success">{t('profile.confirmed')}</Badge>
            )
          }
        />
        {/* The delivery contact, which is a different column and an ordinary
            editable field — it is edited on Company information beside the
            rest of the ordering details. Stated here because somebody looking
            for "my number" should see both and not wonder which one a courier
            rings. */}
        <PanelRow
          label={t('profile.deliveryContactNumber')}
          value={profile.phone}
          hint={t('profile.deliveryContactNumberHint')}
        />
      </dl>

      {profile.pendingPhone !== null && (
        <div role="status" className="mt-4 rounded-md border border-brand/25 bg-brand-soft/70 p-4">
          <p className="text-sm font-medium text-ink">
            {t('profile.pendingPhoneTitle', { phone: profile.pendingPhone })}
          </p>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-muted">
            {t('profile.pendingPhoneBody')}
          </p>

          <div className="mt-3">
            <Button
              variant="ghost"
              size="sm"
              isLoading={cancel.isPending}
              onClick={() => {
                cancel.mutate();
              }}
            >
              {t('profile.cancelThisChange')}
            </Button>
          </div>
        </div>
      )}

      {isEditing && (
        <form
          className="mt-4 space-y-4 border-t border-border-subtle pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit((values) => request.mutateAsync(values))();
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

          <Field
            label={t('profile.newMobileNumber')}
            hint={t('profile.newPhoneHint')}
            error={errors.phone?.message}
            required
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                type="tel"
                autoComplete="tel"
                aria-describedby={describedBy}
                invalid={errors.phone !== undefined}
                {...register('phone')}
              />
            )}
          </Field>

          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" isLoading={isSubmitting || request.isPending}>
              {t('profile.sendConfirmationLink')}
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
      )}
    </AccountPanel>
  );
}

// ---------------------------------------------------------------------------
// Where they are, in their own words. Stated, not edited. See the header.
// ---------------------------------------------------------------------------

function MarketPanel({ account }: { account: AccountResponse }): React.JSX.Element {
  const { t } = useI18n();
  const { localisation } = useStorefront();

  const { profile } = account;

  const countryName =
    profile.preferredCountry === null
      ? null
      : (localisation.countries.find((entry) => entry.code === profile.preferredCountry)?.name ??
        profile.preferredCountry);

  return (
    <AccountPanel title={t('profile.languageAndRegion')}>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-3">
        <PanelRow
          label={t('profile.country')}
          value={countryName}
          mark={
            profile.preferredCountry === null ? null : (
              <CountryFlag code={profile.preferredCountry} className="h-3.5 w-5" />
            )
          }
        />
        <PanelRow
          label={t('profile.preferredLanguage')}
          value={
            profile.preferredLanguage === null
              ? null
              : languageOption(profile.preferredLanguage).endonym
          }
        />
        <PanelRow label={t('profile.preferredCurrency')} value={profile.preferredCurrency} />
      </dl>

      <p className="mt-4 border-t border-border-subtle pt-4">
        <Link
          to="/account/region"
          className="inline-flex items-center gap-1 rounded text-sm font-medium text-brand hover:underline"
        >
          {t('profile.changeLanguageAndRegion')}
          <ChevronRightIcon aria-hidden="true" className="h-4 w-4" />
        </Link>
      </p>
    </AccountPanel>
  );
}

// ---------------------------------------------------------------------------

export function ProfileInformationPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const { isCustomer } = useSession();

  useDocumentMeta({ title: t('account.nav.profileInformation'), noIndex: true }, business.displayName);

  const query = useQuery({
    queryKey: ACCOUNT_PROFILE_KEY,
    queryFn: () => api.get<AccountResponse>('/account/profile'),
    enabled: isCustomer,
  });

  if (query.isPending) return <LoadingState label={t('profile.loadingYourProfile')} />;

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

  const account = query.data;

  return (
    <>
      <PageHeader
        title={t('account.nav.profileInformation')}
        description={t('profile.yourContactDetailsAndHow')}
      />

      <div className="space-y-6">
        <PersonalInformationPanel account={account} />
        <EmailPanel account={account} />
        <PhonePanel account={account} />
        <MarketPanel account={account} />

        <PasswordPanel />
        <PurchasingLimitsPanel account={account} />

        {/* Small print about the two changes above, in the operator's own
            voice rather than a marketplace's. It answers the questions people
            actually ask support about a contact change. */}
        <ContactFaqPanel />

        {/* Art. 15 and Art. 17 — including Delete account, which is an erasure
            request rather than a DELETE statement. It has always lived here
            and it stays: this panel already says what survives an erasure and
            tracks the request, and a second Delete control elsewhere would be
            a second erasure implementation. */}
        <YourDataPanel />

        <CloseAccountPanel account={account} />

        {/* The account's own record, last. Read-only and deliberately so: it
            is what the supplier knows, not something the buyer sets. */}
        <AccountPanel title={t('profile.accountRecord')}>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            <PanelRow
              label={t('profile.memberSince')}
              value={
                account.profile.activatedAt === null
                  ? null
                  : formatDateTime(account.profile.activatedAt)
              }
            />
            <PanelRow
              label={t('profile.ordersPlaced')}
              value={String(account.profile.orderCount)}
            />
          </dl>
        </AccountPanel>
      </div>
    </>
  );
}
