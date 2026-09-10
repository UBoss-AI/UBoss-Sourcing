/**
 * The "I accept the terms" tick, with the operator's own policy links beside
 * it.
 *
 * One component because three screens ask for the same consent — sign-in,
 * registration and invitation activation — and the thing a customer is
 * agreeing to has to read identically on all three. Two copies of this markup
 * is how one screen ends up linking to a privacy policy the other does not.
 *
 * The links come from `business.policyLinks`, which the operator sets in the
 * panel. Nothing here knows what a policy is called or where it lives: a
 * deployment that has set none renders the sentence alone rather than a link
 * to a page that does not exist.
 *
 * The box is never ticked for the customer. A pre-ticked consent is not
 * consent, and `defaultValues` at every call site says `false`.
 */
import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';
import { useStorefront } from '@/app/storefront-context';

export interface AcceptTermsCheckboxProps extends InputHTMLAttributes<HTMLInputElement> {
  /** The sentence beside the box, already translated. */
  label: string;
  /** The validation message, when the form has one to show. */
  error?: string | undefined;
  /**
   * Only needed where two of these could share a page. The id ties the message
   * to the box for a screen reader, so it has to be unique in the document.
   */
  errorId?: string | undefined;
}

export const AcceptTermsCheckbox = forwardRef<HTMLInputElement, AcceptTermsCheckboxProps>(
  function AcceptTermsCheckbox({ label, error, errorId = 'accept-terms-error', ...rest }, ref) {
    const { business } = useStorefront();
    const policies = Object.entries(business.policyLinks ?? {});

    return (
      <div>
        <label className="flex items-start gap-2.5 text-sm text-ink">
          <input
            ref={ref}
            type="checkbox"
            className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand"
            aria-describedby={error === undefined ? undefined : errorId}
            {...rest}
          />
          <span>
            {label}
            {policies.length > 0 && (
              <>
                {' ('}
                {policies.map(([text, href], index) => (
                  <span key={text}>
                    {index > 0 && ', '}
                    {/* A new tab, deliberately: somebody reading the terms
                        halfway through a form should not lose what they have
                        typed to do it. */}
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium text-brand hover:underline"
                    >
                      {text}
                    </a>
                  </span>
                ))}
                {')'}
              </>
            )}
          </span>
        </label>

        {error !== undefined && (
          <p id={errorId} role="alert" className="mt-1.5 text-xs font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    );
  },
);
