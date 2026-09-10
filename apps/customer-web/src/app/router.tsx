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
      // There is no ERP *connection* screen here, only an explanation: a
      // connection is a URL plus a credential this installation's server then
      // calls, so it is configured by an administrator under Settings → ERP.
      // Auto-pay is the opposite case and stays with the buyer, because nobody
      // can consent on somebody else's behalf to money leaving their account.
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
          // `/account` on its own goes to the profile rather than 404ing: it
          // is a path people type and a path a stale bookmark holds.
          { index: true, element: <Navigate to="/account/profile" replace /> },

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
          {
            path: 'erp',
            ...accountPage(() => import('@/pages/account/ErpPage').then((m) => m.ErpPage)),
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

      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
