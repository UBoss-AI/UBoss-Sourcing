/**
 * "I have read and agree to the Terms and Conditions", as a form field.
 *
 * The value is the id of the document agreed to, or null. Null is the start,
 * and there are exactly two ways to change it:
 *
 *   - **I agree** in the dialog sets it to that document's id.
 *   - **Unticking** the box sets it back to null.
 *
 * Ticking an unticked box does not tick it: it opens the dialog, and the box
 * stays empty until I agree is pressed there. The same goes for Space on the
 * box, Enter on the box, clicking the sentence, and the "Terms and Conditions"
 * button inside it. So re-ticking after an untick means reading and agreeing
 * again, and nothing the person does short of I agree - opening, scrolling,
 * cancelling, pressing Escape - ever produces a tick.
 *
 * If the language changes to one with a different document, or the server
 * says the version is out of date and a new one arrives, an agreement to the
 * old document is cleared: agreeing to one text is not agreeing to another.
 *
 * The tick is the person's choice on this form, not a record. The record is
 * written by the server when the account is created, and the hint under a
 * ticked box says so.
 */
import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui';
import { useStorefront } from '@/app/storefront-context';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
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
  const { business } = useStorefront();
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

  // The sentence is translated whole and split on its own placeholder, so the
  // button lands wherever each language puts the words.
  const [before = '', after = ''] = t('terms.field.label').split('{{terms}}');
  const checked = value !== null;
  const describedBy = [error === undefined ? null : errorId, statusId].filter(Boolean).join(' ');
  const otherPolicies = Object.entries(business.policyLinks ?? {});

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

      {state.status === 'error' && (
        <div role="alert" className="mt-1.5 flex flex-wrap items-center gap-2 pl-[1.625rem] text-xs font-medium text-danger">
          <span>{errorMessage(t, state.error, t('terms.field.loadFailed'))}</span>
          <Button type="button" size="sm" variant="secondary" onClick={terms.reload}>
            {t('terms.field.retry')}
          </Button>
        </div>
      )}

      {error !== undefined && (
        <p id={errorId} role="alert" className="mt-1.5 pl-[1.625rem] text-xs font-medium text-danger">
          {error}
        </p>
      )}

      {/* The privacy notice and the other policies are linked on their own
          line, not folded into the agreement: reading them is not agreeing to
          the Terms, and agreeing to the Terms is not consent to anything. */}
      {otherPolicies.length > 0 && (
        <p className="mt-2 pl-[1.625rem] text-xs text-ink-muted">
          {t('terms.field.otherPolicies')}{' '}
          {otherPolicies.map(([text, href], index) => (
            <span key={text}>
              {index > 0 && ', '}
              <a href={href} target="_blank" rel="noopener noreferrer" className="font-medium text-brand hover:underline">
                {text}
              </a>
            </span>
          ))}
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
