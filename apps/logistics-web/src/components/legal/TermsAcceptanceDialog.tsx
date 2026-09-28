/**
 * The Logistics Partner Terms, shown in full, with "I agree" at the bottom.
 *
 * The storefront's dialog (`apps/customer-web/src/components/legal/`) on this
 * portal's own `Modal`, which traps focus, hands it back to whatever opened
 * it, holds the page still behind it and closes on Escape.
 *
 *   - **Opening it, scrolling it and reaching the end accept nothing.** The
 *     end of the text only enables the button. `onAgree` is called by that
 *     button alone.
 *   - **Every other way out is Cancel.** Close, Cancel and Escape all call
 *     `onCancel`. Clicking the backdrop does nothing.
 *   - **The end is detected, not guessed.** See `useReadToEnd`.
 *
 * The portal has no public page of its own for the terms, so the copy to keep
 * is the PDF - built on the server from the same stored text.
 */
import { useId, useRef } from 'react';
import { Modal } from '@/components/Modal';
import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { languageOption } from '@/i18n/languages';
import { formatDate } from '@/lib/format';
import { legalDocumentPdfUrl, type CurrentLegalDocument } from '@/lib/legal';
import { LegalDocumentBody } from './LegalDocumentBody';
import { useReadToEnd } from './useReadToEnd';

function languageEndonym(code: string): string {
  const option = languageOption(code);
  return option.code === code ? option.endonym : code.toUpperCase();
}

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
          <p id={hintId} role="status" className="grow text-xs text-ink-muted max-sm:text-center">
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

      <div className="mt-6 border-t border-border-subtle pt-4 text-xs">
        <a
          href={legalDocumentPdfUrl(document.id)}
          download
          className="font-medium text-brand hover:underline"
        >
          {t('terms.downloadPdf')}
        </a>
      </div>
    </Modal>
  );
}
