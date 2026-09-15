/**
 * The second factor: enrolling, and answering.
 *
 * Both screens render IN PLACE of the portal rather than as routes — see
 * `RequireSession`. The backend refuses every route but three until the
 * challenge is passed, and a redirect could be navigated away from, so making
 * these a stage rather than a page is the honest rendering of what the server
 * is already doing.
 *
 * THE QR CODE IS DRAWN IN THE BROWSER
 *
 * From the `otpauth://` URI the server returned, with no image request and no
 * third-party library. Two reasons, and the second is the one that matters: a
 * QR image fetched from anywhere would send the account's TOTP SECRET to
 * whoever served it, and that is the entire second factor. There is no
 * deployment where that is acceptable, so it is not an option that exists
 * here.
 */
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation } from '@tanstack/react-query';
import { ApiError, NetworkError } from '@/lib/api';
import { Button, Callout, Field, Input } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { useSession } from '@/auth/session-context';
import { beginMfaSetup, verifyMfa } from '@/lib/logistics';
import type { MfaEnrolment } from '@/lib/types';
import { useFocusOnMount } from '@/lib/use-focus-on-mount';
import { AuthLayout } from './AuthLayout';
import { QrCode } from './QrCode';

const codeSchema = z.object({ code: z.string().trim().min(6).max(16) });
type CodeValues = z.infer<typeof codeSchema>;

// ---------------------------------------------------------------------------
// Enrolling
// ---------------------------------------------------------------------------

export function MfaSetupPage(): React.JSX.Element {
  const { t } = useI18n();
  const { refresh, signOut } = useSession();

  const [enrolment, setEnrolment] = useState<MfaEnrolment | null>(null);
  const [savedCodes, setSavedCodes] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const begin = useMutation({
    mutationFn: beginMfaSetup,
    onSuccess: setEnrolment,
    onError: (error: unknown) => {
      setFailure(describe(error, t));
    },
  });

  const form = useForm<CodeValues>({
    resolver: zodResolver(codeSchema),
    defaultValues: { code: '' },
  });

  const focusCode = useFocusOnMount();
  const { ref: codeRef, ...codeField } = form.register('code');

  const confirm = form.handleSubmit(async (values) => {
    setFailure(null);

    try {
      await verifyMfa(values.code, 'ENROL');
      await refresh();
    } catch (error) {
      setFailure(describe(error, t));
    }
  });

  // --- Step 1: get the secret ---------------------------------------------
  if (enrolment === null) {
    return (
      <AuthLayout heading={t('mfa.setupHeading')} subheading={t('mfa.setupBody')}>
        {failure === null ? null : (
          <Callout tone="danger" role="alert">
            {failure}
          </Callout>
        )}

        <Button
          className="mt-4 w-full"
          disabled={begin.isPending}
          onClick={() => {
            begin.mutate();
          }}
        >
          {t('mfa.setupHeading')}
        </Button>

        <button
          type="button"
          className="mt-4 w-full text-center text-xs text-ink-subtle hover:underline"
          onClick={() => {
            void signOut();
          }}
        >
          {t('auth.signOut')}
        </button>
      </AuthLayout>
    );
  }

  // --- Step 2: the recovery codes, shown once ------------------------------
  if (!savedCodes) {
    return (
      <AuthLayout heading={t('mfa.recoveryHeading')} subheading={t('mfa.recoveryBody')} wide>
        <ul className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-surface-sunken p-4 font-mono text-sm text-ink">
          {enrolment.recoveryCodes.map((code) => (
            <li key={code} className="tracking-wider">
              {code}
            </li>
          ))}
        </ul>

        <Button
          className="mt-6 w-full"
          onClick={() => {
            setSavedCodes(true);
          }}
        >
          {t('mfa.recoveryConfirm')}
        </Button>
      </AuthLayout>
    );
  }

  // --- Step 3: prove the app works -----------------------------------------
  return (
    <AuthLayout heading={t('mfa.setupHeading')} subheading={t('mfa.setupBody')} wide>
      <div className="grid gap-6 sm:grid-cols-[auto,1fr] sm:items-start">
        <div className="mx-auto rounded-xl border border-border bg-white p-3">
          <QrCode value={enrolment.uri} size={168} />
        </div>

        <div className="min-w-0">
          <p className="text-xs font-medium text-ink-muted">{t('mfa.secretLabel')}</p>
          <p className="mt-1 break-all rounded-md bg-surface-sunken px-3 py-2 font-mono text-sm tracking-wider text-ink">
            {enrolment.secret}
          </p>

          <form onSubmit={confirm} noValidate className="mt-5 space-y-4">
            {failure === null ? null : (
              <Callout tone="danger" role="alert">
                {failure}
              </Callout>
            )}

            <Field label={t('mfa.code')}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  {...codeField}
                  ref={(node) => {
                    codeRef(node);
                    focusCode(node);
                  }}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                />
              )}
            </Field>

            <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
              {t('mfa.verify')}
            </Button>
          </form>
        </div>
      </div>
    </AuthLayout>
  );
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

export function MfaChallengePage(): React.JSX.Element {
  const { t } = useI18n();
  const { refresh, signOut } = useSession();

  const [failure, setFailure] = useState<string | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);

  const form = useForm<CodeValues>({
    resolver: zodResolver(codeSchema),
    defaultValues: { code: '' },
  });

  const focusCode = useFocusOnMount();
  const { ref: codeRef, ...codeField } = form.register('code');

  const submit = form.handleSubmit(async (values) => {
    setFailure(null);

    try {
      await verifyMfa(values.code, 'CHALLENGE');
      await refresh();
    } catch (error) {
      setFailure(describe(error, t));
      form.reset({ code: '' });
    }
  });

  return (
    <AuthLayout heading={t('mfa.challengeHeading')} subheading={t('mfa.challengeBody')}>
      <form onSubmit={submit} noValidate className="space-y-4">
        {failure === null ? null : (
          <Callout tone="danger" role="alert">
            {failure}
          </Callout>
        )}

        <Field label={useRecovery ? t('mfa.useRecovery') : t('mfa.code')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              // A recovery code is letters and dashes; a TOTP code is six
              // digits. The keyboard a phone offers should match.
              {...codeField}
              ref={(node) => {
                codeRef(node);
                focusCode(node);
              }}
              inputMode={useRecovery ? 'text' : 'numeric'}
              autoComplete="one-time-code"
              maxLength={useRecovery ? 16 : 6}
            />
          )}
        </Field>

        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {t('mfa.verify')}
        </Button>
      </form>

      <button
        type="button"
        className="mt-4 w-full text-center text-xs text-brand hover:underline"
        onClick={() => {
          setUseRecovery((value) => !value);
          form.reset({ code: '' });
        }}
      >
        {useRecovery ? t('mfa.challengeHeading') : t('mfa.useRecovery')}
      </button>

      <button
        type="button"
        className="mt-3 w-full text-center text-xs text-ink-subtle hover:underline"
        onClick={() => {
          void signOut();
        }}
      >
        {t('auth.signOut')}
      </button>
    </AuthLayout>
  );
}

/** The server's own message wherever there is one. */
function describe(error: unknown, t: (key: never) => string): string {
  if (error instanceof NetworkError) return t('common.couldNotReachServer' as never);
  if (error instanceof ApiError) return error.message;
  return t('common.theRequestFailed' as never);
}
