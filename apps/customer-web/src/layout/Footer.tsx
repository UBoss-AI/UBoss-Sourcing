/**
 * Footer: support contacts and policy links.
 *
 * Policy links come from the backend's public config. A storefront that
 * hard-codes "Terms" and "Privacy" hrefs ships dead links the day Legal moves
 * them, so an absent link is simply not rendered — and the same holds for the
 * support email and phone, which many deployments will not have set on day
 * one.
 *
 * Support is given the most weight of the columns. On a B2B storefront the
 * footer is where a buyer goes when an order is wrong, and a mail address set
 * in `text-sm text-ink-muted` among a stack of navigation links is not where
 * they will find it. Each contact is a tappable row with its own icon, sized
 * as a real touch target.
 */
import { Link } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { useI18n } from '@/i18n/i18n-context';
import { DocumentIcon, MailIcon, PhoneIcon } from '@/components/icons';

/** A footer column heading. One style, so the columns read as a set. */
function ColumnHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h2 className="text-xxs font-semibold uppercase tracking-[0.14em] text-ink-subtle">
      {children}
    </h2>
  );
}

/** The shared skin for a footer navigation link. */
const LINK_CLASS =
  'inline-block rounded text-sm text-ink-muted transition-colors hover:text-brand hover:underline';

/**
 * A support contact.
 *
 * A bordered row rather than a bare link: this is the one thing in the footer
 * somebody is actively hunting for, and it needs to look like something you
 * press.
 */
function ContactRow({
  href,
  icon: ContactIcon,
  label,
  value,
}: {
  href: string;
  icon: (props: { className?: string }) => React.JSX.Element;
  label: string;
  value: string;
}): React.JSX.Element {
  return (
    <a
      href={href}
      className="group flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5 transition-[border-color,box-shadow] hover:border-border-hover hover:shadow-card"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand ring-1 ring-inset ring-brand/15">
        <ContactIcon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-xxs font-medium uppercase tracking-wider text-ink-subtle">
          {label}
        </span>
        <span className="block truncate text-sm font-medium text-ink group-hover:text-brand">
          {value}
        </span>
      </span>
    </a>
  );
}

export function Footer(): React.JSX.Element {
  const { business } = useStorefront();
  const { t } = useI18n();
  const policies = Object.entries(business.policyLinks ?? {});
  const hasSupport = business.supportEmail !== null || business.supportPhone !== null;

  return (
    <footer className="mt-12 border-t border-border bg-surface">
      {/*
       * Identity on the left, the link columns clustered on the right.
       *
       * Not a four-column grid: `policyLinks` is optional, so a fixed
       * four-track grid leaves a dead column of whitespace at the end of the
       * footer for every deployment that has not set any. A flex row with the
       * columns grouped adapts to however many there actually are.
       */}
      <div className="mx-auto flex max-w-content flex-col gap-10 px-4 py-12 lg:flex-row lg:justify-between lg:gap-16">
        {/* The identity block. Repeats the brand lockup from the header, at the
            other end of the page, so a long catalogue page still closes with
            the name of who you are buying from. */}
        <div className="lg:max-w-xs">
          <div className="flex items-center gap-3">
            {business.logo === null ? (
              <span
                aria-hidden="true"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-inverse text-base font-bold text-white"
              >
                {business.displayName.slice(0, 1).toUpperCase()}
              </span>
            ) : (
              <img
                src={business.logo.url}
                alt=""
                width={40}
                height={40}
                className="h-10 w-10 shrink-0 rounded-md border border-border object-contain p-1"
              />
            )}
            <h2 className="min-w-0 text-title-xs text-ink">{business.displayName}</h2>
          </div>

          <p className="mt-3 max-w-xs text-sm leading-relaxed text-ink-muted">
            {t('footer.tagline')}
          </p>
        </div>

        <div className="grid gap-10 sm:grid-cols-2 lg:flex lg:shrink-0 lg:gap-16">
          <div>
            <ColumnHeading>{t('footer.shop')}</ColumnHeading>
            <ul className="mt-3 space-y-2">
              <li>
                <Link to="/products" className={LINK_CLASS}>
                  {t('footer.allProducts')}
                </Link>
              </li>
              <li>
                <Link to="/account/orders" className={LINK_CLASS}>
                  {t('header.myOrders')}
                </Link>
              </li>
              <li>
                <Link to="/account/schedules" className={LINK_CLASS}>
                  {t('header.repeatPurchases')}
                </Link>
              </li>
            </ul>
          </div>

          {/* Fixed width from `lg` up: the contact rows carry an address that
              must not wrap, and letting a flex track size itself to the longest
              support email in the world is how one column ends up owning half
              the footer. */}
          <div className="lg:w-60">
            <ColumnHeading>{t('footer.support')}</ColumnHeading>

            {hasSupport ? (
              <div className="mt-3 space-y-2">
                {business.supportEmail !== null && (
                  <ContactRow
                    href={`mailto:${business.supportEmail}`}
                    icon={MailIcon}
                    label={t('footer.email')}
                    value={business.supportEmail}
                  />
                )}
                {business.supportPhone !== null && (
                  <ContactRow
                    href={`tel:${business.supportPhone.replace(/\s+/g, '')}`}
                    icon={PhoneIcon}
                    label={t('footer.phone')}
                    value={business.supportPhone}
                  />
                )}
              </div>
            ) : (
              <p className="mt-3 rounded-md border border-dashed border-border px-3 py-2.5 text-sm text-ink-subtle">
                {t('footer.noContactDetails')}
              </p>
            )}
          </div>

          {policies.length > 0 && (
            <div>
              <ColumnHeading>{t('footer.policies')}</ColumnHeading>
              <ul className="mt-3 space-y-2">
                {policies.map(([label, href]) => (
                  <li key={label}>
                    <a
                      href={href}
                      className="group inline-flex items-center gap-2 rounded text-sm text-ink-muted transition-colors hover:text-brand"
                      // An outbound policy link: rel prevents the target page
                      // from reaching back through window.opener.
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <DocumentIcon className="h-4 w-4 shrink-0 text-ink-subtle transition-colors group-hover:text-brand" />
                      <span className="group-hover:underline">{label}</span>
                      <span className="sr-only">{t('footer.opensInNewTab')}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>

      {/*
       * Small print, on the sunken ground rather than the card ground.
       *
       * The change of surface is what makes it read as small print instead of
       * as one more column: the copyright and the quoting currency are both
       * things a buyer needs available and nothing they need to read.
       */}
      <div className="border-t border-border bg-surface-sunken">
        <div className="mx-auto flex max-w-content flex-col gap-1.5 px-4 py-5 text-xxs text-ink-subtle sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} {business.displayName}
          </p>
          <p>{t('footer.allPricesIn', { currency: business.currency })}</p>
        </div>
      </div>
    </footer>
  );
}
