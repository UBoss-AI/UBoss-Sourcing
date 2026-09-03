/**
 * Footer: support contacts and policy links.
 *
 * Policy links come from the backend's public config. A storefront that
 * hard-codes "Terms" and "Privacy" hrefs ships dead links the day Legal moves
 * them, so an absent link is simply not rendered.
 */
import { Link } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';

export function Footer(): React.JSX.Element {
  const { business } = useStorefront();
  const policies = Object.entries(business.policyLinks ?? {});

  return (
    <footer className="mt-12 border-t border-border bg-surface">
      <div className="mx-auto grid max-w-content gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <h2 className="text-sm font-semibold text-ink">{business.displayName}</h2>
          <p className="mt-2 text-sm text-ink-muted">
            Industrial and business supplies, sourced and delivered.
          </p>
        </div>

        <div>
          <h2 className="text-sm font-semibold text-ink">Shop</h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            <li>
              <Link to="/products" className="text-ink-muted hover:text-brand hover:underline">
                All products
              </Link>
            </li>
            <li>
              <Link to="/account/orders" className="text-ink-muted hover:text-brand hover:underline">
                My orders
              </Link>
            </li>
            <li>
              <Link
                to="/account/schedules"
                className="text-ink-muted hover:text-brand hover:underline"
              >
                Repeat purchases
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <h2 className="text-sm font-semibold text-ink">Support</h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {business.supportEmail !== null && (
              <li>
                <a
                  href={`mailto:${business.supportEmail}`}
                  className="text-ink-muted hover:text-brand hover:underline"
                >
                  {business.supportEmail}
                </a>
              </li>
            )}
            {business.supportPhone !== null && (
              <li>
                <a
                  href={`tel:${business.supportPhone.replace(/\s+/g, '')}`}
                  className="text-ink-muted hover:text-brand hover:underline"
                >
                  {business.supportPhone}
                </a>
              </li>
            )}
            {business.supportEmail === null && business.supportPhone === null && (
              <li className="text-ink-subtle">Contact details coming soon.</li>
            )}
          </ul>
        </div>

        {policies.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold text-ink">Policies</h2>
            <ul className="mt-2 space-y-1.5 text-sm">
              {policies.map(([label, href]) => (
                <li key={label}>
                  <a
                    href={href}
                    className="text-ink-muted hover:text-brand hover:underline"
                    // An outbound policy link: rel prevents the target page
                    // from reaching back through window.opener.
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="border-t border-border">
        <p className="mx-auto max-w-content px-4 py-4 text-xs text-ink-subtle">
          © {new Date().getFullYear()} {business.displayName}. All prices in {business.currency}.
        </p>
      </div>
    </footer>
  );
}
