/**
 * Set a new password from an emailed reset link.
 *
 * Reached at `/reset-password?token=…`, the URL the backend built from
 * `AUDIT_WEB_PUBLIC_URL`. The token is single-use and short-lived: it may be
 * expired, already spent, or simply wrong, and somebody locked out of their
 * account cannot be left guessing which.
 *
 * As in the admin console, the token is never checked by a separate call
 * first - the form submits and the server's own error code decides what is
 * shown. And a dead link is never a dead end: every terminal failure offers
 * the one action that recovers it, asking for a fresh link.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ApiError, NetworkError } from '@/lib/api';
import { Button, Callout, Field, Input } from '@/components/ui';
import { useI18n, type Translate } from '@/i18n/i18n-context';
import { resetPassword } from '@/lib/audit';
import { useFocusOnMount } from '@/lib/use-focus-on-mount';
import { AuthLayout } from './AuthLayout';

const schema = z
  .object({
    password: z.string().min(12).max(128),
    confirm: z.string().min(1),
  })
  .refine((values) => values.password === values.confirm, {
    path: ['confirm'],
    message: 'MISMATCH',
  });

type FormValues = z.infer<typeof schema>;

/** Failures no amount of retyping can fix - the link itself is the problem. */
const TERMINAL_CODES = new Set([
  'TOKEN_EXPIRED',
  'TOKEN_ALREADY_USED',
  'TOKEN_INVALID',
  'ACCOUNT_DEACTIVATED',
]);

function recoveryFor(t: Translate, code: string): { title: string; body: string } {
  switch (code) {
    case 'TOKEN_EXPIRED':
      return { title: t('reset.expiredTitle'), body: t('reset.expiredBody') };
    case 'TOKEN_ALREADY_USED':
      return { title: t('reset.usedTitle'), body: t('reset.usedBody') };
    case 'ACCOUNT_DEACTIVATED':
      return { title: t('reset.deactivatedTitle'), body: t('reset.deactivatedBody') };
    default:
      return { title: t('reset.invalidTitle'), body: t('reset.invalidBody') };
  }
}

function DeadLink({ code, message }: { code: string; message: string | null }): React.JSX.Element {
  const { t } = useI18n();
  const recovery = recoveryFor(t, code);

  return (
    <AuthLayout heading={recovery.title}>
      <Callout tone="danger" role="alert">
        <p>{recovery.body}</p>
        {/* The server's own wording, kept alongside ours rather than replacing it. */}
        {message === null ? null : <p className="mt-1.5 text-xs">{message}</p>}
      </Callout>

      <div className="mt-6 space-y-2.5">
        <Link to="/forgot-password" className="block">
          <Button className="w-full">{t('reset.emailNewLink')}</Button>
        </Link>
        <Link to="/login" className="block">
          <Button variant="secondary" className="w-full">
            {t('forgot.backToSignIn')}
          </Button>
        </Link>
      </div>
    </AuthLayout>
  );
}

export function ResetPasswordPage(): React.JSX.Element {
  const { t } = useI18n();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';

  const [done, setDone] = useState(false);
  const [failure, setFailure] = useState<{ code: string; message: string } | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirm: '' },
  });

  const { ref: passwordRef, ...passwordField } = form.register('password');
  const focusPassword = useFocusOnMount<HTMLInputElement>(passwordRef);

  // A link with no token never reaches the server: there is nothing to send.
  if (token === '') return <DeadLink code="TOKEN_INVALID" message={null} />;

  if (failure !== null && TERMINAL_CODES.has(failure.code)) {
    return <DeadLink code={failure.code} message={failure.message} />;
  }

  if (done) {
    return (
      <AuthLayout heading={t('reset.doneHeading')}>
        <Callout tone="success" role="status">
          {t('reset.doneBody')}
        </Callout>
        <Link to="/login" className="mt-6 block">
          <Button className="w-full">{t('auth.signIn')}</Button>
        </Link>
      </AuthLayout>
    );
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setFailure(null);

    try {
      await resetPassword(token, values.password);
      setDone(true);
    } catch (error) {
      if (error instanceof NetworkError) {
        setFailure({ code: 'NETWORK', message: t('common.couldNotReachServer') });
        return;
      }
      if (error instanceof ApiError) {
        setFailure({ code: error.code, message: error.message });
        return;
      }
      setFailure({ code: 'UNKNOWN', message: t('common.theRequestFailed') });
    }
  });

  return (
    <AuthLayout heading={t('reset.heading')} subheading={t('reset.subheading')}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {/* A non-terminal failure - a rate limit, a network blip - leaves the
            form in place, because retrying is the right next move. */}
        {failure === null ? null : (
          <Callout tone="danger" role="alert">
            {failure.message}
          </Callout>
        )}

        <Field
          label={t('reset.newPassword')}
          hint={t('password.hint')}
          error={form.formState.errors.password === undefined ? undefined : t('password.hint')}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              {...passwordField}
              ref={focusPassword}
              type="password"
              autoComplete="new-password"
            />
          )}
        </Field>

        <Field
          label={t('activate.confirm')}
          error={form.formState.errors.confirm === undefined ? undefined : t('activate.mismatch')}
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

        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {t('reset.submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
