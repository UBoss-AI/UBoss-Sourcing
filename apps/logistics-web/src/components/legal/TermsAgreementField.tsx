/**
 * "I have read and agree to the Terms and Conditions", as a form field.
 *
 * The storefront's field (`apps/customer-web/src/components/legal/`), for the
 * activation page. The value is the id of the document agreed to, or null,
 * and only two things change it: I agree in the dialog sets it, unticking
 * clears it. Ticking an empty box - by click, Space, Enter, or the words in
 * the sentence - opens the terms and leaves the box empty. A different
 * document arriving (a new version, another language) clears an agreement to
 * the old one.
 *
 * The tick is the person's choice on this form, not a record. The server
 * records the agreement when the account is activated.
 */
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { ApiError, NetworkError } from '@/lib/api';
import type { CurrentTerms } from './useCurrentTerms';
import { TermsAcceptanceDialog } from './TermsAcceptanceDialog';

export function TermsAgreementField({
  terms,
  value,
  onChange,
  error,
  errorId = 'terms-error',
}: {
  terms: CurrentTerms;
  value: string | null;
  onChange: (documentId: string | null) => void;
  error?: string | undefined;
  errorId?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const checkboxId = useId();
  const statusId = useId();
  const sentenceId = useId();
  const { state } = terms;
  const current = state.status === 'ready' ? state.current : null;

  // Agreement to a document that is no longer the one shown is no agreement.
  useEffect(() => {
    if (value !== null && current !== null && value !== current.document.id) onChange(null);
  }, [current, value, onChange]);

  const open = (): void => {
    if (current !== null) setIsOpen(true);
  };

  // Translated whole and split on its own placeholder, so the button lands
  // wherever each language puts the words.
  const [before = '', after = ''] = t('terms.field.label').split('{{terms}}');
  const checked = value !== null;
  const describedBy = [error === undefined ? null : errorId, statusId].filter(Boolean).join(' ');

  const loadFailure =
    state.status !== 'error'
      ? null
      : state.error instanceof NetworkError
        ? t('common.couldNotReachServer')
        : state.error instanceof ApiError
          ? state.error.message
          : t('terms.field.loadFailed');

  return (
    <div>
      <div className="flex items-start gap-2.5 text-sm text-ink">
        <input
          id={checkboxId}
          type="checkbox"
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-border-strong text-brand"
          checked={checked}
          disabled={current === null}
          // The whole sentence, button text included. The two <label>s alone
          // would name it "I have read and agree to the ." to a screen reader.
          aria-labelledby={sentenceId}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy}
          onChange={(event) => {
            if (event.currentTarget.checked) {
              // Not a tick: a request to read. The box stays controlled at false.
              open();
            } else {
              onChange(null);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !checked) {
              event.preventDefault();
              open();
            }
          }}
        />
        <p id={sentenceId} className="leading-snug">
          <label htmlFor={checkboxId} className="cursor-pointer">
            {before}
          </label>
          <button
            type="button"
            onClick={open}
            disabled={current === null}
            className="font-medium text-brand underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:text-ink-muted"
          >
            {t('terms.field.link')}
          </button>
          <label htmlFor={checkboxId} className="cursor-pointer">
            {after}
          </label>
        </p>
      </div>

      <p id={statusId} role="status" className="mt-1.5 pl-[1.625rem] text-xs text-ink-muted">
        {state.status === 'loading' && t('terms.field.loading')}
        {state.status === 'ready' &&
          (checked
            ? t('terms.field.agreedHint', { version: state.current.document.version })
            : t('terms.field.notYetHint'))}
      </p>

      {state.status === 'unavailable' && (
        <p role="alert" className="mt-1.5 pl-[1.625rem] text-xs font-medium text-danger">
          {t('errors.terms.TERMS_DOCUMENT_UNAVAILABLE')}
        </p>
      )}

      {loadFailure !== null && (
        <div
          role="alert"
          className="mt-1.5 flex flex-wrap items-center gap-2 pl-[1.625rem] text-xs font-medium text-danger"
        >
          <span>{loadFailure}</span>
          <Button type="button" size="sm" variant="secondary" onClick={terms.reload}>
            {t('terms.field.retry')}
          </Button>
        </div>
      )}

      {error !== undefined && (
        <p
          id={errorId}
          role="alert"
          className="mt-1.5 pl-[1.625rem] text-xs font-medium text-danger"
        >
          {error}
        </p>
      )}

      {current !== null && (
        <TermsAcceptanceDialog
          isOpen={isOpen}
          current={current}
          onCancel={() => {
            setIsOpen(false);
          }}
          onAgree={(documentId) => {
            onChange(documentId);
            setIsOpen(false);
          }}
        />
      )}
    </div>
  );
}
