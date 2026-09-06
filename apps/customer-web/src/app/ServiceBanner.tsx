/**
 * A banner for conditions that affect the whole site.
 *
 * Two of them, and both are banners rather than blocking screens on purpose:
 *
 *   - **The store is unreachable or in maintenance.** Everything already on
 *     screen stays readable and a half-typed form keeps its contents. A
 *     full-page takeover would throw both away for a condition that usually
 *     lasts seconds.
 *   - **The session ended.** The customer is told, and given a sign-in link
 *     that returns them to the page they are on — not to the home page, which
 *     is how people lose a cart they spent ten minutes filling.
 *
 * It listens to the query cache rather than being wired into every page. A
 * page that forgot to report an outage would otherwise be a silent one.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { ApiError, NetworkError, onSessionEnded } from '@/lib/api';
import { useI18n } from '@/i18n/i18n-context';

/** True while at least one query is failing for a reason worth announcing. */
function useServiceTrouble(): 'maintenance' | 'unreachable' | null {
  const queryClient = useQueryClient();
  const [trouble, setTrouble] = useState<'maintenance' | 'unreachable' | null>(null);

  useEffect(() => {
    const cache = queryClient.getQueryCache();

    const evaluate = (): void => {
      let next: 'maintenance' | 'unreachable' | null = null;

      for (const query of cache.getAll()) {
        const error = query.state.error;

        // Only a settled failure counts. A query still retrying has not given
        // up yet, and announcing every transient blip is how a banner becomes
        // background noise people stop reading.
        if (query.state.status !== 'error' || error === null) continue;

        if (error instanceof ApiError && error.status === 503) {
          next = 'maintenance';
          break;
        }

        if (error instanceof NetworkError && !error.isOffline) {
          next = 'unreachable';
        }
      }

      setTrouble(next);
    };

    evaluate();
    return cache.subscribe(evaluate);
  }, [queryClient]);

  return trouble;
}

function SessionEndedBanner(): React.JSX.Element {
  const { t } = useI18n();

  const location = useLocation();

  return (
    <div role="alert" className="bg-warning-soft px-4 py-2.5 text-center text-sm text-ink">
      <span className="font-medium text-warning">{t('serviceBanner.yourSessionHasEnded')}</span>{' '}
      <Link
        to="/login"
        // Carrying the current location means signing back in returns them
        // here, not to the home page.
        state={{ from: location.pathname + location.search }}
        className="font-medium text-brand underline underline-offset-2"
      >
        {t('serviceBanner.signInAgain')}
      </Link>{' '}
      to carry on. Nothing in your cart has been lost.
    </div>
  );
}

export function ServiceBanner(): React.JSX.Element | null {
  const { t } = useI18n();

  const { user, isLoading } = useSession();
  const trouble = useServiceTrouble();
  const [sessionJustEnded, setSessionJustEnded] = useState(false);

  /**
   * Whether this visitor has been signed in at any point on this page.
   *
   * The api client announces a session ending on *any* 401 it cannot refresh
   * away, because it has no idea whether there was ever a session - and a
   * rejected sign-in is a 401 like any other. Without this, mistyping a
   * password put "Your session has ended. Sign in again" across the top of the
   * sign-in page, directly above the real reason, for somebody who has never
   * signed in at all. A ref rather than state: it must be readable from inside
   * the listener below without resubscribing it on every change.
   */
  const hadSession = useRef(false);

  useEffect(() => {
    if (user !== null) hadSession.current = true;
  }, [user]);

  // Announced once, when it happens. A customer who was never signed in should
  // not be told their session ended.
  useEffect(
    () =>
      onSessionEnded(() => {
        if (hadSession.current) setSessionJustEnded(true);
      }),
    [],
  );

  // Signing back in clears it, without needing the page to be reloaded.
  useEffect(() => {
    if (user !== null) setSessionJustEnded(false);
  }, [user]);

  if (sessionJustEnded && !isLoading && user === null) {
    return <SessionEndedBanner />;
  }

  if (trouble === 'maintenance') {
    return (
      <div role="alert" className="bg-warning-soft px-4 py-2.5 text-center text-sm text-ink">
        <span className="font-medium text-warning">
          {t('serviceBanner.theStoreIsBrieflyUnavailable')}
        </span>
        {t('serviceBanner.weAreWorkingOnIt')}
      </div>
    );
  }

  if (trouble === 'unreachable') {
    return (
      <div role="status" className="bg-warning-soft px-4 py-2.5 text-center text-sm text-ink">
        <span className="font-medium text-warning">
          {t('serviceBanner.weAreHavingTroubleReaching')}
        </span>{' '}
        Anything already on screen still works. Changes will not save until the connection is back.
      </div>
    );
  }

  return null;
}
