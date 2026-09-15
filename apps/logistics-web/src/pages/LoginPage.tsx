/**
 * Signing in.
 *
 * The one screen that says out loud what the portal's access model is: there
 * is no sign-up link and there is no "create an account", because a logistics
 * partner is created by the marketplace and its people are invited. A visitor
 * who arrives here without an invitation should be told that rather than left
 * hunting for a button that does not exist.
 */
import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ApiError, NetworkError } from '@/lib/api';
import { useFocusOnMount } from '@/lib/use-focus-on-mount';
import { Button, Callout, Field, Input } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { useSession } from '@/auth/session-context';
import { AuthLayout } from './AuthLayout';

const schema = z.object({
  email: z.string().trim().min(1).pipe(z.email()),
  password: z.string().min(1),
});

type FormValues = z.infer<typeof schema>;

export function LoginPage(): React.JSX.Element {
  const { t } = useI18n();
  const { stage, signIn } = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  const [failure, setFailure] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  });

  const focusEmail = useFocusOnMount();
  const { ref: emailRef, ...emailField } = form.register('email');

  /*
   * Already signed in.
   *
   * Includes the two MFA stages: somebody who is mid-enrolment and presses
   * Back should land on the wizard rather than on a login form that would sign
   * them in again.
   */
  if (stage !== 'SIGNED_OUT' && stage !== 'LOADING') {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from ?? '/dashboard'} replace />;
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setFailure(null);

    try {
      await signIn(values.email, values.password);

      const from = (location.state as { from?: string } | null)?.from;
      void navigate(from ?? '/dashboard', { replace: true });
    } catch (error) {
      if (error instanceof NetworkError) {
        setFailure(t('common.couldNotReachServer'));
        return;
      }

      /*
       * The server's own message, verbatim.
       *
       * It distinguishes a locked account from a wrong password from an
       * account that has not been activated, and each one needs a different
       * thing from the person reading it. Replacing all three with "sign-in
       * failed" would send somebody with a live invitation email hunting for a
       * password they never had.
       */
      setFailure(error instanceof ApiError ? error.message : t('common.theRequestFailed'));
    }
  });

  return (
    <AuthLayout heading={t('auth.heading')} subheading={t('auth.subheading')}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {failure === null ? null : (
          <Callout tone="danger" role="alert">
            {failure}
          </Callout>
        )}

        <Field label={t('auth.email')} error={form.formState.errors.email?.message}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              {...emailField}
              ref={(node) => {
                emailRef(node);
                focusEmail(node);
              }}
              type="email"
              autoComplete="username"
            />
          )}
        </Field>

        <Field label={t('auth.password')} error={form.formState.errors.password?.message}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              type="password"
              autoComplete="current-password"
              {...form.register('password')}
            />
          )}
        </Field>

        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? t('auth.signingIn') : t('auth.signIn')}
        </Button>
      </form>

      <p className="mt-6 text-center text-xs text-ink-subtle">{t('auth.noSelfSignup')}</p>
    </AuthLayout>
  );
}
