/**
 * The second half of signing in: the six-digit code, or a recovery code.
 *
 * One box for both, because the server accepts either in the same field and
 * answers a wrong one of either kind with the same message - so this screen
 * cannot tell anybody which kind they guessed at, and does not try.
 */
import { useEffect, useRef, useState } from 'react';
import { Button, Field, Input } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { securityApi } from '@/lib/security';

export function MfaChallengeForm({
  onVerified,
  onCancel,
}: {
  onVerified: (result: { usedRecoveryCode: boolean; recoveryCodesRemaining: number }) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const submit = async (): Promise<void> => {
    setProblem(null);
    const value = code.trim();
    if (value.length < 6) {
      setProblem(t('security.mfa.codeRequired'));
      return;
    }
    setBusy(true);
    try {
      const result = await securityApi.challenge(value);
      onVerified(result);
    } catch (error) {
      setProblem(errorMessage(t, error, t('security.mfa.verifyFailed')));
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm text-ink-muted">{t('security.challenge.body')}</p>
      {problem !== null && (
        <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">
          {problem}
        </div>
      )}
      <Field label={t('security.challenge.codeLabel')} hint={t('security.challenge.recoveryHint')} required>
        {({ inputId, describedBy }) => (
          <Input
            ref={input}
            id={inputId}
            aria-describedby={describedBy}
            autoComplete="one-time-code"
            maxLength={16}
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
            }}
          />
        )}
      </Field>
      <div className="flex flex-col gap-2">
        <Button type="submit" variant="primary" fullWidth isLoading={busy}>
          {t('security.challenge.submit')}
        </Button>
        <Button type="button" variant="ghost" fullWidth onClick={onCancel} disabled={busy}>
          {t('security.challenge.cancel')}
        </Button>
      </div>
    </form>
  );
}
