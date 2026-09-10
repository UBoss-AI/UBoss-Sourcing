/**
 * Change your password.
 *
 * Lifted out of the old single-file profile page unchanged in behaviour, so
 * that the profile screen can be a column of panels rather than a thousand
 * lines. The current password is required and always will be: without it, a
 * borrowed session is a permanent one — the holder changes the password and
 * the real owner is locked out of their own purchasing account.
 *
 * The server revokes every other session on success. Nothing here has to do
 * that, and nothing here should claim credit for it.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { z } from 'zod';
import { useToast } from '@/components/toast-context';
import { Button, Field, Input } from '@/components/ui';
import { NetworkError, api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/i18n/i18n-context';
import type { Translate } from '@/i18n/i18n-context';
import { AccountPanel } from './AccountPanel';

function buildPasswordSchema(t: Translate) {
  return z
    .object({
      currentPassword: z.string().min(1, t('profile.enterYourCurrentPassword')),
      newPassword: z
        .string()
        .min(12, t('validation.passwordTooShort'))
        .max(128, t('validation.passwordTooLong')),
      confirmPassword: z.string(),
    })
    .refine((values) => values.newPassword === values.confirmPassword, {
      path: ['confirmPassword'],
      message: t('validation.passwordsDoNotMatch'),
    });
}

type PasswordForm = z.output<ReturnType<typeof buildPasswordSchema>>;

export function PasswordPanel(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();

  const [isEditing, setIsEditing] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<PasswordForm>({
    resolver: zodResolver(buildPasswordSchema(t)),
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
      setIsEditing(false);
      reset();
      toast.success(t('profile.passwordChanged'));
    },
    onError: (error) => {
      // A network failure and a refused password are different messages, and
      // the difference matters: one is "try again", the other is "that was
      // wrong".
      if (error instanceof NetworkError) {
        setFormError(errorMessage(t, error));
        return;
      }
      setFormError(errorMessage(t, error, t('profile.passwordCouldNotBeChanged')));
    },
  });

  return (
    <AccountPanel
      title={t('profile.changeYourPassword')}
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

          <Field
            label={t('profile.currentPassword')}
            error={errors.currentPassword?.message}
            required
          >
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
            label={t('profile.newPassword')}
            hint={t('profile.atLeast12Characters')}
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

          <Field
            label={t('profile.confirmTheNewPassword')}
            error={errors.confirmPassword?.message}
            required
          >
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

          <div className="flex items-center gap-2">
            <Button type="submit" variant="primary" isLoading={isSubmitting || change.isPending}>
              {t('profile.changePassword')}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setIsEditing(false);
                setFormError(null);
                reset();
              }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
          {t('profile.passwordPanelSummary')}
        </p>
      )}
    </AccountPanel>
  );
}
