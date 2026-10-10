/**
 * One policy, shown in full, with its one button at the bottom: "I agree" for
 * the Terms & Conditions and the Seller Platform Services Agreement, "I
 * acknowledge" for the Privacy Policy.
 *
 * Built on the app's own `Modal`, which keeps the title bar and the footer in
 * view while only the text scrolls, traps focus, hands it back to whatever
 * opened it, holds the page still behind it and closes on Escape.
 *
 * What it will and will not do:
 *
 *   - **Reaching the end only enables the button.** `onConfirm` - the one way
 *     out that changes anything - is called by that button alone. Opening,
 *     scrolling and reaching the end record nothing and tick nothing.
 *   - **Every other way out is Cancel.** Close, Cancel and Escape all call
 *     `onClose`. Clicking the backdrop does nothing.
 *   - **Text that has not loaded cannot be accepted.** While loading, and after
 *     a failure, the button stays disabled whatever the scroll position.
 *   - **A new document starts over.** Another version or language resets the
 *     end-of-text check, so agreement to one text is never carried to another.
 *   - **A document already recorded can be read again**, with no button: the
 *     dialog then only says when it was recorded.
 */
import { useId, useRef } from 'react';
import { Modal } from '@/components/Modal';
import { Button, Spinner } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { formatAgreementDate, languageName } from './format';
import { LegalText } from './legal-text';
import type { RoleTextPrefix } from './role-text';
import type { AgreementRole, CurrentAgreementDocument } from './types';
import { useReadToEnd } from './useReadToEnd';

export interface PolicyDocumentDialogProps {
  isOpen: boolean;
  role: AgreementRole;
  /** In reading order. Empty while loading. */
  documents: CurrentAgreementDocument[];
  state: 'loading' | 'ready' | 'error';
  /** When the documents shown were already recorded; the dialog is then read-only. */
  recordedAt: string | null;
  isSaving: boolean;
  /** A sentence to show above the text: a failed save, or a new version. */
  notice: string | null;
  onRetry: () => void;
  onClose: () => void;
  onConfirm: (documentIds: string[]) => void;
  pdfUrl: (documentId: string) => string;
  pageUrl: (documentId: string) => string | null;
  /** The box's own words; by default the role's. */
  textPrefix?: RoleTextPrefix | undefined;
  /**
   * Set when this person may read the document but not accept it - the company
   * services agreement for a member who cannot bind the company. The sentence
   * replaces the end-of-text hint and there is no agree button.
   */
  reviewOnlyReason?: string | null;
}

export function PolicyDocumentDialog({
  isOpen,
  role,
  documents,
  state,
  recordedAt,
  isSaving,
  notice,
  onRetry,
  onClose,
  onConfirm,
  pdfUrl,
  pageUrl,
  textPrefix,
  reviewOnlyReason = null,
}: PolicyDocumentDialogProps): React.JSX.Element {
  const { t, language } = useI18n();
  const bodyRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const isReady = state === 'ready' && documents.length > 0;
  const readOnly = recordedAt !== null || reviewOnlyReason !== null;
  const prefix: RoleTextPrefix =
    textPrefix ?? (role === 'TERMS' ? 'agreements.terms' : role === 'SERVICES' ? 'agreements.services' : 'agreements.privacy');
  const resetKey = documents.map((entry) => entry.document.id).join('|');
  const hasReachedEnd = useReadToEnd(bodyRef, isOpen && isReady, resetKey);

  const fallbackTitle = t(`${prefix}.title`);
  const title = documents.length === 1 ? (documents[0]?.document.title ?? fallbackTitle) : fallbackTitle;
  const confirmLabel = role === 'PRIVACY' ? t('agreements.dialog.acknowledge') : t('agreements.dialog.agree');
  const description =
    prefix === 'agreements.companyTerms' ||
    prefix === 'agreements.companyServices' ||
    prefix === 'agreements.consumerTerms' ||
    prefix === 'agreements.consumerServices'
      ? t(`${prefix}.dialogDescription`)
      : role === 'TERMS'
      ? t('agreements.dialog.termsDescription')
      : role === 'SERVICES'
        ? t('agreements.dialog.servicesDescription')
        : t('agreements.dialog.privacyDescription');

  const hint = reviewOnlyReason !== null
    ? reviewOnlyReason
    : recordedAt !== null
    ? t('agreements.dialog.recordedOn', { date: formatAgreementDate(recordedAt, language) })
    : !isReady
      ? state === 'error'
        ? t('agreements.dialog.loadFailed')
        : t('agreements.dialog.loading')
      : hasReachedEnd
        ? t('agreements.dialog.reachedEnd')
        : t('agreements.dialog.instruction');

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      description={description}
      size="lg"
      bodyRef={bodyRef}
      bodyLabel={t('agreements.dialog.textRegion', { title })}
      footer={
        <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center">
          {/* Tied to the button, so the reason it is disabled is announced
              with it rather than left for the reader to guess. */}
          <p id={hintId} role="status" className="grow text-xs text-ink-muted max-sm:text-center">
            {hint}
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={onClose}>
              {readOnly ? t('agreements.dialog.close') : t('agreements.dialog.cancel')}
            </Button>
            {!readOnly && (
              <Button
                type="button"
                variant="primary"
                disabled={!isReady || !hasReachedEnd}
                isLoading={isSaving}
                aria-describedby={hintId}
                onClick={() => {
                  onConfirm(documents.map((entry) => entry.document.id));
                }}
              >
                {isSaving ? t('agreements.saving') : confirmLabel}
              </Button>
            )}
          </div>
        </div>
      }
    >
      {notice !== null && (
        <p role="alert" className="mb-4 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-ink">
          {notice}
        </p>
      )}

      {!isReady && state === 'loading' && (
        <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-ink-muted">
          <Spinner className="h-5 w-5" />
          <span>{t('agreements.dialog.loading')}</span>
        </div>
      )}

      {!isReady && state === 'error' && (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center text-sm text-ink">
          <p>{t('agreements.dialog.loadFailed')}</p>
          <Button type="button" size="sm" onClick={onRetry}>
            {t('agreements.retry')}
          </Button>
        </div>
      )}

      {isReady &&
        documents.map((entry, index) => {
          const { document } = entry;
          const page = pageUrl(document.id);
          return (
            <section
              key={document.id}
              aria-label={document.title}
              className={index > 0 ? 'mt-10 border-t-2 border-border pt-8' : undefined}
            >
              {documents.length > 1 && (
                <>
                  <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
                    {t('agreements.dialog.part', { index: String(index + 1), total: String(documents.length) })}
                  </p>
                  <h3 className="mt-1 text-title-sm text-ink">{document.title}</h3>
                </>
              )}

              <dl className="mb-4 mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-muted">
                <div className="flex gap-1">
                  <dt>{t('agreements.meta.version')}</dt>
                  <dd className="font-medium text-ink">{document.version}</dd>
                </div>
                <div className="flex gap-1">
                  <dt>{t('agreements.meta.effective')}</dt>
                  <dd className="font-medium text-ink">{formatAgreementDate(document.effectiveAt, language)}</dd>
                </div>
                <div className="flex gap-1">
                  <dt>{t('agreements.meta.language')}</dt>
                  <dd className="font-medium text-ink">{languageName(document.locale, language)}</dd>
                </div>
              </dl>

              {entry.isFallback && (
                <p className="mb-4 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-ink">
                  {t('agreements.fallbackNotice', { language: languageName(document.locale, language) })}
                </p>
              )}

              {document.changeSummary !== null && document.changeSummary.length > 0 && (
                <div className="mb-4 rounded-md border border-border bg-surface-sunken px-3 py-2 text-xs text-ink">
                  <p className="font-semibold">{t('agreements.changeSummary')}</p>
                  <p className="mt-1 whitespace-pre-line text-ink-muted">{document.changeSummary}</p>
                </div>
              )}

              <LegalText body={document.body} headingLevel={documents.length > 1 ? 4 : 3} />

              <div className="mt-6 flex flex-wrap gap-x-4 gap-y-2 border-t border-border-subtle pt-4 text-xs">
                {page !== null && (
                  <a href={page} target="_blank" rel="noopener noreferrer" className="font-medium text-brand hover:underline">
                    {t('agreements.openFull')}
                  </a>
                )}
                <a href={pdfUrl(document.id)} download className="font-medium text-brand hover:underline">
                  {t('agreements.downloadPdf')}
                </a>
              </div>
            </section>
          );
        })}
    </Modal>
  );
}
