/**
 * The part of the home page that changes with who is looking (checklist
 * ENH-003): a guest, a business buyer, a private buyer, a seller, and somebody
 * coming back.
 *
 * Which one is decided from facts the storefront already holds, never from a
 * guess:
 *
 *   - **Seller**: a signed-in person whose seller account is trading
 *     (`GET /sellers/me`, the same read the header's Seller Hub button makes,
 *     so it shares its cache).
 *   - **Business buyer**: the confirmed buyer context is a company.
 *   - **Private buyer**: signed in, buying for themselves.
 *   - **Guest**: not signed in.
 *   - **Returning**: this browser viewed a product or supplier before
 *     (`lib/recently-viewed`, kept in this browser only). It adds a
 *     "continue where you left off" link to whichever of the four applies.
 *
 * Every link opens a screen that exists, and a link to a switched-off feature
 * is left out rather than shown. Nothing is sent anywhere to decide any of it.
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { fetchSellerIdentity } from '@/lib/seller';
import { readRecentlyViewed } from '@/lib/recently-viewed';
import { useI18n } from '@/i18n/i18n-context';

export type HomePersonaKind = 'guest' | 'business' | 'private' | 'seller';

interface Action {
  to: string;
  label: string;
}

export function HomePersona(): React.JSX.Element | null {
  const { t } = useI18n();
  const { isCustomer, isLoading, buyerContext } = useSession();
  const { features } = useStorefront();
  const identity = useQuery({
    queryKey: ['seller', 'identity'],
    queryFn: fetchSellerIdentity,
    enabled: isCustomer,
    retry: false,
    staleTime: 60_000,
  });
  const lastViewed = useMemo(() => readRecentlyViewed()[0] ?? null, []);

  // Nothing until the session (and, signed in, the seller read) has answered,
  // so the panel never shows one person's actions and then another's.
  if (isLoading || (isCustomer && identity.isPending)) return null;

  const isTradingSeller = isCustomer && identity.data?.seller?.isTrading === true;
  const kind: HomePersonaKind = !isCustomer
    ? 'guest'
    : isTradingSeller
      ? 'seller'
      : buyerContext.kind === 'COMPANY'
        ? 'business'
        : 'private';

  const rfq = features.rfq === true;
  const actions: Action[] = [];
  let title: string;
  let body: string;
  switch (kind) {
    case 'guest':
      // A guest coming back is not "new here": they are offered sign-in first.
      title = lastViewed === null ? t('home.persona.guestTitle') : t('home.persona.guestReturningTitle');
      body = t('home.persona.guestBody');
      actions.push(
        lastViewed === null
          ? { to: '/register', label: t('home.persona.createAccount') }
          : { to: '/login', label: t('home.persona.signIn') },
      );
      actions.push({ to: '/suppliers', label: t('home.persona.browseSuppliers') });
      actions.push({ to: '/sell', label: t('home.persona.sellHere') });
      break;
    case 'seller':
      title = t('home.persona.sellerTitle');
      body = t('home.persona.sellerBody');
      actions.push({ to: '/seller/dashboard', label: t('home.persona.sellerHub') });
      actions.push({ to: '/seller/orders', label: t('home.persona.sellerOrders') });
      actions.push({ to: '/seller/listings', label: t('home.persona.sellerListings') });
      break;
    case 'business':
      title = t('home.persona.businessTitle', {
        company: buyerContext.kind === 'COMPANY' ? buyerContext.companyName : '',
      });
      body = t('home.persona.businessBody');
      if (rfq) actions.push({ to: '/account/rfqs/new', label: t('home.persona.requestQuotes') });
      actions.push({ to: '/cart', label: t('home.persona.uploadList') });
      if (buyerContext.kind === 'COMPANY') {
        actions.push({ to: `/account/companies/${buyerContext.companyId}`, label: t('home.persona.companyTeam') });
      }
      break;
    case 'private':
      title = t('home.persona.privateTitle');
      body = t('home.persona.privateBody');
      actions.push({ to: '/account/orders', label: t('home.persona.yourOrders') });
      actions.push({ to: '/account/wishlist', label: t('home.persona.wishlist') });
      if (features.buyerCompanies === true) {
        actions.push({ to: '/account/companies', label: t('home.persona.buyForCompany') });
      }
      break;
  }

  if (lastViewed !== null) {
    actions.unshift({
      to: lastViewed.kind === 'supplier' ? `/suppliers/${lastViewed.slug}` : `/product/${lastViewed.slug}`,
      label: t('home.persona.continueWith', { name: lastViewed.name }),
    });
  }

  return (
    <section
      aria-labelledby="home-persona"
      data-persona={kind}
      data-returning={lastViewed !== null ? 'true' : 'false'}
      className="mt-10 rounded-2xl border border-line bg-surface p-5 shadow-sm"
    >
      <h2 id="home-persona" className="text-title-lg text-ink">
        {lastViewed !== null && kind !== 'guest' ? t('home.persona.welcomeBack', { title }) : title}
      </h2>
      <p className="mt-1 max-w-prose text-sm text-ink-muted">{body}</p>
      <ul className="mt-3 flex flex-wrap gap-2">
        {actions.map((action) => (
          <li key={action.to}>
            <Link
              to={action.to}
              className="inline-flex min-h-10 items-center rounded-md border border-border-strong bg-surface px-3 text-sm font-medium text-ink transition-colors hover:border-border-hover hover:bg-surface-hover"
            >
              {action.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
