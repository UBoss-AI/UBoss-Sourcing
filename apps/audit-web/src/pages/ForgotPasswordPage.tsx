/**
 * Request a password reset.
 *
 * The confirmation is deliberately identical whether or not the address has an
 * account. The backend answers the same for both, because a form that says "no
 * such account" is a way to find out who audits for this marketplace. This
 * page shows one message and never branches on the answer.
 *
 * The admin console's screen, in this console's sign-in frame (`AuthLayout`)
 * so all four signed-out screens here look like one product.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ApiError, NetworkError } from '@/lib/api';
import { Button, Callout, Field, Input } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { requestPasswordReset } from '@/lib/audit';
import { useFocusOnMount } from '@/lib/use-focus-on-mount';
import { AuthLayout } from './AuthLayout';

const schema = z.object({ email: z.string().trim().min(1).pipe(z.email()) });
type FormValues = z.infer<typeof schema>;

export function ForgotPasswordPage(): React.JSX.Element {
  const { t } = useI18n();
  const [sent, setSent] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  });

  const { ref: emailRef, ...emailField } = form.register('email');
  const focusEmail = useFocusOnMount<HTMLInputElement>(emailRef);

  if (sent) {
    return (
      <AuthLayout heading={t('forgot.sentHeading')}>
        <Callout tone="success" role="status">
          <p>{t('forgot.sentBody')}</p>
          <p className="mt-1.5">{t('forgot.sentSpam')}</p>
        </Callout>
        <Link to="/login" className="mt-6 block">
          <Button variant="secondary" className="w-full">
            {t('forgot.backToSignIn')}
          </Button>
        </Link>
      </AuthLayout>
    );
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setFailure(null);

    try {
      await requestPasswordReset(values.email.trim());
      setSent(true);
    } catch (error) {
      // Only a transport or rate-limit failure lands here. A missing account
      // is not an error at all - that is the point of the uniform response.
      if (error instanceof NetworkError) {
        setFailure(t('common.couldNotReachServer'));
        return;
      }
      if (error instanceof ApiError) {
        setFailure(error.status === 429 ? t('forgot.rateLimited') : error.message);
        return;
      }
      setFailure(t('common.theRequestFailed'));
    }
  });

  return (
    <AuthLayout heading={t('forgot.heading')} subheading={t('forgot.subheading')}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {failure === null ? null : (
          <Callout tone="danger" role="alert">
            {failure}
          </Callout>
        )}

        <Field
          label={t('auth.email')}
          error={form.formState.errors.email === undefined ? undefined : t('forgot.emailInvalid')}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              {...emailField}
              ref={focusEmail}
              type="email"
              autoComplete="username"
            />
          )}
        </Field>

        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {t('forgot.submit')}
        </Button>
      </form>

      <p className="mt-6 text-center text-sm">
        <Link to="/login" className="font-medium text-brand hover:underline">
          {t('forgot.backToSignIn')}
        </Link>
      </p>
    </AuthLayout>
  );
}
