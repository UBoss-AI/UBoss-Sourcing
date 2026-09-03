/**
 * Self-registration.
 *
 * This storefront is invitation-only by default, and the backend enforces it:
 * `POST /auth/register` returns SELF_REGISTRATION_DISABLED when the flag is
 * off, and FEATURE_DISABLED when the flag is on but the flow has not been
 * implemented. Neither is something a form can work around.
 *
 * So this page does not render a registration form it cannot submit. It states
 * how accounts are actually created and offers the two routes that do work —
 * activating an existing invitation, or asking for one. When the backend gains
 * a real registration flow, this page is where the form goes; the route and
 * the flag check are already in place.
 */
import { Link } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

export function RegisterPage(): React.JSX.Element {
  const { business, features } = useStorefront();

  useDocumentMeta({ title: 'Create an account', noIndex: true }, business.displayName);

  return (
    <div className="mx-auto w-full max-w-md py-8">
      <div className="rounded-lg border border-border bg-surface p-6 shadow-card">
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          {features.selfRegistration ? 'Registration is not open yet' : 'Accounts are by invitation'}
        </h1>

        <p className="mt-3 text-sm text-ink-muted">
          {features.selfRegistration
            ? `Self-registration has been switched on but is not available yet. In the meantime, ${business.displayName} can set your account up directly.`
            : `${business.displayName} sells to business accounts, so each one is set up by our team. Once we invite you, the email contains a link that activates your account and lets you choose your own password.`}
        </p>

        <div className="mt-6 space-y-3">
          <div className="rounded-md border border-border bg-surface-sunken p-4">
            <h2 className="text-sm font-medium text-ink">Already been invited?</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Open the activation link in your invitation email. It only works once, and it expires,
              so use the most recent one.
            </p>
          </div>

          <div className="rounded-md border border-border bg-surface-sunken p-4">
            <h2 className="text-sm font-medium text-ink">Need an account?</h2>
            <p className="mt-1 text-sm text-ink-muted">
              {business.supportEmail === null ? (
                'Get in touch with your account manager and we will set one up.'
              ) : (
                <>
                  Email{' '}
                  <a
                    href={`mailto:${business.supportEmail}?subject=New%20account%20request`}
                    className="font-medium text-brand hover:underline"
                  >
                    {business.supportEmail}
                  </a>{' '}
                  and we will set one up.
                </>
              )}
            </p>
          </div>
        </div>

        <Link
          to="/login"
          className="mt-6 inline-flex h-10 w-full items-center justify-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-sunken"
        >
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
