/**
 * The way into the Seller Hub, in the header itself.
 *
 * In the top bar rather than inside the account menu, because it is a way IN
 * rather than a setting: somebody who has never sold here has no reason to
 * open a menu labelled with their own name, and a supplier arriving on the
 * storefront to see whether they could list here should find the answer
 * without hunting.
 *
 * One control, four states, because the next action is genuinely different in
 * each:
 *
 *   - Not a seller           → "Become a seller", to the public page.
 *   - Application unfinished → "Continue setup", with how far along.
 *   - Sent back or paused    → the state itself, in amber.
 *   - Approved               → "Seller Hub", to the dashboard.
 *
 * It is deliberately the quietest control in the row on a storefront whose job
 * is selling TO people: outlined rather than filled, so it does not compete
 * with the basket. What it must not be is hidden.
 *
 * Below `sm` it collapses to its icon with an accessible name, like the other
 * header controls. It never disappears entirely — a control that exists only
 * on a desktop is a control half the traffic never sees.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { useStorefront } from '@/app/storefront-context';
import { fetchOnboarding, fetchSellerIdentity } from '@/lib/seller';

function StoreIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M4 9.5 5.2 5.4A1.5 1.5 0 0 1 6.6 4.3h10.8a1.5 1.5 0 0 1 1.4 1.1L20 9.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M4 9.5h16v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-9Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M9.5 20v-5h5v5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export function BecomeSellerButton(): React.JSX.Element | null {
  const { t } = useI18n();
  const { isCustomer, isLoading } = useSession();
  const { seller: storefrontSeller } = useStorefront();

  /*
   * Asked only of a signed-in customer.
   *
   * A guest is offered "Become a seller" straight away without a request -
   * they cannot have a seller account, so there is nothing to look up, and
   * putting a 401 in the console of every anonymous page view to learn that
   * would be absurd.
   */
  const identity = useQuery({
    queryKey: ['seller', 'identity'],
    queryFn: fetchSellerIdentity,
    enabled: isCustomer,
    retry: false,
    staleTime: 60_000,
  });

  const seller = identity.data?.seller ?? null;

  // Only for an unfinished application, where the percentage is the whole
  // point of the label. Never for a guest, never for an approved seller.
  const onboarding = useQuery({
    queryKey: ['seller', 'onboarding'],
    queryFn: fetchOnboarding,
    enabled: seller !== null && seller.status === 'DRAFT',
    retry: false,
    staleTime: 60_000,
  });

  /*
   * Nothing on a seller's own shop front.
   *
   * `northwind.example` is Northwind selling to their buyers. "Become a seller"
   * there invites their customer to join the operator's marketplace off the
   * back of Northwind's traffic, and "Seller Hub" is a back-office door on a
   * shop front. Both belong on the marketplace's own domain.
   */
  if (storefrontSeller !== undefined) return null;

  // While the session is still resolving there is nothing honest to say: a
  // button that reads "Become a seller" for half a second and then becomes
  // "Seller Hub" is a flicker on every page load.
  if (isLoading) return null;

  const { to, label, shortLabel, tone } = ((): {
    to: string;
    label: string;
    shortLabel: string;
    tone: 'default' | 'warning' | 'brand';
  } => {
    if (seller === null) {
      return {
        to: '/sell',
        label: t('seller.header.becomeASeller'),
        shortLabel: t('seller.header.sell'),
        tone: 'default',
      };
    }

    if (seller.status === 'ACTION_REQUIRED') {
      return {
        to: '/seller/onboarding',
        label: t('seller.header.applicationNeedsChanges'),
        shortLabel: t('seller.header.sell'),
        tone: 'warning',
      };
    }

    if (seller.status === 'SUSPENDED') {
      return {
        to: '/seller/dashboard',
        label: t('seller.header.sellingPaused'),
        shortLabel: t('seller.header.sell'),
        tone: 'warning',
      };
    }

    if (seller.status === 'DRAFT') {
      const percent = onboarding.data?.percentComplete ?? null;

      return {
        to: '/seller/onboarding',
        label:
          percent === null
            ? t('seller.header.continueSetup')
            : t('seller.header.continueSetupPercent', { percent: String(percent) }),
        shortLabel: t('seller.header.setup'),
        tone: 'brand',
      };
    }

    if (!seller.isTrading) {
      return {
        to: '/seller/dashboard',
        label: t('seller.header.applicationSubmitted'),
        shortLabel: t('seller.header.sell'),
        tone: 'brand',
      };
    }

    return {
      to: '/seller/dashboard',
      label: t('seller.header.sellerHub'),
      shortLabel: t('seller.header.hub'),
      tone: 'brand',
    };
  })();

  return (
    <Link
      to={to}
      // The full sentence is the accessible name at every width, so the
      // icon-only form below `sm` is not an unlabelled button.
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex h-9 shrink-0 items-center gap-2 rounded-md border px-2.5 text-sm font-medium',
        'transition-[background-color,border-color,color] sm:px-3',
        tone === 'warning'
          ? 'border-warning/40 bg-warning-soft text-warning hover:border-warning/60'
          : tone === 'brand'
            ? 'border-brand/30 bg-brand-soft text-brand hover:bg-brand-soft-hover'
            : 'border-border-strong bg-surface text-ink hover:border-border-hover hover:bg-surface-hover',
      )}
    >
      <StoreIcon className="h-[1.15rem] w-[1.15rem] shrink-0" />
      {/* The label collapses, the control does not. `hidden sm:inline` rather
          than a second element, so there is one DOM node and one focus stop. */}
      <span className="hidden whitespace-nowrap sm:inline">{label}</span>
      <span className="sr-only sm:hidden">{shortLabel}</span>
    </Link>
  );
}
