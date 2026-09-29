/**
 * "Confirm it is you" - one dialog for every sensitive act.
 *
 * Registered with the API client (`setStepUpHandler`). When the server refuses
 * an act with STEP_UP_REQUIRED, this asks for the password (no two-step
 * sign-in) or a code (two-step sign-in on), confirms it, and the client sends
 * the original request again once. When the act needs a real second factor the
 * account does not have yet (AutoPay), it offers the setup instead, and
 * finishing setup counts as the confirmation.
 *
 * Requests can arrive while a dialog is already open - setting up the factor
 * itself needs a fresh confirmation - so the dialogs are a stack, each one a
 * native modal on top of the last, and each resolves only its own request.
 *
 * Cancelling resolves `false`: the original request then fails with its own
 * error, and the screen that made it says so in its own words.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Modal } from '@/components/Modal';
import { Button, Field, Input } from '@/components/ui';
import { MfaEnrolmentFlow } from '@/components/security/MfaEnrolmentFlow';
import { useI18n } from '@/i18n/i18n-context';
import { setStepUpHandler, type StepUpChallenge } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { securityApi } from '@/lib/security';
import { useSession } from './session-context';

interface Pending extends StepUpChallenge {
  id: number;
  resolve: (confirmed: boolean) => void;
}

export function StepUpProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [stack, setStack] = useState<Pending[]>([]);
  const nextId = useRef(1);

  useEffect(
    () =>
      setStepUpHandler(
        (challenge) =>
          new Promise<boolean>((resolve) => {
            const id = nextId.current;
            nextId.current += 1;
            setStack((current) => [...current, { ...challenge, id, resolve }]);
          }),
      ),
    [],
  );

  const settle = useCallback((id: number, confirmed: boolean): void => {
    setStack((current) => {
      const entry = current.find((item) => item.id === id);
      entry?.resolve(confirmed);
      return current.filter((item) => item.id !== id);
    });
  }, []);

  return (
    <>
      {children}
      {stack.map((entry) => (
        <StepUpDialog
          key={entry.id}
          challenge={entry}
          onDone={(confirmed) => {
            settle(entry.id, confirmed);
          }}
        />
      ))}
    </>
  );
}

export function StepUpDialog({
  challenge,
  onDone,
}: {
  challenge: StepUpChallenge;
  onDone: (confirmed: boolean) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { refreshUser } = useSession();
  const [secret, setSecret] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const secretInput = useRef<HTMLInputElement>(null);

  // The Modal opens the <dialog> in its own effect, which runs after this one
  // and moves focus itself, so the field is focused on the next frame.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      secretInput.current?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  const cancel = (): void => {
    onDone(false);
  };

  if (challenge.kind === 'SETUP_FACTOR') {
    return (
      <Modal isOpen onClose={cancel} title={t('security.stepUp.setupTitle')} description={t('security.stepUp.setupBody')} size="lg">
        <MfaEnrolmentFlow
          onEnrolled={() => {
            void refreshUser();
            onDone(true);
          }}
          onCancel={cancel}
        />
      </Modal>
    );
  }

  const byCode = challenge.method === 'TOTP';

  const confirm = async (): Promise<void> => {
    setProblem(null);
    if (secret.trim().length === 0) {
      setProblem(byCode ? t('security.mfa.codeRequired') : t('validation.passwordRequired'));
      return;
    }
    setBusy(true);
    try {
      await securityApi.stepUp(byCode ? { code: secret.trim() } : { password: secret });
      onDone(true);
    } catch (error) {
      setProblem(errorMessage(t, error, t('security.stepUp.failed')));
      setSecret('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={cancel}
      title={t('security.stepUp.title')}
      description={byCode ? t('security.stepUp.bodyCode') : t('security.stepUp.bodyPassword')}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={cancel} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            isLoading={busy}
            onClick={() => {
              void confirm();
            }}
          >
            {t('security.stepUp.confirm')}
          </Button>
        </div>
      }
    >
      <form
        noValidate
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void confirm();
        }}
      >
        {problem !== null && (
          <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger">
            {problem}
          </div>
        )}
        <Field label={byCode ? t('security.challenge.codeLabel') : t('common.password')} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              type={byCode ? 'text' : 'password'}
              inputMode={byCode ? 'numeric' : undefined}
              autoComplete={byCode ? 'one-time-code' : 'current-password'}
              ref={secretInput}
              value={secret}
              onChange={(event) => {
                setSecret(event.target.value);
              }}
            />
          )}
        </Field>
      </form>
    </Modal>
  );
}
