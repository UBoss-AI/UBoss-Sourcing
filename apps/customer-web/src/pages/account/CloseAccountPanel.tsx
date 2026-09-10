/**
 * Closing the account.
 *
 * Two acts, and the panel's job is to stop somebody confusing them:
 *
 *   - **Deactivate** stops the account being used. Every session is signed
 *     out, nothing can sign in, and nothing is deleted. A member of staff can
 *     reopen it.
 *   - **Delete** means erasure under Art. 17, which is a *request* that has to
 *     be assessed against the obligations surviving it — an unpaid order, an
 *     open return, an invoice a tax authority requires be kept for years. It
 *     is raised from the Your data panel above, which already says what
 *     survives, already tracks the one-month clock, and already handles a
 *     refusal with a reason. This panel points at it rather than growing a
 *     second erasure control, because two ways to ask for the same
 *     irreversible thing is one too many.
 *
 * What deactivation actually does is read from the server before it is
 * offered, and the warning names the customer's own arrangements: "this will
 * pause 2 scheduled orders" is a sentence somebody can act on, where
 * "scheduled orders may be affected" is one they scroll past. The unpaid-order
 * count is stated for the opposite reason — closing the account does not
 * cancel what is owed, and a customer must not be able to believe it did.
 *
 * The password is required, and the dialog asks for it rather than the page:
 * this is one click from a sidebar, and on a shared purchasing machine the
 * person at the keyboard is not reliably the account holder.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Button, Field, Input, Spinner } from '@/components/ui';
import { AlertIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/i18n/i18n-context';
import type { AccountResponse, ClosureImpact } from '@/lib/types';
import { AccountPanel } from './AccountPanel';

export function CloseAccountPanel({
  account,
}: {
  account: AccountResponse;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const { isCustomer, logout } = useSession();

  const [isConfirming, setIsConfirming] = useState(false);
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  /*
   * What closing would do.
   *
   * Only asked for when the dialog is open. It is a read of the customer's own
   * schedules, mandate and open orders, and there is no reason to spend it on
   * everybody who scrolls to the bottom of their profile.
   */
  const impact = useQuery({
    queryKey: ['account-closure'],
    queryFn: () => api.get<{ closure: ClosureImpact }>('/account/closure'),
    enabled: isCustomer && isConfirming,
    staleTime: 30_000,
  });

  const deactivate = useMutation({
    mutationFn: () => api.post('/account/deactivate', { password }),
    onSuccess: async () => {
      setIsConfirming(false);
      setPassword('');
      toast.success(t('closeAccount.closed'));

      /*
       * Sign out locally as well.
       *
       * The server has already revoked every session, so the cookie in this
       * browser is a key to nothing — but the app does not know that until its
       * next request fails, and a page that carries on rendering an account
       * area for a closed account is worse than a sign-in screen.
       */
      await logout();
    },
    onError: (error) => {
      setFormError(errorMessage(t, error, t('closeAccount.couldNotClose')));
    },
  });

  const closure = impact.data?.closure ?? null;

  return (
    <AccountPanel
      title={t('closeAccount.heading')}
      description={t('closeAccount.description')}
    >
      <div className="space-y-4">
        {/* --- Deactivate ------------------------------------------------- */}
        <div className="rounded-md border border-border bg-surface-sunken p-4">
          <p className="text-title-xs text-ink">{t('closeAccount.deactivateTitle')}</p>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-muted">
            {t('closeAccount.deactivateBody')}
          </p>

          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => {
              setFormError(null);
              setIsConfirming(true);
            }}
          >
            {t('closeAccount.deactivateAction')}
          </Button>
        </div>

        {/* --- Delete ----------------------------------------------------- */}
        <div className="rounded-md border border-danger/25 bg-danger-soft/40 p-4">
          <p className="text-title-xs text-danger">{t('closeAccount.deleteTitle')}</p>
          <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-muted">
            {t('closeAccount.deleteBody')}
          </p>
          {/* No control. The one that raises an erasure request is in the Your
              data panel above, and pointing at it is deliberate — see the
              header of this file. */}
          <p className="mt-2 text-sm font-medium text-ink">{t('closeAccount.deleteWhere')}</p>
        </div>
      </div>

      {isConfirming && (
        <Modal
          isOpen
          onClose={() => {
            setIsConfirming(false);
            setPassword('');
            setFormError(null);
          }}
          title={t('closeAccount.confirmTitle')}
          description={t('closeAccount.confirmDescription')}
          footer={
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="secondary"
                disabled={deactivate.isPending}
                onClick={() => {
                  setIsConfirming(false);
                  setPassword('');
                  setFormError(null);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={password.length === 0}
                isLoading={deactivate.isPending}
                onClick={() => {
                  deactivate.mutate();
                }}
              >
                {t('closeAccount.deactivateAction')}
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            {formError !== null && (
              <div
                role="alert"
                className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
              >
                {formError}
              </div>
            )}

            {/* What is about to happen to this particular account. */}
            {impact.isPending ? (
              <p className="flex items-center gap-2 text-sm text-ink-muted">
                <Spinner className="h-4 w-4" />
                {t('closeAccount.checkingWhatThisAffects')}
              </p>
            ) : closure === null ? (
              // The read failed. The close is still offered, because the
              // server does the right thing regardless — what is lost is the
              // detail in the warning, and saying so is better than blocking.
              <p className="text-sm text-ink-muted">{t('closeAccount.impactUnavailable')}</p>
            ) : (
              <ul className="space-y-2">
                {closure.activeScheduleCount > 0 && (
                  <li className="flex items-start gap-2.5 text-sm text-ink">
                    <AlertIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                    {t('closeAccount.willPauseSchedules', { count: closure.activeScheduleCount })}
                  </li>
                )}

                {closure.hasAutoPay && (
                  <li className="flex items-start gap-2.5 text-sm text-ink">
                    <AlertIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                    {t('closeAccount.willWithdrawAutoPay')}
                  </li>
                )}

                {closure.unpaidOrderCount > 0 && (
                  <li className="flex items-start gap-2.5 text-sm text-ink">
                    <AlertIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                    {t('closeAccount.unpaidOrdersRemain', { count: closure.unpaidOrderCount })}
                  </li>
                )}

                <li className="flex items-start gap-2.5 text-sm text-ink-muted">
                  <AlertIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-ink-subtle" />
                  {t('closeAccount.historyIsKept')}
                </li>
              </ul>
            )}

            <Field label={t('closeAccount.confirmWithPassword')} required>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => {
                    setPassword(event.target.value);
                  }}
                />
              )}
            </Field>

            <p className="text-xs leading-relaxed text-ink-muted">
              {t('closeAccount.reopenBySupport', { email: account.profile.email })}
            </p>
          </div>
        </Modal>
      )}
    </AccountPanel>
  );
}
