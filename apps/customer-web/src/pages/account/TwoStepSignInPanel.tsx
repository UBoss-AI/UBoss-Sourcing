/**
 * Two-step sign-in on the profile page (checklist Master row 10).
 *
 * The API always let a buyer turn two-step sign-in on, replace their recovery
 * codes and turn it off, but the only way into the setup was being made to
 * by a sensitive action (AutoPay). This panel lets somebody choose it for
 * themselves:
 *
 *   - **Off**: "Turn on" runs the same enrolment flow the step-up dialog uses.
 *   - **On**: how many recovery codes are left; "Replace recovery codes"
 *     shows ten new ones exactly once; "Turn off" - refused, with the reason,
 *     while a seller role requires it.
 *
 * Both changes need a fresh confirmation, which the API asks for and the
 * shared step-up dialog (`auth/StepUpProvider.tsx`) collects; the recovery
 * codes and the secret are never cached (`lib/security.ts`).
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Button } from '@/components/ui';
import { MfaEnrolmentFlow } from '@/components/security/MfaEnrolmentFlow';
import { useSession } from '@/auth/session-context';
import { errorMessage } from '@/lib/errors';
import { securityApi, securityKeys } from '@/lib/security';
import { useI18n } from '@/i18n/i18n-context';
import { AccountPanel } from './AccountPanel';

export function TwoStepSignInPanel(): React.JSX.Element | null {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { refreshUser } = useSession();
  const [enrolling, setEnrolling] = useState(false);
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const state = useQuery({ queryKey: securityKeys.mfa, queryFn: securityApi.state, retry: false });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: securityKeys.mfa });
    await refreshUser();
  };

  const replace = useMutation({
    mutationFn: securityApi.regenerateRecoveryCodes,
    onSuccess: async (codes) => {
      setProblem(null);
      setNewCodes(codes);
      await queryClient.invalidateQueries({ queryKey: securityKeys.mfa });
    },
    onError: (error) => {
      setProblem(errorMessage(t, error, t('security.panel.failed')));
    },
  });

  const disable = useMutation({
    mutationFn: securityApi.disable,
    onSuccess: async () => {
      setProblem(null);
      setNewCodes(null);
      toast.success(t('security.panel.turnedOff'));
      await refresh();
    },
    onError: (error) => {
      setProblem(errorMessage(t, error, t('security.panel.failed')));
    },
  });

  // Nothing to offer on a deployment without two-step sign-in, and nothing
  // worth an error box if the state cannot be read: sign-in still works.
  if (state.isError || (state.isSuccess && !state.data.available)) return null;

  const mfa = state.data;

  return (
    <AccountPanel title={t('security.panel.title')} description={t('security.panel.description')}>
      {mfa === undefined ? (
        <p className="text-sm text-ink-muted">{t('security.mfa.preparing')}</p>
      ) : mfa.enabled ? (
        <div className="space-y-3 text-sm">
          <p className="font-medium text-success">{t('security.panel.on')}</p>
          <p className="text-ink-muted">
            {t('security.panel.codesLeft', { count: mfa.recoveryCodesRemaining, codes: mfa.recoveryCodesRemaining })}
          </p>

          {newCodes !== null && (
            <div className="rounded-md border border-warning/30 bg-warning-soft p-3">
              <p className="font-medium text-ink">{t('security.mfa.recoveryHeading')}</p>
              <p className="mt-1 text-ink-muted">{t('security.mfa.recoveryBody')}</p>
              <ul className="mt-2 grid grid-cols-2 gap-1 font-mono text-ink sm:grid-cols-5">
                {newCodes.map((code) => (
                  <li key={code}>{code}</li>
                ))}
              </ul>
            </div>
          )}

          {mfa.required && (
            <p className="text-ink-muted">
              {mfa.requiredReason === 'SELLER_FINANCE' ? t('security.panel.requiredFinance') : t('security.panel.requiredOwner')}
            </p>
          )}

          {problem !== null && (
            <p role="alert" className="text-danger">
              {problem}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              disabled={replace.isPending}
              onClick={() => {
                replace.mutate();
              }}
            >
              {t('security.panel.replaceCodes')}
            </Button>
            {!mfa.required && (
              <Button
                variant="ghost"
                disabled={disable.isPending}
                onClick={() => {
                  disable.mutate();
                }}
              >
                {t('security.panel.turnOff')}
              </Button>
            )}
          </div>
        </div>
      ) : enrolling ? (
        <MfaEnrolmentFlow
          onEnrolled={() => {
            setEnrolling(false);
            toast.success(t('security.panel.turnedOn'));
            void refresh();
          }}
          onCancel={() => {
            setEnrolling(false);
          }}
        />
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-ink">{t('security.panel.off')}</p>
          <Button
            variant="primary"
            onClick={() => {
              setEnrolling(true);
            }}
          >
            {t('security.mfa.turnOn')}
          </Button>
        </div>
      )}
    </AccountPanel>
  );
}
