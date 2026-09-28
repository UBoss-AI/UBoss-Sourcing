/**
 * What a route shows when it cannot render: the `errorElement` on every route.
 *
 * Catches three different failures and tells them apart through
 * `classifyError`: a screen's code throwing while it renders, a lazily-loaded
 * screen whose file could not be fetched, and an `ApiError` a screen chose to
 * throw rather than handle. A screen's copy renders inside the portal's own
 * frame; the one on the shell route itself fills the screen, because the frame
 * it would sit in is what failed.
 *
 * **Offline recovers on its own, once.** The page reloads on the browser's
 * `online` event — an event, not a timer, so a reload that meets the same
 * failure waits for the next real reconnection rather than looping.
 *
 * A signed-out visitor never sees the 401 here from a guard: the session guard
 * sends them to `/login` before a screen renders. This page's sign-in button
 * is for an API that answered 401 to a screen that was already open.
 */
import { useEffect } from 'react';
import { useLocation, useRouteError } from 'react-router-dom';
import { ErrorPage } from '@/components/error-page/ErrorPage';
import { errorActions } from '@/components/error-page/error-actions';
import { classifyError } from '@/components/error-page/error-kind';
import { useOnline, useOnReconnect } from '@/components/error-page/use-online';
import { useI18n } from '@/i18n/i18n-context';

function reload(): void {
  window.location.reload();
}

export function RouteErrorPage({ fullScreen = false }: { fullScreen?: boolean }): React.JSX.Element {
  const error = useRouteError();
  const { t } = useI18n();
  const location = useLocation();
  const online = useOnline();

  const { kind, statusCode, reference } = classifyError(error, online);

  useEffect(() => {
    // Kept for whoever debugs it: there is no error-reporting service wired
    // up, and the person looking at the screen is shown none of this.
    console.error('Route error', error);
  }, [error]);

  useOnReconnect(kind === 'offline' ? reload : undefined);

  return (
    <ErrorPage
      kind={kind}
      t={t}
      statusCode={statusCode}
      reference={reference}
      fullScreen={fullScreen}
      actions={errorActions(kind, {
        t,
        home: { to: '/' },
        homeIsDashboard: true,
        signIn: { to: '/login', from: location.pathname + location.search },
        // The portal's own support page, where a carrier raises a ticket.
        supportTo: '/support',
        retry: reload,
      })}
    />
  );
}
