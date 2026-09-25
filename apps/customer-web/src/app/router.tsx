/**
 * Routes.
 *
 * Public by default — a storefront that asks a stranger to sign in before
 * showing a price has already lost them. Only the pages that genuinely need an
 * activated customer sit inside `RequireCustomer`: cart, checkout, payment,
 * orders and schedules.
 *
 * Screens are loaded lazily. Somebody arriving on a product page should not
 * download the checkout flow, the recurring-schedule builder and the whole
 * account section first.
 *
 * Order matters in one place: `/products` (the browse-all page) is declared
 * before `/product/:slug`, and they use different prefixes precisely so a slug
 * can never be mistaken for a route.
 */
import { Suspense } from 'react';
import { Navigate, createBrowserRouter } from 'react-router-dom';
import { RequireCustomer } from '@/auth/RequireCustomer';
import { StoreLayout } from '@/layout/StoreLayout';
import { NotFoundPage } from '@/pages/NotFoundPage';
import { RouteFallback } from './RouteFallback';

type PageComponent = () => React.JSX.Element;

/** A lazily-loaded public route. */
function publicRoute(load: () => Promise<PageComponent>): {
  lazy: () => Promise<{ element: React.JSX.Element }>;
} {
  return {
    lazy: async () => {
      const Component = await load();
      return {
        element: (
          <Suspense fallback={<RouteFallback />}>
            <Component />
          </Suspense>
        ),
      };
    },
  };
}

/** A lazily-loaded route that needs an activated customer. */
function customerRoute(load: () => Promise<PageComponent>): {
  lazy: () => Promise<{ element: React.JSX.Element }>;
} {
  return {
    lazy: async () => {
      const Component = await load();
      return {
        element: (
          <RequireCustomer>
            <Suspense fallback={<RouteFallback />}>
              <Component />
            </Suspense>
          </RequireCustomer>
        ),
      };
    },
  };
}

/**
 * A page inside the account area's own frame.
 *
 * The same guard as `customerRoute`, and no `RequireCustomer` of its own: the
 * layout route above these carries it, so a child cannot be reached without
 * it. Wrapping each child again would mean the guard's redirect fired from
 * inside a layout that had already rendered a sidebar for a signed-out
 * visitor.
 */
function accountPage(load: () => Promise<PageComponent>): {
  lazy: () => Promise<{ element: React.JSX.Element }>;
} {
  return {
    lazy: async () => {
      const Component = await load();
      return {
        element: (
          <Suspense fallback={<RouteFallback />}>
            <Component />
          </Suspense>
        ),
      };
    },
  };
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <StoreLayout />,
    children: [
      // --- Public: browse without an account --------------------------------
      { index: true, ...publicRoute(() => import('@/pages/HomePage').then((m) => m.HomePage)) },
      {
        path: 'products',
        ...publicRoute(() => import('@/pages/CatalogPage').then((m) => m.CatalogPage)),
      },
      {
        path: 'category/:slug',
        ...publicRoute(() => import('@/pages/CatalogPage').then((m) => m.CatalogPage)),
      },
      {
        path: 'search',
        ...publicRoute(() => import('@/pages/CatalogPage').then((m) => m.CatalogPage)),
      },
      {
        path: 'product/:slug',
        ...publicRoute(() => import('@/pages/ProductPage').then((m) => m.ProductPage)),
      },

      // --- Account entry points --------------------------------------------
      {
        path: 'login',
        ...publicRoute(() => import('@/pages/LoginPage').then((m) => m.LoginPage)),
      },
      {
        path: 'activate',
        ...publicRoute(() => import('@/pages/ActivatePage').then((m) => m.ActivatePage)),
      },
      {
        path: 'forgot-password',
        ...publicRoute(() => import('@/pages/ForgotPasswordPage').then((m) => m.ForgotPasswordPage)),
      },
      {
        path: 'reset-password',
        ...publicRoute(() => import('@/pages/ResetPasswordPage').then((m) => m.ResetPasswordPage)),
      },
      {
        path: 'register',
        ...publicRoute(() => import('@/pages/RegisterPage').then((m) => m.RegisterPage)),
      },
      {
        // Where the confirmation email lands. The path is chosen by the
        // backend's `buildTokenUrl`, so the two have to agree.
        path: 'verify-email',
        ...publicRoute(() => import('@/pages/VerifyEmailPage').then((m) => m.VerifyEmailPage)),
      },
      {
        // Where the QR on a seller's invoice or packing list lands. Public:
        // it is read by whoever holds the carton. The path is printed into
        // every issued PDF by the backend's `verificationUrl`, so it must
        // never move.
        path: 'verify-document',
        ...publicRoute(() => import('@/pages/VerifyDocumentPage').then((m) => m.VerifyDocumentPage)),
      },

      // --- AI Mode ----------------------------------------------------------
      //
      // A route, not a widget. The floating panel that used to sit in the
      // corner of every page is gone; this is where the assistant lives now,
      // which is what lets it have a URL and a conversation history that
      // belongs to an account rather than to a browser tab.
      //
      // **Public**, on the same reasoning as the catalogue: somebody deciding
      // whether this store has what they need should be able to ask before
      // opening an account. Signing in is what adds a history, not what buys
      // an answer. The API agrees — `/assistant/start` and `/assistant/chat`
      // answer a guest, and only the history routes insist on a session.
      {
        path: 'ai',
        ...publicRoute(() => import('@/pages/AiModePage').then((m) => m.AiModePage)),
      },

      // --- Buying: activated customers only ---------------------------------
      { path: 'cart', ...customerRoute(() => import('@/pages/CartPage').then((m) => m.CartPage)) },
      {
        path: 'checkout',
        ...customerRoute(() => import('@/pages/CheckoutPage').then((m) => m.CheckoutPage)),
      },
      {
        path: 'checkout/payment/:orderId',
        ...customerRoute(() => import('@/pages/PaymentPage').then((m) => m.PaymentPage)),
      },
      {
        path: 'order-confirmation/:orderId',
        ...customerRoute(() =>
          import('@/pages/OrderConfirmationPage').then((m) => m.OrderConfirmationPage),
        ),
      },
      {
        path: 'schedules/new',
        ...customerRoute(() =>
          import('@/pages/ScheduleBuilderPage').then((m) => m.ScheduleBuilderPage),
        ),
      },

      /*
       * Schedule Cart — the cart's second tab.
       *
       * A sibling of `/cart` rather than a page inside the account frame, and
       * that is the whole reason it is declared here: it is one of two ways to
       * spend a basket, so it gets the same full-width frame the cart has and
       * the same guard. Dropped into the account section it would open with a
       * settings sidebar beside a list beside an editor, which is three
       * columns of chrome around the one the buyer came for.
       *
       * `/account/schedules` is untouched and still the place a standing
       * order is read — its history, its payment arrangement, pausing it.
       * This is where one is changed.
       */
      {
        path: 'accounts/schedule',
        ...customerRoute(() =>
          import('@/pages/schedule/ScheduleCartPage').then((m) => m.ScheduleCartPage),
        ),
      },

      // --- Where a contact-change link lands --------------------------------
      //
      // Public in the router and guarded by the page, which then requires a
      // session before it posts. It has to be reachable from a mail client
      // that carries no cookie: a 302 to sign-in would lose the token out of
      // the query string, and the customer would be told their link was
      // invalid when it was perfectly good.
      {
        path: 'confirm-contact',
        ...publicRoute(() =>
          import('@/pages/ConfirmContactPage').then((m) => m.ConfirmContactPage),
        ),
      },

      // --- Account ----------------------------------------------------------
      //
      // One layout route, and the guard lives on it rather than on each child.
      // That is what gives the whole section its sidebar without eleven pages
      // each importing one, and what keeps the sidebar mounted across a
      // navigation — the scroll position holds and the profile read is not
      // repeated.
      //
      // `integrations/erp` is where a buyer connects their OWN purchasing
      // system — their SAP, their monday.com board, their in-house API — so
      // that what they buy here appears there. It is theirs rather than the
      // operator's, which is why it lives in the account area and not under
      // Settings → ERP in the admin panel: that screen is the OPERATOR's
      // warehouse system and has nothing to do with a customer's.
      //
      // Both are addresses this server then calls with a credential, and the
      // reason it is safe to let a buyer supply one is `outbound-http.ts` —
      // https only, DNS resolved here, private ranges refused, the socket
      // pinned, every redirect re-checked — not that the risk went away.
      {
        path: 'account',
        lazy: async () => {
          const { AccountLayout } = await import('@/pages/account/AccountLayout');
          return {
            element: (
              <RequireCustomer>
                <Suspense fallback={<RouteFallback />}>
                  <AccountLayout />
                </Suspense>
              </RequireCustomer>
            ),
          };
        },
        children: [
          /*
           * `/account` on its own goes to the DASHBOARD now, not the profile.
           *
           * It is a path people type and a path a stale bookmark holds, and
           * the first thing somebody wants on arriving at their own account is
           * "is anything waiting on me" rather than their postal address.
           * `/account/profile` is untouched and still first in the settings
           * group of the sidebar, so no existing link breaks.
           */
          { index: true, element: <Navigate to="/account/dashboard" replace /> },

          {
            path: 'dashboard',
            ...accountPage(() =>
              import('@/pages/account/DashboardPage').then((m) => m.DashboardPage),
            ),
          },

          {
            path: 'orders',
            ...accountPage(() => import('@/pages/OrdersPage').then((m) => m.OrdersPage)),
          },
          {
            path: 'orders/:id',
            ...accountPage(() =>
              import('@/pages/OrderDetailPage').then((m) => m.OrderDetailPage),
            ),
          },
          {
            path: 'schedules',
            ...accountPage(() => import('@/pages/SchedulesPage').then((m) => m.SchedulesPage)),
          },
          {
            path: 'schedules/:id',
            ...accountPage(() =>
              import('@/pages/ScheduleDetailPage').then((m) => m.ScheduleDetailPage),
            ),
          },
          {
            path: 'preorders',
            ...accountPage(() => import('@/pages/PreordersPage').then((m) => m.PreordersPage)),
          },
          {
            path: 'preorders/:id',
            ...accountPage(() =>
              import('@/pages/PreorderDetailPage').then((m) => m.PreorderDetailPage),
            ),
          },
          // Preorder chats with the UBOSS team. `:id` is what the "a reply is
          // waiting" email links to.
          {
            path: 'messages',
            ...accountPage(() =>
              import('@/pages/account/MessagesPage').then((m) => m.MessagesPage),
            ),
          },
          {
            path: 'messages/:id',
            ...accountPage(() =>
              import('@/pages/account/MessagesPage').then((m) => m.MessagesPage),
            ),
          },
          {
            path: 'profile',
            ...accountPage(() =>
              import('@/pages/account/ProfileInformationPage').then(
                (m) => m.ProfileInformationPage,
              ),
            ),
          },
          {
            path: 'company',
            ...accountPage(() =>
              import('@/pages/account/CompanyInformationPage').then(
                (m) => m.CompanyInformationPage,
              ),
            ),
          },
          {
            path: 'addresses',
            ...accountPage(() => import('@/pages/AddressesPage').then((m) => m.AddressesPage)),
          },
          {
            path: 'region',
            ...accountPage(() => import('@/pages/account/RegionPage').then((m) => m.RegionPage)),
          },
          {
            path: 'payment-methods',
            ...accountPage(() =>
              import('@/pages/account/PaymentMethodsPage').then((m) => m.PaymentMethodsPage),
            ),
          },
          {
            path: 'autopay',
            ...accountPage(() => import('@/pages/AutoPayPage').then((m) => m.AutoPayPage)),
          },
          {
            path: 'billing',
            ...accountPage(() => import('@/pages/account/BillingPage').then((m) => m.BillingPage)),
          },
          /*
           * The old address. Kept as a redirect rather than removed: it is in
           * bookmarks, in the sidebar of anybody's stale tab, and in at least
           * one email telling a customer where to find this.
           */
          { path: 'erp', element: <Navigate to="/account/integrations/erp" replace /> },

          {
            path: 'integrations/erp',
            ...accountPage(() =>
              import('@/pages/account/erp/ErpHubPage').then((m) => m.ErpHubPage),
            ),
          },
          {
            path: 'integrations/erp/join',
            ...accountPage(() =>
              import('@/pages/account/erp/ErpJoinPage').then((m) => m.ErpJoinPage),
            ),
          },
          {
            path: 'integrations/erp/new',
            ...accountPage(() =>
              import('@/pages/account/erp/ErpWizardPage').then((m) => m.ErpWizardPage),
            ),
          },
          {
            /*
             * Where a buyer's own ERP sends them back after they authorise.
             *
             * The path is registered with that ERP and echoed on the token
             * exchange, so it is not a route that can be renamed freely - the
             * server names the same string in `oauth.service.ts`, and both have
             * to move together. Two static segments, so React Router ranks it
             * above `:id/edit` rather than matching a connection called
             * "oauth".
             */
            path: 'integrations/erp/oauth/callback',
            ...accountPage(() =>
              import('@/pages/account/erp/ErpOAuthCallbackPage').then(
                (m) => m.ErpOAuthCallbackPage,
              ),
            ),
          },
          {
            path: 'integrations/erp/:id',
            ...accountPage(() =>
              import('@/pages/account/erp/ErpConnectionPage').then((m) => m.ErpConnectionPage),
            ),
          },
          {
            path: 'integrations/erp/:id/edit',
            ...accountPage(() =>
              import('@/pages/account/erp/ErpWizardPage').then((m) => m.ErpWizardPage),
            ),
          },
          {
            path: 'coupons',
            ...accountPage(() => import('@/pages/account/CouponsPage').then((m) => m.CouponsPage)),
          },
          {
            path: 'wishlist',
            ...accountPage(() =>
              import('@/pages/account/WishlistPage').then((m) => m.WishlistPage),
            ),
          },
          {
            path: 'notifications',
            ...accountPage(() =>
              import('@/pages/account/NotificationsPage').then((m) => m.NotificationsPage),
            ),
          },
        ],
      },

      /*
       * The public front door to the marketplace programme.
       *
       * Inside `StoreLayout` and public, on the same reasoning as the
       * catalogue: somebody deciding whether to bring their catalogue here
       * should be able to read what is involved before opening an account.
       * The Seller Hub itself is a sibling of this layout, below.
       */
      {
        path: 'sell',
        ...publicRoute(() => import('@/pages/seller/SellPage').then((m) => m.SellPage)),
      },

      { path: '*', element: <NotFoundPage /> },
    ],
  },

  /*
   * The Seller Hub.
   *
   * A SIBLING of `StoreLayout`, not a child of it, and that is the whole point
   * of where it sits: a seller packing forty orders is not shopping, and the
   * storefront's header, market switcher, cart and footer are a hundred pixels
   * of chrome around a workspace they spend the day in. `SellerLayout` draws
   * its own frame.
   *
   * `RequireCustomer` on the layout rather than on each child: a seller is a
   * customer account with a seller organisation attached, so the existing
   * session guard is the right one, and `SellerLayout` then resolves the
   * organisation and redirects somebody who has none to `/sell`.
   */
  {
    path: '/seller',
    lazy: async () => {
      const { SellerLayout } = await import('@/pages/seller/SellerLayout');
      return {
        element: (
          <RequireCustomer>
            <Suspense fallback={<RouteFallback />}>
              <SellerLayout />
            </Suspense>
          </RequireCustomer>
        ),
      };
    },
    children: [
      { index: true, element: <Navigate to="/seller/dashboard" replace /> },
      {
        path: 'dashboard',
        ...accountPage(() =>
          import('@/pages/seller/SellerDashboardPage').then((m) => m.SellerDashboardPage),
        ),
      },
      {
        path: 'onboarding',
        ...accountPage(() =>
          import('@/pages/seller/SellerOnboardingPage').then((m) => m.SellerOnboardingPage),
        ),
      },
      /*
       * `listings/new` before `listings/:id`, and with different prefixes in
       * mind: "new" is a word an offer id can never be - ids are 26-character
       * ULIDs - but declaring it first means React Router never has to decide.
       */
      {
        path: 'listings/new',
        ...accountPage(() =>
          import('@/pages/seller/SellerListingWizardPage').then((m) => m.SellerListingWizardPage),
        ),
      },
      {
        path: 'listings',
        ...accountPage(() =>
          import('@/pages/seller/SellerListingsPage').then((m) => m.SellerListingsPage),
        ),
      },
      /*
       * Editing one listing.
       *
       * Declared BEFORE `listings/:id` for the same reason `listings/new`
       * comes before both: React Router matches in order, and a screen whose
       * path is a suffix of another's has to be stated first or it is never
       * reached.
       *
       * Its own route rather than a mode on the detail screen because the two
       * are different errands and one of them can be left half-finished: a
       * seller re-pricing forty rows has unsaved work, and unsaved work needs
       * a URL of its own so that leaving it can be a navigation the page is
       * allowed to interrupt.
       */
      {
        path: 'listings/:id/edit',
        ...accountPage(() =>
          import('@/pages/seller/SellerListingEditPage').then((m) => m.SellerListingEditPage),
        ),
      },
      /*
       * One listing, and the versions it sells in.
       *
       * Used to render the listings table again, so "Edit" on a live listing
       * went to a page that looked identical to the one it was pressed from.
       * It is its own screen because the errand is its own: a seller opens it
       * to add the sizes a product has always come in and was listed without.
       */
      {
        path: 'listings/:id',
        ...accountPage(() =>
          import('@/pages/seller/SellerListingDetailPage').then(
            (m) => m.SellerListingDetailPage,
          ),
        ),
      },
      /*
       * The names this seller has asked to list under.
       *
       * Its own route rather than a panel inside Listings: a seller opens it
       * because a listing will not go on sale, which is a different errand from
       * managing listings, and a queue of requests nobody can find is a queue
       * that generates support tickets instead of answers.
       */
      {
        path: 'brands',
        ...accountPage(() =>
          import('@/pages/seller/SellerBrandsPage').then((m) => m.SellerBrandsPage),
        ),
      },
      /*
       * What buyers have asked for, across the whole catalogue this seller
       * sells.
       *
       * Its own route rather than a tab on Listings: the errand is its own. A
       * seller opens Listings to change a product and opens this to find out
       * WHICH product to change, and folding the second into the first would
       * bury it behind a tab nobody presses.
       */
      {
        path: 'instructions',
        ...accountPage(() =>
          import('@/pages/seller/SellerInstructionsPage').then((m) => m.SellerInstructionsPage),
        ),
      },
      {
        path: 'inventory',
        ...accountPage(() =>
          import('@/pages/seller/SellerInventoryPage').then((m) => m.SellerInventoryPage),
        ),
      },
      {
        path: 'orders',
        ...accountPage(() =>
          import('@/pages/seller/SellerOrdersPage').then((m) => m.SellerOrdersPage),
        ),
      },
      {
        path: 'orders/:id',
        ...accountPage(() =>
          import('@/pages/seller/SellerOrderDetailPage').then((m) => m.SellerOrderDetailPage),
        ),
      },
      {
        path: 'preorders',
        ...accountPage(() =>
          import('@/pages/seller/SellerPreordersPage').then((m) => m.SellerPreordersPage),
        ),
      },
      {
        path: 'preorders/:id',
        ...accountPage(() =>
          import('@/pages/seller/SellerPreorderDetailPage').then((m) => m.SellerPreorderDetailPage),
        ),
      },
      {
        path: 'payments',
        ...accountPage(() =>
          import('@/pages/seller/SellerPaymentsPage').then((m) => m.SellerPaymentsPage),
        ),
      },
      {
        // How this seller numbers and signs the invoices issued in their name.
        path: 'invoicing',
        ...accountPage(() =>
          import('@/pages/seller/SellerInvoiceSettingsPage').then((m) => m.SellerInvoiceSettingsPage),
        ),
      },
      {
        path: 'carriers',
        ...accountPage(() =>
          import('@/pages/seller/SellerCarriersPage').then((m) => m.SellerCarriersPage),
        ),
      },
      {
        // Seller Hub -> Logistics: carriers, who manages L1-L4, level prices
        // and the settlement preview. The only place logistics is set up.
        path: 'logistics',
        ...accountPage(() =>
          import('@/pages/seller/SellerLogisticsPage').then((m) => m.SellerLogisticsPage),
        ),
      },
      {
        // Carrier accounts and delivery methods, reached from Logistics.
        path: 'fulfilment',
        ...accountPage(() =>
          import('@/pages/seller/SellerFulfilmentPage').then((m) => m.SellerFulfilmentPage),
        ),
      },
      {
        path: 'notifications',
        ...accountPage(() =>
          import('@/pages/seller/SellerNotificationsPage').then((m) => m.SellerNotificationsPage),
        ),
      },
      {
        path: 'activity',
        ...accountPage(() =>
          import('@/pages/seller/SellerActivityPage').then((m) => m.SellerActivityPage),
        ),
      },
      {
        /*
         * The seller's own accounting system.
         *
         * Its own route rather than a panel on Payments: connecting TallyPrime
         * is a setup errand somebody does once with a machine in front of
         * them, and a seller checking a settlement should not have to scroll
         * past a pairing wizard to reach it.
         */
        path: 'integrations',
        ...accountPage(() =>
          import('@/pages/seller/SellerErpPage').then((m) => m.SellerErpPage),
        ),
      },
      {
        path: 'profile',
        ...accountPage(() =>
          import('@/pages/seller/SellerProfilePage').then((m) => m.SellerProfilePage),
        ),
      },
    ],
  },
]);
