/**
 * My profile.
 *
 * Who this person is to the console - name, email, role, agency - and the
 * three things they can change about their own account here: the interface
 * language, their password, and (by asking an administrator) their second
 * factor.
 *
 * Name, email, role and agency are read-only on purpose. They are set by
 * whoever invited the person - the marketplace's administrators, or the
 * agency's own administrator - because an auditor who could rename themselves
 * or move themselves to another agency could sign a report in somebody else's
 * name.
 *
 * Everything shown comes from `GET /audit/auth/me`; the password form posts to
 * `POST /audit/auth/password/change`.
 */
import { useState } from 'react';
import { AgreementHistory } from '@/components/agreement-kit/AgreementHistory';
import { agreementsClient } from '@/lib/agreements';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Badge, Button, Callout, Card, DescriptionList, Field, Input, PageHeader } from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import { languageOption } from '@/i18n/languages';
import { useI18n } from '@/i18n/i18n-context';
import { useCurrentUser } from '@/auth/session-context';
import { ApiError, NetworkError } from '@/lib/api';
import { changePassword } from '@/lib/audit';
import { agencyKindLabel, roleLabel } from '@/lib/labels';

const passwordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(12).max(128),
    confirm: z.string().min(1),
  })
  .refine((values) => values.newPassword === values.confirm, {
    path: ['confirm'],
    message: 'MISMATCH',
  })
  .refine((values) => values.newPassword !== values.currentPassword, {
    path: ['newPassword'],
    message: 'SAME',
  });

type PasswordValues = z.infer<typeof passwordSchema>;

export function ProfilePage(): React.JSX.Element {
  const { t } = useI18n();
  const session = useCurrentUser();
  const { user, member, mfa } = session;

  const organisation =
    member.agency === null
      ? t('auth.existing.staffTeam')
      : `${member.agency.name} · ${agencyKindLabel(t, member.agency.kind)}`;

  return (
    <>
      <PageHeader title={t('profile.title')} description={t('profile.description')} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={t('profile.account')} description={t('profile.accountHint')} bodyClassName="px-5 py-4">
          <DescriptionList
            items={[
              { label: t('profile.name'), value: user.fullName },
              { label: t('auth.email'), value: user.email },
              { label: t('profile.role'), value: roleLabel(t, member.role) },
              { label: t('profile.organisation'), value: organisation },
            ]}
          />
        </Card>

        <Card title={t('profile.twoStep')} bodyClassName="px-5 py-4">
          <div className="flex flex-wrap items-center gap-2">
            {mfa.enrolled ? (
              <Badge tone="success" dot>
                {t('profile.twoStepOn')}
              </Badge>
            ) : (
              <Badge tone="warning" dot>
                {t('profile.twoStepOff')}
              </Badge>
            )}
            {mfa.required ? <Badge tone="neutral">{t('profile.twoStepRequired')}</Badge> : null}
          </div>

          {mfa.enrolled ? (
            <p className="mt-3 text-sm text-ink-muted">
              {t('profile.recoveryRemaining', { remaining: String(mfa.recoveryCodesRemaining) })}
            </p>
          ) : null}

          <p className="mt-3 text-sm text-ink-muted">{t('profile.twoStepReset')}</p>
        </Card>

        <Card title={t('profile.language')} bodyClassName="px-5 py-4">
          <p className="mb-3 text-sm text-ink-muted">{t('profile.languageHint')}</p>
          <LanguageSwitcher placement="inline" />
          {user.language === null ? null : (
            <p className="mt-3 text-xs text-ink-subtle">
              {t('profile.accountLanguage', { language: languageOption(user.language).endonym })}
            </p>
          )}
        </Card>

        <ChangePasswordCard />

        {/* The console terms and Privacy Policy notices this person accepted. */}
        <AgreementHistory client={agreementsClient} />
      </div>
    </>
  );
}

function ChangePasswordCard(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const [failure, setFailure] = useState<string | null>(null);

  const form = useForm<PasswordValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { currentPassword: '', newPassword: '', confirm: '' },
  });

  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit(async (values) => {
    setFailure(null);

    try {
      await changePassword(values.currentPassword, values.newPassword);
      form.reset();
      toast.success(t('profile.passwordChanged'));
    } catch (error) {
      if (error instanceof NetworkError) {
        setFailure(t('common.couldNotReachServer'));
        return;
      }
      setFailure(error instanceof ApiError ? error.message : t('common.theRequestFailed'));
    }
  });

  return (
    <Card title={t('profile.changePassword')} bodyClassName="px-5 py-4">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {failure === null ? null : (
          <Callout tone="danger" role="alert">
            {failure}
          </Callout>
        )}

        <Field
          label={t('profile.currentPassword')}
          error={errors.currentPassword === undefined ? undefined : t('profile.currentRequired')}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              type="password"
              autoComplete="current-password"
              {...form.register('currentPassword')}
            />
          )}
        </Field>

        <Field
          label={t('reset.newPassword')}
          hint={t('password.hint')}
          error={
            errors.newPassword === undefined
              ? undefined
              : errors.newPassword.message === 'SAME'
                ? t('profile.mustDiffer')
                : t('password.hint')
          }
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              type="password"
              autoComplete="new-password"
              {...form.register('newPassword')}
            />
          )}
        </Field>

        <Field
          label={t('activate.confirm')}
          error={errors.confirm === undefined ? undefined : t('activate.mismatch')}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              type="password"
              autoComplete="new-password"
              {...form.register('confirm')}
            />
          )}
        </Field>

        <Button type="submit" variant="primary" isLoading={form.formState.isSubmitting}>
          {t('profile.changePassword')}
        </Button>
      </form>
    </Card>
  );
}
