/**
 * "How bulk preorders work" - what the circular i beside Preorder opens, and
 * what a buyer must read before their first preorder.
 *
 * One component, two states, decided by the SERVER's record:
 *
 *   - Not yet acknowledged (at the current version): the note, a checkbox and
 *     "Agree and continue to preorder", which stays disabled until the box is
 *     ticked. "Not now" closes it and changes nothing.
 *   - Already acknowledged: the same note to read again, with "Continue to
 *     preorder" - no second tick asked for. A new version of the note
 *     (`PREORDER_INFO_VERSION`) puts the buyer back in the first state.
 *
 * The minimum it states is `eligibility.moq`, the same figure the form, the
 * bulk suggestion and the server's refusal use.
 *
 * On a desktop it is a popover beside the i; on a phone, a bottom sheet (see
 * `Modal`'s `anchored` placement). Both are a modal `<dialog>`, so focus stays
 * inside and Escape closes it. Opened by pressing the i, never by focusing it:
 * a dialog that opened on focus would trap every keyboard user tabbing past.
 */
import { useId, useState } from 'react';
import type { RefObject } from 'react';
import { Modal } from '@/components/Modal';
import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import type { Eligibility } from '@/lib/preorders';

type Available = Extract<Eligibility, { available: true }>;

export interface PreorderInfoDialogProps {
  anchorRef: RefObject<HTMLElement | null>;
  /** The terms, when the product is open for preorder. */
  terms: Available | null;
  /** Why it is not, when it is not - already in the buyer's language. */
  unavailableReason: string | null;
  /** Whether the server holds this buyer's acknowledgement of the current note. */
  acknowledged: boolean;
  /** Whether "continue" leads anywhere: the product is open and this buyer may ask. */
  canContinue: boolean;
  isGuest: boolean;
  isSaving: boolean;
  error: string | null;
  onContinue: () => void;
  onClose: () => void;
}

export function PreorderInfoDialog({
  anchorRef,
  terms,
  unavailableReason,
  acknowledged,
  canContinue,
  isGuest,
  isSaving,
  error,
  onContinue,
  onClose,
}: PreorderInfoDialogProps): React.JSX.Element {
  const { t } = useI18n();
  const [ticked, setTicked] = useState(false);
  const checkboxId = useId();

  const asksForAgreement = canContinue && !acknowledged;

  // Stacked, full width, at every size: the popover is narrow, and "Agree and
  // continue to preorder" beside "Not now" squeezed one of them onto two lines.
  const footer = (
    <div className="flex w-full flex-col-reverse gap-2">
      <Button variant="ghost" onClick={onClose} fullWidth>
        {canContinue ? t('preorderInfo.notNow') : t('common.close')}
      </Button>
      {canContinue && (
        <Button
          variant="action"
          disabled={asksForAgreement && !ticked}
          isLoading={isSaving}
          onClick={onContinue}
          fullWidth
        >
          {asksForAgreement ? t('preorderInfo.agree') : t('preorderInfo.continue')}
        </Button>
      )}
    </div>
  );

  return (
    <Modal
      isOpen
      onClose={onClose}
      placement="anchored"
      anchorRef={anchorRef}
      title={t('preorderInfo.title')}
      footer={footer}
    >
      <div className="space-y-3 text-sm leading-relaxed text-ink">
        <p>{t('preorderInfo.intro')}</p>

        {terms !== null ? (
          <div className="rounded-md border border-brand/25 bg-brand-soft px-3 py-2.5">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              {t('preorderInfo.moqLabel')}
            </p>
            <p className="mt-0.5 text-base font-semibold tabular-nums text-ink">
              <MoqAmount terms={terms} />
            </p>
          </div>
        ) : (
          <p className="rounded-md bg-surface-sunken px-3 py-2.5 text-ink-muted">
            {unavailableReason ?? t('preorder.chooseOptionFirst')}
          </p>
        )}

        <p>{t('preorderInfo.sellerConfirms')}</p>
        <p className="text-ink-muted">{t('preorderInfo.nothingCharged')}</p>

        {asksForAgreement && (
          <div className="space-y-1.5 border-t border-border-subtle pt-3">
            <label htmlFor={checkboxId} className="flex items-start gap-2.5 font-medium">
              <input
                id={checkboxId}
                type="checkbox"
                className="mt-0.5 size-4 shrink-0 rounded border-border"
                checked={ticked}
                onChange={(event) => {
                  setTicked(event.currentTarget.checked);
                }}
              />
              <span>{t('preorderInfo.acknowledge')}</span>
            </label>
            <p className="pl-[1.625rem] text-xs text-ink-muted">{t('preorderInfo.notTerms')}</p>
            {isGuest && <p className="pl-[1.625rem] text-xs text-ink-muted">{t('preorderInfo.guestNext')}</p>}
          </div>
        )}

        {canContinue && acknowledged && (
          <p className="text-xs text-ink-muted">{t('preorderInfo.alreadyRead')}</p>
        )}

        {error !== null && (
          <p
            role="alert"
            className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-danger"
          >
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/**
 * "1,000 pieces", or "10 UK pallets (12,000 pieces)" - the seller's minimum in
 * the unit they set it in, in the buyer's own number format.
 */
export function MoqAmount({ terms }: { terms: Available }): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const { moq } = terms;
  const amount = t(`preorderInfo.amount.${moq.unit}` as TranslationKey, {
    count: moq.quantity,
    quantity: moq.quantity.toLocaleString(intlLocale),
  });
  if (moq.unit === 'PIECE') return <>{amount}</>;
  return (
    <>
      {amount}{' '}
      <span className="text-sm font-normal text-ink-muted">
        {t('preorderInfo.inPieces', {
          count: moq.minimumBaseUnits,
          quantity: moq.minimumBaseUnits.toLocaleString(intlLocale),
        })}
      </span>
    </>
  );
}
