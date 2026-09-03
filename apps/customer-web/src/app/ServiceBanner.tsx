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
import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { ApiError, NetworkError, onSessionEnded } from '@/lib/api';

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
  const location = useLocation();

  return (
    <div
      role="alert"
      className="bg-warning-soft px-4 py-2.5 text-center text-sm text-ink"
    >
      <span className="font-medium text-warning">Your session has ended.</span>{' '}
      <Link
        to="/login"
        // Carrying the current location means signing back in returns them
        // here, not to the home page.
        state={{ from: location.pathname + location.search }}
        className="font-medium text-brand underline underline-offset-2"
      >
        Sign in again
      </Link>{' '}
      to carry on. Nothing in your cart has been lost.
    </div>
  );
}

export function ServiceBanner(): React.JSX.Element | null {
  const { user, isLoading } = useSession();
  const trouble = useServiceTrouble();
  const [sessionJustEnded, setSessionJustEnded] = useState(false);

  // Announced once, when it happens. A customer who was never signed in should
  // not be told their session ended.
  useEffect(
    () =>
      onSessionEnded(() => {
        setSessionJustEnded(true);
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
        <span className="font-medium text-warning">The store is briefly unavailable.</span> We are
        working on it — your cart and orders are safe. Please try again in a few minutes.
      </div>
    );
  }

  if (trouble === 'unreachable') {
    return (
      <div role="status" className="bg-warning-soft px-4 py-2.5 text-center text-sm text-ink">
        <span className="font-medium text-warning">We are having trouble reaching the store.</span>{' '}
        Anything already on screen still works. Changes will not save until the connection is back.
      </div>
    );
  }

  return null;
}
