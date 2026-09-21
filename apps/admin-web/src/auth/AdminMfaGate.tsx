/**
 * Unskippable administrator MFA enrolment and per-session challenge.
 *
 * THE QR CODE IS THE PRIMARY WAY IN, and the setup key is the fall-back
 * beside it, not the other way round. This screen used to print only the
 * thirty-two character base32 key and ask an administrator to type it into a
 * phone. That is slow, it is mistyped, and every mistyped attempt spends a
 * request against the rate limit in front of this endpoint - so the screen
 * that exists to let somebody in was the screen most likely to lock them out.
 * A scan is one action and cannot be mistyped.
 *
 * The code is drawn in this browser tab, by `components/QrCode`, from the
 * `otpauth://` URI the setup call returned. It is never fetched as an image:
 * that URI carries the TOTP secret, and an image URL would hand the whole
 * second factor to whoever serves it and to every cache in between.
 *
 * ONE ENROLMENT PER VISIT. `/mfa/setup` issues a fresh secret each time it is
 * called, so a reload replaces the secret behind a code that has already been
 * scanned - the phone then shows six digits for an account the server has
 * forgotten, and the administrator burns attempts on a code that can never be
 * right. The screen holds the enrolment in state for as long as it is mounted
 * and says plainly that leaving invalidates it.
 */
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useSession } from './session-context';
import { Button, CheckboxField, Field, Input, Spinner } from '@/components/ui';
import { QrCode } from '@/components/QrCode';
import { useI18n } from '@/i18n/i18n-context';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import { ApiError, NetworkError, api } from '@/lib/api';

interface MfaForm {
  code: string;
}

interface Enrolment {
  secret: string;
  uri: string;
  recoveryCodes: string[];
}

export function AdminMfaGate(): React.JSX.Element {
  const { t } = useI18n();
  const { user, refreshUser, logout } = useSession();
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [savedRecoveryCodes, setSavedRecoveryCodes] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<MfaForm>({ defaultValues: { code: '' } });

  const enrolling = user?.mfaEnabled !== true;

  useEffect(() => {
    if (user?.mfaEnabled === true || enrolment !== null || isStarting) return;
    setIsStarting(true);
    void api
      .post<Enrolment>('/admin/auth/mfa/setup')
      .then((result) => {
        setEnrolment(result);
      })
      .catch((error: unknown) => {
        setFormError(
          error instanceof ApiError || error instanceof NetworkError
            ? error.message
            : t('auth.mfa.setupFailed'),
        );
      })
      .finally(() => {
        setIsStarting(false);
      });
  }, [enrolment, isStarting, t, user?.mfaEnabled]);

  useEffect(() => {
    setFocus('code');
  }, [setFocus]);

  const onSubmit = async (values: MfaForm): Promise<void> => {
    setFormError(null);
    try {
      await api.post('/admin/auth/mfa/verify', {
        code: values.code,
        mode: enrolling ? 'ENROL' : 'CHALLENGE',
      });
      await refreshUser();
    } catch (error) {
      setFormError(
        error instanceof ApiError || error instanceof NetworkError
          ? error.message
          : t('auth.mfa.verifyFailed'),
      );
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-10">
      {/* Wide enough for the code and the key side by side while enrolling;
          the challenge is one input and stays the width of every other gate. */}
      <div className={enrolling ? 'w-full max-w-xl' : 'w-full max-w-sm'}>
        {/* The same reasoning as the sign-in, location and change-password
            screens: this is a hard gate, so the language picker has to be
            reachable from it or somebody who cannot read the panel is stuck. */}
        <LanguageSwitcher placement="auth" />

        <div className="mb-6 flex flex-col items-center text-center">
          <span
            aria-hidden="true"
            className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-brand-fill text-sm font-bold text-white"
          >
            U
          </span>
          <h1 className="text-lg font-semibold tracking-tight text-ink">{t('auth.mfa.heading')}</h1>
          <p className="mt-1 text-sm text-ink-muted">
            {enrolling ? t('auth.mfa.enrolIntro') : t('auth.mfa.challengeIntro')}
          </p>
        </div>

        <form
          onSubmit={(event) => void handleSubmit(onSubmit)(event)}
          className="space-y-5 rounded-lg border border-border bg-surface p-6 shadow-card"
          noValidate
        >
          {formError !== null && (
            <div
              role="alert"
              className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
            >
              {formError}
            </div>
          )}

          {enrolling && enrolment === null && isStarting && (
            <div className="flex items-center gap-2.5 text-sm text-ink-muted">
              <Spinner className="h-4 w-4 shrink-0 text-ink-subtle" />
              <span role="status">{t('auth.mfa.preparing')}</span>
            </div>
          )}

          {enrolling && enrolment !== null && (
            <div className="space-y-5">
              <div>
                <p className="text-sm font-medium text-ink">{t('auth.mfa.scanHeading')}</p>
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                  {t('auth.mfa.scanBody')} {t('auth.mfa.appHint')}
                </p>

                <div className="mt-3 grid gap-4 sm:grid-cols-[auto,1fr] sm:items-start">
                  {/* The white mount is part of the code, not decoration: a
                      scanner needs the quiet zone to stay light, and the
                      surface behind it follows the console into dark mode. */}
                  <div className="mx-auto rounded-xl border border-border bg-white p-3 sm:mx-0">
                    <QrCode value={enrolment.uri} size={168} />
                  </div>

                  <div className="min-w-0">
                    <p className="text-xs font-medium text-ink">{t('auth.mfa.keyHeading')}</p>
                    <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                      {t('auth.mfa.keyBody')}
                    </p>
                    <code className="mt-2 block select-all break-all rounded-md bg-surface-sunken px-3 py-2 font-mono text-sm tracking-wider text-ink">
                      {enrolment.secret}
                    </code>
                    <p className="mt-3 text-xs leading-relaxed text-warning">
                      {t('auth.mfa.scanReload')}
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <p className="text-sm font-medium text-ink">{t('auth.mfa.recoveryHeading')}</p>
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                  {t('auth.mfa.recoveryBody')}
                </p>
                <div className="mt-2 grid grid-cols-2 gap-1 rounded-md bg-surface-sunken p-3 font-mono text-xs tracking-wider text-ink">
                  {enrolment.recoveryCodes.map((code) => (
                    <span key={code}>{code}</span>
                  ))}
                </div>
                <CheckboxField
                  className="mt-3"
                  label={t('auth.mfa.recoverySaved')}
                  checked={savedRecoveryCodes}
                  onChange={(event) => {
                    setSavedRecoveryCodes(event.target.checked);
                  }}
                />
              </div>
            </div>
          )}

          {(!enrolling || enrolment !== null) && (
            <Field
              label={enrolling ? t('auth.mfa.codeEnrol') : t('auth.mfa.codeChallenge')}
              error={errors.code?.message}
              required
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  aria-describedby={describedBy}
                  invalid={errors.code !== undefined}
                  {...register('code', {
                    required: t('auth.mfa.codeRequired'),
                    minLength: { value: 6, message: t('auth.mfa.codeTooShort') },
                    maxLength: { value: 16, message: t('auth.mfa.codeTooLong') },
                  })}
                />
              )}
            </Field>
          )}

          <div className="space-y-2">
            <Button
              type="submit"
              variant="primary"
              className="w-full"
              isLoading={isSubmitting || isStarting}
              disabled={enrolling && (enrolment === null || !savedRecoveryCodes)}
            >
              {t('auth.mfa.submit')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => void logout()}
            >
              {t('shell.signOut')}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
