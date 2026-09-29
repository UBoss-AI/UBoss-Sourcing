/**
 * Setting up two-step sign-in: scan, save the recovery codes, type the first
 * code.
 *
 * Used in three places - Account -> Profile, the Seller Hub's setup screen for
 * the roles that must have it, and the confirmation dialog when an act (AutoPay)
 * needs a real second factor - so it is one component with no frame of its
 * own.
 *
 * THE QR CODE IS DRAWN HERE, never fetched: the `otpauth://` URI carries the
 * secret, and an image URL would hand it to whoever serves the image. The key
 * is printed beside it for anybody who cannot scan.
 *
 * ONE ENROLMENT PER MOUNT. `/auth/mfa/setup` mints a fresh secret each call,
 * so the enrolment is held in state for as long as this is on screen and the
 * screen says that leaving throws it away.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Field, Input, Spinner } from '@/components/ui';
import { QrCode } from '@/components/security/QrCode';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { securityApi, type MfaEnrolment } from '@/lib/security';

export function MfaEnrolmentFlow({
  onEnrolled,
  onCancel,
}: {
  onEnrolled: () => void;
  onCancel?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [enrolment, setEnrolment] = useState<MfaEnrolment | null>(null);
  const [starting, setStarting] = useState(true);
  const [saved, setSaved] = useState(false);
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    // StrictMode runs effects twice in development; two setup calls would mint
    // two secrets and the first QR code would already be dead.
    if (started.current) return;
    started.current = true;
    securityApi
      .setup()
      .then(setEnrolment)
      .catch((error: unknown) => {
        setProblem(errorMessage(t, error, t('security.mfa.setupFailed')));
      })
      .finally(() => {
        setStarting(false);
      });
  }, [t]);

  const confirm = async (): Promise<void> => {
    setProblem(null);
    if (!/^\d{6}$/.test(code.trim())) {
      setProblem(t('security.mfa.codeSixDigits'));
      return;
    }
    setBusy(true);
    try {
      await securityApi.confirm(code.trim());
      onEnrolled();
    } catch (error) {
      setProblem(errorMessage(t, error, t('security.mfa.verifyFailed')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {problem !== null && (
        <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {problem}
        </div>
      )}

      {starting && (
        <div className="flex items-center gap-2.5 text-sm text-ink-muted">
          <Spinner className="h-4 w-4 shrink-0 text-ink-subtle" />
          <span role="status">{t('security.mfa.preparing')}</span>
        </div>
      )}

      {enrolment !== null && (
        <>
          <section aria-labelledby="mfa-scan-heading">
            <h3 id="mfa-scan-heading" className="text-sm font-medium text-ink">
              {t('security.mfa.scanHeading')}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">{t('security.mfa.scanBody')}</p>
            <div className="mt-3 grid gap-4 sm:grid-cols-[auto,1fr] sm:items-start">
              {/* The white mount is part of the code: a scanner needs a light
                  quiet zone, and the page behind it may be dark. */}
              <div className="mx-auto rounded-xl border border-border bg-white p-3 sm:mx-0">
                <QrCode value={enrolment.uri} size={160} />
              </div>
              <div className="min-w-0">
                <p className="text-xs font-medium text-ink">{t('security.mfa.keyHeading')}</p>
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">{t('security.mfa.keyBody')}</p>
                <code
                  data-testid="mfa-secret"
                  className="mt-2 block select-all break-all rounded-md bg-surface-sunken px-3 py-2 font-mono text-sm tracking-wider text-ink"
                >
                  {enrolment.secret}
                </code>
                <p className="mt-3 text-xs leading-relaxed text-warning">{t('security.mfa.leaveWarning')}</p>
              </div>
            </div>
          </section>

          <section aria-labelledby="mfa-recovery-heading">
            <h3 id="mfa-recovery-heading" className="text-sm font-medium text-ink">
              {t('security.mfa.recoveryHeading')}
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">{t('security.mfa.recoveryBody')}</p>
            <RecoveryCodeList codes={enrolment.recoveryCodes} />
            <label className="mt-3 flex items-start gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded border-border text-brand focus:ring-brand"
                checked={saved}
                onChange={(event) => {
                  setSaved(event.target.checked);
                }}
              />
              <span>{t('security.mfa.recoverySaved')}</span>
            </label>
          </section>

          <Field label={t('security.mfa.firstCode')} hint={t('security.mfa.firstCodeHint')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                }}
              />
            )}
          </Field>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            {onCancel !== undefined && (
              <Button variant="ghost" onClick={onCancel} disabled={busy}>
                {t('common.cancel')}
              </Button>
            )}
            <Button
              variant="primary"
              isLoading={busy}
              disabled={!saved}
              onClick={() => {
                void confirm();
              }}
            >
              {t('security.mfa.turnOn')}
            </Button>
          </div>
        </>
      )}

      {enrolment === null && !starting && onCancel !== undefined && (
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Ten codes in two columns, selectable as one block for copying. */
export function RecoveryCodeList({ codes }: { codes: string[] }): React.JSX.Element {
  return (
    <div
      data-testid="mfa-recovery-codes"
      className="mt-2 grid select-all grid-cols-2 gap-1 rounded-md bg-surface-sunken p-3 font-mono text-xs tracking-wider text-ink"
    >
      {codes.map((recoveryCode) => (
        <span key={recoveryCode}>{recoveryCode}</span>
      ))}
    </div>
  );
}
