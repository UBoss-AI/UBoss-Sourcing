/**
 * "Individual buyers can order up to N units of this product."
 *
 * Opened when a buyer who is held to the B2C maximum order quantity asks for
 * more - by typing, by the stepper, or because the server refused an add
 * that would take the basket over. It says what the limit is and offers the
 * next step that actually fits who is asking:
 *
 *   - a guest: sign in as a company, or register one;
 *   - somebody who already has an approved company: switch to it;
 *   - somebody whose company is still being checked: its verification status;
 *   - somebody with no company: register one;
 *   - somebody buying for a company that is not approved: that company's
 *     status, because switching would not help.
 *
 * Plus "Reduce to N" and Cancel for everybody. Nothing here changes the
 * account or starts a registration without the buyer pressing the button
 * that says so, and nothing trims the quantity unless they press "Reduce".
 *
 * A modal <dialog>: focus moves into it when it opens and goes back to
 * whatever opened it when it closes - the quantity box, the stepper or the
 * Add button - which the native element does for us. The message is the
 * dialog's description, so a screen reader reads it on opening.
 */
import { useId, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { useSession } from '@/auth/session-context';
import { Modal } from '@/components/Modal';
import { Button, ButtonLink } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { b2cAudience } from '@/lib/b2c-limit';
import { errorMessage } from '@/lib/errors';
import { formatNumber } from '@/lib/format';
import { useToast } from '@/components/toast-context';

export interface B2cLimitDialogProps {
  isOpen: boolean;
  /** The limit, in pieces. */
  limit: number;
  /** What the basket already holds of this product, where the server said. */
  alreadyInBasket?: number;
  /**
   * What "Reduce to" sets the quantity to, in the units the box counts. Null
   * hides the button - the basket already holds the whole limit, so there is
   * nothing smaller to add.
   */
  reduceTo: number | null;
  onReduce: () => void;
  /** Cancel, Escape, the backdrop: the change is dropped. */
  onClose: () => void;
  /**
   * Where it was opened. From the basket, "Reduce" changes a line that is
   * already there, and switching to a company opens that company's own
   * basket - which the dialog says, so nobody expects the lines to follow.
   */
  context?: 'product' | 'cart';
}

export function B2cLimitDialog({
  isOpen,
  limit,
  alreadyInBasket = 0,
  reduceTo,
  onReduce,
  onClose,
  context = 'product',
}: B2cLimitDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const location = useLocation();
  const { isCustomer, buyerContext, companies, switchBuyerContext } = useSession();
  const [switching, setSwitching] = useState<string | null>(null);
  const messageId = useId();

  const audience = b2cAudience({ isCustomer, buyerContext, companies });
  const limitText = formatNumber(limit);
  const here = `${location.pathname}${location.search}`;

  const switchTo = async (companyId: string, companyName: string): Promise<void> => {
    setSwitching(companyId);
    try {
      // Only on this press. The session changes on the server, and every
      // basket and price the page shows is read again in the new context.
      await switchBuyerContext({ kind: 'COMPANY', companyId });
      toast.success(t('b2cLimit.switched', { company: companyName }));
      onClose();
    } catch (error) {
      toast.error(errorMessage(t, error, t('b2cLimit.couldNotSwitch')));
    } finally {
      setSwitching(null);
    }
  };

  const message =
    audience.kind === 'GUEST'
      ? t('b2cLimit.guestMessage', { limit: limitText })
      : audience.kind === 'COMPANY_NOT_APPROVED'
        ? t('b2cLimit.companyNotApprovedMessage', {
            limit: limitText,
            company: audience.company.companyName,
          })
        : t('b2cLimit.individualMessage', { limit: limitText });

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('b2cLimit.title')}
      // In the body rather than `description`, which is clamped on a short
      // screen: this sentence is the whole point of the dialog.
      describedBy={messageId}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          <Button variant="ghost" onClick={onClose} className="w-full sm:w-auto">
            {t('b2cLimit.cancel')}
          </Button>

          {reduceTo !== null && reduceTo > 0 && (
            <Button
              variant="secondary"
              onClick={onReduce}
              className="w-full sm:w-auto"
              aria-label={t('b2cLimit.reduceToLabel', { limit: formatNumber(reduceTo) })}
            >
              {t('b2cLimit.reduceTo', { limit: formatNumber(reduceTo) })}
            </Button>
          )}

          {audience.kind === 'GUEST' && (
            <>
              <ButtonLink to="/register/company" variant="secondary" className="w-full sm:w-auto">
                {t('b2cLimit.createCompanyAccount')}
              </ButtonLink>
              <ButtonLink
                to="/login?buyerType=company"
                state={{ from: here }}
                variant="action"
                className="w-full sm:w-auto"
              >
                {t('b2cLimit.signInAsCompany')}
              </ButtonLink>
            </>
          )}

          {audience.kind === 'NO_COMPANY' && (
            <ButtonLink to="/register/company" variant="action" className="w-full sm:w-auto">
              {t('b2cLimit.createCompanyAccount')}
            </ButtonLink>
          )}

          {(audience.kind === 'HAS_PENDING' || audience.kind === 'COMPANY_NOT_APPROVED') && (
            <ButtonLink
              to={`/account/companies/${audience.company.companyId}`}
              variant="action"
              className="w-full sm:w-auto"
              aria-label={t('b2cLimit.viewVerificationStatusOf', { company: audience.company.companyName })}
            >
              {t('b2cLimit.viewVerificationStatus')}
            </ButtonLink>
          )}

          {audience.kind === 'HAS_APPROVED' &&
            audience.companies.map((company) => (
              <Button
                key={company.companyId}
                variant="action"
                className="w-full sm:w-auto"
                isLoading={switching === company.companyId}
                disabled={switching !== null}
                aria-label={t('b2cLimit.switchToNamedCompany', { company: company.companyName })}
                onClick={() => {
                  void switchTo(company.companyId, company.companyName);
                }}
              >
                {audience.companies.length === 1
                  ? t('b2cLimit.switchToCompany')
                  : t('b2cLimit.switchToNamedCompany', { company: company.companyName })}
              </Button>
            ))}
        </div>
      }
    >
      <div className="space-y-3 text-sm leading-relaxed text-ink">
        <p id={messageId} className="font-medium">
          {message}
        </p>
        {alreadyInBasket > 0 && (
          <p className="rounded-md bg-surface-sunken px-3 py-2 tabular text-ink-muted">
            {t('b2cLimit.alreadyInBasket', { quantity: formatNumber(alreadyInBasket) })}
          </p>
        )}
        {context === 'cart' && audience.kind === 'HAS_APPROVED' && (
          <p className="text-ink-muted">{t('b2cLimit.companyBasketNote')}</p>
        )}
        {audience.kind === 'HAS_PENDING' && (
          <p className="text-ink-muted">
            {t('b2cLimit.pendingCompany', { company: audience.company.companyName })}
          </p>
        )}
        <p className="text-ink-muted">{t('b2cLimit.notStock')}</p>
      </div>
    </Modal>
  );
}
