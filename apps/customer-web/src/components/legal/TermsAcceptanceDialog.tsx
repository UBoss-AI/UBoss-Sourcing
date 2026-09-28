/**
 * The Terms and Conditions, shown in full, with "I agree" at the bottom.
 *
 * Built from the approved dialog design - title bar, one scrolling body, a
 * footer that stays in view with "Read all terms before accepting", Cancel and
 * I agree - on the app's own `Modal`, which already traps focus, hands it back
 * to whatever opened it, holds the page still behind it and closes on Escape.
 *
 * What this component will and will not do:
 *
 *   - **Opening it, scrolling it and reaching the end accept nothing.** The
 *     end of the text only enables the button. `onAgree` - the one way out of
 *     this dialog that changes anything - is called by that button alone.
 *   - **Every other way out is Cancel.** The Close button, Cancel and Escape
 *     all call `onCancel`. Clicking the backdrop does nothing, as in every
 *     dialog in this app.
 *   - **The end is detected, not guessed.** See `useReadToEnd`: text that
 *     fits enables the button at once, and keyboard and screen-reader
 *     scrolling count the same as a mouse wheel.
 */
import { useId, useRef } from 'react';
import { Modal } from '@/components/Modal';
import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { formatDate } from '@/lib/format';
import { languageEndonym, legalDocumentPath, legalDocumentPdfUrl, type CurrentLegalDocument } from '@/lib/legal';
import { LegalDocumentBody } from './LegalDocumentBody';
import { useReadToEnd } from './useReadToEnd';

export function TermsAcceptanceDialog({
  isOpen,
  current,
  onCancel,
  onAgree,
}: {
  isOpen: boolean;
  current: CurrentLegalDocument;
  onCancel: () => void;
  onAgree: (documentId: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const bodyRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const { document } = current;
  const hasReadToEnd = useReadToEnd(bodyRef, isOpen, document.id);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={document.title}
      description={t('terms.dialog.description')}
      bodyRef={bodyRef}
      bodyLabel={t('terms.dialog.textRegion', { title: document.title })}
      footer={
        <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center">
          {/* Said while the button is disabled, and tied to it, so the reason
              is announced with the button rather than left for the reader to
              guess. Replaced by a status message once the end is reached. */}
          <p
            id={hintId}
            role="status"
            className="grow text-xs text-ink-muted max-sm:text-center"
          >
            {hasReadToEnd ? t('terms.dialog.readyToAgree') : t('terms.dialog.readToEnd')}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={onCancel}>
              {t('modal.cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={!hasReadToEnd}
              aria-describedby={hintId}
              onClick={() => {
                onAgree(document.id);
              }}
            >
              {t('terms.dialog.agree')}
            </Button>
          </div>
        </div>
      }
    >
      <dl className="mb-4 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-muted">
        <div className="flex gap-1">
          <dt>{t('terms.meta.version')}</dt>
          <dd className="font-medium text-ink">{document.version}</dd>
        </div>
        <div className="flex gap-1">
          <dt>{t('terms.meta.effective')}</dt>
          <dd className="font-medium text-ink">{formatDate(document.effectiveAt)}</dd>
        </div>
        <div className="flex gap-1">
          <dt>{t('terms.meta.language')}</dt>
          <dd className="font-medium text-ink">{languageEndonym(document.locale)}</dd>
        </div>
      </dl>

      {current.isFallback && (
        <p className="mb-4 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-ink">
          {t('terms.fallbackNotice', { language: languageEndonym(document.locale) })}
        </p>
      )}

      {document.changeSummary !== null && document.changeSummary.length > 0 && (
        <div className="mb-4 rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs text-ink">
          <p className="font-semibold">{t('terms.changeSummary')}</p>
          <p className="mt-1 whitespace-pre-line text-ink-muted">{document.changeSummary}</p>
        </div>
      )}

      <LegalDocumentBody body={document.body} />

      <div className="mt-6 flex flex-wrap gap-x-4 gap-y-2 border-t border-border-subtle pt-4 text-xs">
        <a
          href={legalDocumentPath(document.id)}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-brand hover:underline"
        >
          {t('terms.openFull')}
        </a>
        <a href={legalDocumentPdfUrl(document.id)} download className="font-medium text-brand hover:underline">
          {t('terms.downloadPdf')}
        </a>
      </div>
    </Modal>
  );
}
