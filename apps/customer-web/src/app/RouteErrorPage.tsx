/**
 * What a route shows when it cannot render: the `errorElement` on every route.
 *
 * Catches three different failures and tells them apart through
 * `classifyError`: a page's code throwing while it renders, a lazily-loaded
 * page whose file could not be fetched, and an `ApiError` a page chose to
 * throw rather than handle. A child route's copy renders inside the store's
 * header and footer; the one on the layout routes themselves fills the screen,
 * because the frame it would sit in is what failed.
 *
 * **Offline recovers on its own, once.** The page reloads on the browser's
 * `online` event — an event, not a timer, so a reload that meets the same
 * failure waits for the next real reconnection rather than looping.
 *
 * Signed-out visitors never see the 401 here from a guard: `RequireCustomer`
 * sends them to `/login` before a page renders. This page's sign-in button is
 * for an API that answered 401 to a page that was already open.
 */
import { useEffect } from 'react';
import { useLocation, useNavigate, useRouteError } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { ErrorPage } from '@/components/error-page/ErrorPage';
import { errorActions } from '@/components/error-page/error-actions';
import { classifyError } from '@/components/error-page/error-kind';
import { useOnline, useOnReconnect } from '@/components/error-page/use-online';
import { useI18n } from '@/i18n/i18n-context';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

function reload(): void {
  window.location.reload();
}

export function RouteErrorPage({ fullScreen = false }: { fullScreen?: boolean }): React.JSX.Element {
  const error = useRouteError();
  const { t } = useI18n();
  const { business } = useStorefront();
  const location = useLocation();
  const navigate = useNavigate();
  const online = useOnline();

  const { kind, statusCode, reference } = classifyError(error, online);

  useEffect(() => {
    // Kept for whoever debugs it: there is no error-reporting service wired
    // up, and the visitor is shown none of this.
    console.error('Route error', error);
  }, [error]);

  useOnReconnect(kind === 'offline' ? reload : undefined);

  useDocumentMeta({ title: t(`errorPage.${kind}.title`), noIndex: true }, business.displayName);

  return (
    <ErrorPage
      kind={kind}
      t={t}
      statusCode={statusCode}
      reference={reference}
      fullScreen={fullScreen}
      onSearch={
        kind === 'notFound'
          ? (query) => {
              void navigate(query.length === 0 ? '/products' : `/products?q=${encodeURIComponent(query)}`);
            }
          : undefined
      }
      actions={errorActions(kind, {
        t,
        home: { to: '/' },
        signIn: { to: '/login', from: location.pathname + location.search },
        supportTo: '/support',
        retry: reload,
      })}
    />
  );
}
