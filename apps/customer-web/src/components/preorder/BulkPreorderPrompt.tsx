/**
 * "Ordering in bulk?" - shown once when the quantity on the product page
 * reaches the product's preorder minimum from below it.
 *
 * It suggests; it does not steer. It states the quantity chosen and the
 * minimum, and offers Preorder beside the ordinary way to buy - which is only
 * offered where the product's own ordering rules take this quantity in a
 * normal basket (the server enforces the same rules on the cart). Where they
 * do not, it says so, rather than showing a button that would then fail.
 *
 * No saving, stock or delivery date is promised here: the seller has not
 * answered anything yet.
 */
import { Modal } from '@/components/Modal';
import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { Eligibility } from '@/lib/preorders';
import { MoqAmount } from './PreorderInfoDialog';

type Available = Extract<Eligibility, { available: true }>;

export interface BulkPreorderPromptProps {
  terms: Available;
  /** The pieces chosen on the product page. */
  pieces: number;
  /**
   * True where Add to Cart takes this quantity, false where it does not, null
   * where it is not this dialog's question (a guest, who has to sign in to
   * buy either way).
   */
  regularOrderAllowed: boolean | null;
  onStartPreorder: () => void;
  onContinueRegular: () => void;
  onClose: () => void;
}

export function BulkPreorderPrompt({
  terms,
  pieces,
  regularOrderAllowed,
  onStartPreorder,
  onContinueRegular,
  onClose,
}: BulkPreorderPromptProps): React.JSX.Element {
  const { t, intlLocale } = useI18n();

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={t('bulkPrompt.title')}
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          {regularOrderAllowed === true && (
            <Button variant="ghost" onClick={onContinueRegular} className="w-full sm:w-auto">
              {t('bulkPrompt.continueRegular')}
            </Button>
          )}
          <Button variant="action" onClick={onStartPreorder} className="w-full sm:w-auto">
            {t('bulkPrompt.start')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 text-sm leading-relaxed text-ink">
        <p>
          {t('bulkPrompt.selected', {
            count: pieces,
            quantity: pieces.toLocaleString(intlLocale),
          })}
        </p>
        <div className="rounded-md border border-brand/25 bg-brand-soft px-3 py-2.5">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
            {t('preorderInfo.moqLabel')}
          </p>
          <p className="mt-0.5 text-base font-semibold tabular-nums text-ink">
            <MoqAmount terms={terms} />
          </p>
        </div>
        <p>{t('bulkPrompt.explain')}</p>
        {regularOrderAllowed === false && (
          <p className="rounded-md bg-surface-sunken px-3 py-2 text-ink-muted">
            {t('bulkPrompt.regularNotAvailable')}
          </p>
        )}
      </div>
    </Modal>
  );
}
