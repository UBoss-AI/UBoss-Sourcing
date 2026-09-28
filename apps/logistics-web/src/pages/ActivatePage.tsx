/**
 * Redeeming an invitation.
 *
 * The only way a logistics account ever becomes usable. The token arrives in
 * the URL, it works once, and the person chooses their own password here - no
 * password was ever emailed, and none ever will be.
 *
 * The token is deliberately NOT echoed back into the page, logged, or put in a
 * title. It is read from the query string, sent once, and forgotten.
 *
 * The Logistics Partner Terms are agreed to here, in their own dialog: the box
 * is ticked only by I agree at the end of the text, and the server checks the
 * document agreed to is the version in force before it spends the link. A
 * refusal about the terms therefore leaves the link usable - agree to the
 * current version and press the button again.
 */
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ApiError, NetworkError } from '@/lib/api';
import { TermsAgreementField } from '@/components/legal/TermsAgreementField';
import { useCurrentTerms } from '@/components/legal/useCurrentTerms';
import { Button, Callout, Field, Input } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
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
    // Set only by I agree in the terms dialog. See `TermsAgreementField`.
    termsDocumentId: z
      .string()
      .nullable()
      .refine((value) => value?.length === 26, { message: 'TERMS_REQUIRED' }),
  })
  .refine((values) => values.password === values.confirm, {
    path: ['confirm'],
    message: 'MISMATCH',
  });

type FormValues = z.infer<typeof schema>;

/** Refusals about the terms. The link was not spent; the person agrees again. */
const TERMS_CODES = new Set([
  'TERMS_ACCEPTANCE_REQUIRED',
  'TERMS_VERSION_OUTDATED',
  'TERMS_DOCUMENT_UNAVAILABLE',
]);

export function ActivatePage(): React.JSX.Element {
  const { t, language } = useI18n();
  const navigate = useNavigate();
  // A carrier's staff agree to the carrier terms, never the buyer terms.
  const terms = useCurrentTerms('LOGISTICS_PARTNER_TERMS', language);
  const [termsError, setTermsError] = useState<string | null>(null);
  const [params] = useSearchParams();

  const token = params.get('token') ?? '';
  const [failure, setFailure] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirm: '', termsDocumentId: null },
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
    setTermsError(null);

    try {
      await activateAccount({
        token,
        password: values.password,
        acceptedTerms: values.termsDocumentId !== null,
        termsDocumentId: values.termsDocumentId,
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

      if (error instanceof ApiError && TERMS_CODES.has(error.code)) {
        form.setValue('termsDocumentId', null);
        terms.reload();
        setTermsError(t(`errors.terms.${error.code}` as TranslationKey));
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

        <Controller
          name="termsDocumentId"
          control={form.control}
          render={({ field }) => (
            <TermsAgreementField
              terms={terms}
              value={field.value}
              onChange={(next) => {
                setTermsError(null);
                field.onChange(next);
              }}
              error={
                termsError ??
                (form.formState.errors.termsDocumentId === undefined
                  ? undefined
                  : t('errors.terms.TERMS_ACCEPTANCE_REQUIRED'))
              }
            />
          )}
        />

        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {t('activate.submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}
