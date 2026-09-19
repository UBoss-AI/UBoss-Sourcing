/**
 * Redeeming an invitation.
 *
 * The only way a logistics account ever becomes usable. The token arrives in
 * the URL, it works once, and the person chooses their own password here - no
 * password was ever emailed, and none ever will be.
 *
 * The token is deliberately NOT echoed back into the page, logged, or put in a
 * title. It is read from the query string, sent once, and forgotten.
 */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ApiError, NetworkError } from '@/lib/api';
import { Button, Callout, CheckboxField, Field, Input } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { activateAccount } from '@/lib/logistics';
import { useFocusOnMount } from '@/lib/use-focus-on-mount';
import { AuthLayout } from './AuthLayout';

/**
 * The password rules, stated rather than implied.
 *
 * Twelve characters and nothing else. Not a character-class rule: those push
 * people towards `Password1!` and are worse than length, which is the one
 * requirement that reliably buys entropy. The backend enforces its own
 * minimum; this is the same number said in front of the person typing.
 */
const schema = z
  .object({
    password: z.string().min(12),
    confirm: z.string().min(1),
    acceptedTerms: z.literal(true),
  })
  .refine((values) => values.password === values.confirm, {
    path: ['confirm'],
    message: 'MISMATCH',
  });

type FormValues = z.infer<typeof schema>;

export function ActivatePage(): React.JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [params] = useSearchParams();

  const token = params.get('token') ?? '';
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirm: '', acceptedTerms: false as unknown as true },
  });

  const { ref: passwordRef, ...passwordField } = form.register('password');
  const focusPassword = useFocusOnMount<HTMLInputElement>(passwordRef);

  if (token.length === 0) {
    return (
      <AuthLayout heading={t('activate.heading')}>
        <Callout tone="danger" role="alert">
          {t('activate.linkProblem')}
        </Callout>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout heading={t('activate.heading')}>
        <Callout tone="success" role="status">
          {t('activate.done')}
        </Callout>
        <Link to="/login" className="mt-4 block">
          <Button className="w-full">{t('auth.signIn')}</Button>
        </Link>
      </AuthLayout>
    );
  }

  const onSubmit = form.handleSubmit(async (values) => {
    setFailure(null);

    try {
      await activateAccount({
        token,
        password: values.password,
        acceptedTerms: values.acceptedTerms,
      });

      setDone(true);

      // Straight to sign-in after a beat, so somebody who reads the
      // confirmation does not have to find the button.
      setTimeout(() => {
        void navigate('/login', { replace: true });
      }, 2500);
    } catch (error) {
      if (error instanceof NetworkError) {
        setFailure(t('common.couldNotReachServer'));
        return;
      }

      setFailure(error instanceof ApiError ? error.message : t('common.theRequestFailed'));
    }
  });

  return (
    <AuthLayout heading={t('activate.heading')} subheading={t('activate.subheading')}>
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {failure === null ? null : (
          <Callout tone="danger" role="alert">
            {failure}
          </Callout>
        )}

        <Field
          label={t('activate.password')}
          error={
            form.formState.errors.password === undefined ? undefined : t('activate.subheading')
          }
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

        <CheckboxField label={t('activate.submit')} {...form.register('acceptedTerms')} />

        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {t('activate.submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
