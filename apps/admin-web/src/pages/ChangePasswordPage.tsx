/**
 * First sign-in: replace the emailed temporary password.
 *
 * Shown instead of the whole panel — not as a route somebody navigates to, but
 * as what `RequireAuth` renders while `mustChangePassword` is set. There is no
 * "skip" and no navigation, because there is nothing to navigate to: the
 * backend refuses every admin route until this is done, so a menu here would
 * only lead to a wall of 403s.
 *
 * The reason it is compulsory rather than a suggestion: the temporary password
 * arrived by email in plaintext and is still sitting in that inbox. Until it is
 * replaced, anyone who can read the inbox can be this member of staff.
 *
 * Changing a password ends every session, this one included. Rather than
 * dropping somebody back at a sign-in form to retype a password they chose one
 * second ago, this signs them straight back in.
 *
 * **Why this form validates with react-hook-form's own rules and not
 * `zodResolver` like every other form here:** `@hookform/resolvers@3` cannot
 * read a `zod@4` error — it checks `error.errors`, which v4 renamed to
 * `error.issues` — so a failed validation throws instead of producing field
 * messages. That bug affects every form in this app, but this is the first
 * screen a new member of staff ever sees, and it must not be the one that
 * breaks. Fixing the dependency is the real answer; until then this form does
 * not depend on it.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useSession } from '@/auth/session-context';
import { Button, Field, Input } from '@/components/ui';
import { ApiError, NetworkError, api } from '@/lib/api';

interface FormValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

/** Mirrors the backend's password policy, so the rule is shown while typing. */
const MIN_LENGTH = 12;
const MAX_LENGTH = 128;

export function ChangePasswordPage(): React.JSX.Element {
  const { user, login, logout } = useSession();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    getValues,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
  });

  useEffect(() => {
    setFocus('currentPassword');
  }, [setFocus]);

  const onSubmit = async (values: FormValues): Promise<void> => {
    setFormError(null);

    try {
      await api.post('/admin/auth/password/change', {
        currentPassword: values.currentPassword,
        newPassword: values.newPassword,
      });
    } catch (error) {
      if (error instanceof NetworkError) {
        setFormError(error.message);
        return;
      }
      if (error instanceof ApiError) {
        setFormError(error.message);
        return;
      }
      setFormError('We could not set your password. Please try again.');
      return;
    }

    // The change succeeded and took this session with it. Anything that fails
    // from here is a sign-in problem, not a password problem, so the account is
    // never left looking broken when it is actually fine.
    try {
      await login(user?.email ?? '', values.newPassword);
    } catch {
      await logout();
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span
            aria-hidden="true"
            className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white"
          >
            U
          </span>
          <h1 className="text-lg font-semibold tracking-tight text-ink">Choose your password</h1>
          <p className="mt-1 text-sm text-ink-muted">
            You signed in with the temporary password we emailed
            {user === null ? '' : ` to ${user.email}`}. Replace it before you go any further.
          </p>
        </div>

        <form
          onSubmit={(event) => void handleSubmit(onSubmit)(event)}
          noValidate
          className="space-y-4 rounded-lg border border-border bg-surface p-6 shadow-card"
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
            label="Temporary password"
            hint="The one from the email. It stops working as soon as you finish here."
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
                {...register('currentPassword', {
                  required: 'Enter the temporary password from your email.',
                })}
              />
            )}
          </Field>

          <Field
            label="Your new password"
            hint="At least 12 characters. A short phrase you will remember beats a short jumble you will not."
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
                {...register('newPassword', {
                  required: 'Choose a password.',
                  minLength: { value: MIN_LENGTH, message: 'Use at least 12 characters.' },
                  maxLength: { value: MAX_LENGTH, message: 'Use at most 128 characters.' },
                  validate: (value) =>
                    value !== getValues('currentPassword') ||
                    'Choose something different from the temporary password.',
                })}
              />
            )}
          </Field>

          <Field
            label="Confirm your new password"
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
                {...register('confirmPassword', {
                  required: 'Type the password again.',
                  validate: (value) =>
                    value === getValues('newPassword') || 'The two passwords do not match.',
                })}
              />
            )}
          </Field>

          <Button type="submit" variant="primary" className="w-full" isLoading={isSubmitting}>
            Save and continue
          </Button>

          <p className="text-center text-xs text-ink-muted">
            Nobody else knows this one — not even whoever set your account up.
          </p>
        </form>
      </div>
    </div>
  );
}
