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
import { createBrowserRouter } from 'react-router-dom';
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

      // --- Account ----------------------------------------------------------
      {
        path: 'account/orders',
        ...customerRoute(() => import('@/pages/OrdersPage').then((m) => m.OrdersPage)),
      },
      {
        path: 'account/orders/:id',
        ...customerRoute(() => import('@/pages/OrderDetailPage').then((m) => m.OrderDetailPage)),
      },
      {
        path: 'account/schedules',
        ...customerRoute(() => import('@/pages/SchedulesPage').then((m) => m.SchedulesPage)),
      },
      {
        path: 'account/schedules/:id',
        ...customerRoute(() =>
          import('@/pages/ScheduleDetailPage').then((m) => m.ScheduleDetailPage),
        ),
      },
      {
        path: 'account/addresses',
        ...customerRoute(() => import('@/pages/AddressesPage').then((m) => m.AddressesPage)),
      },
      {
        path: 'account/profile',
        ...customerRoute(() => import('@/pages/ProfilePage').then((m) => m.ProfilePage)),
      },

      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
