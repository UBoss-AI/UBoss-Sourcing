/**
 * "Where are you signing in from?"
 *
 * Shown instead of the whole panel, the way the change-password screen is, and
 * for the same structural reason: while the session has no position the backend
 * answers 403 LOCATION_REQUIRED to every admin route, so a menu here would lead
 * only to a wall of failures. There is no skip, because there is nothing to
 * skip to.
 *
 * Why it is asked at all: a self-hosted console is shared by several staff
 * accounts and sits behind nothing but a password. Recording the place each
 * sign-in came from - and putting it in the bell where colleagues see it - is
 * what turns a sign-in nobody made into something somebody notices the same
 * day. It is evidence for people to read, never a lock: the backend asks that a
 * position was given and never decides anything from where it points.
 *
 * The prompt fires on mount rather than behind a button. Every browser allows
 * that, and the alternative - a screen asking you to press a button that
 * produces a second dialog asking the same thing - is two decisions where one
 * will do. The button is what a person who dismissed or blocked the first
 * prompt comes back to.
 *
 * Every failure is named separately, because the fix differs and none of them
 * is the reader's fault in the same way. Blocked is a browser setting; no fix
 * is a device with location services off; "this browser cannot" is almost
 * always an installation served over plain HTTP, where the Geolocation API does
 * not exist at all and no amount of clicking will help - so that message is
 * addressed to whoever runs the deployment, not to the person locked out.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from './session-context';
import { Button, Spinner } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { LanguageSwitcher } from '@/i18n/LanguageSwitcher';
import { ApiError, NetworkError, api } from '@/lib/api';

interface SessionLocationResponse {
  locationGranted: boolean;
  /** The geocoded place, or the coordinates when no geocoder answered. */
  place: string;
  recordedAt: string;
}

/**
 * How long to wait for the device before offering the retry.
 *
 * Generous on purpose: a laptop with no GPS falls back to a network lookup that
 * can genuinely take fifteen seconds on a cold start, and timing out at five
 * would teach people to press "try again" for a fix that was already on its
 * way.
 */
const POSITION_TIMEOUT_MS = 25_000;

/**
 * A fix from the last minute is accepted rather than forcing a fresh one. The
 * question this screen answers is "which place is this sign-in coming from",
 * and that does not change in sixty seconds - while insisting on a new fix adds
 * seconds to every single sign-in.
 */
const POSITION_MAX_AGE_MS = 60_000;

type Status =
  | { kind: 'requesting' }
  | { kind: 'submitting' }
  | { kind: 'recorded'; place: string }
  /** The browser or the person refused. Recoverable in site settings. */
  | { kind: 'denied' }
  /** The device has no answer to give - location services off, no signal. */
  | { kind: 'unavailable' }
  | { kind: 'timedOut' }
  /** No Geolocation API here at all. Almost always a non-HTTPS deployment. */
  | { kind: 'unsupported' }
  /** The position was obtained; posting it failed. */
  | { kind: 'failed'; message: string };

/**
 * Does this browser offer geolocation at all?
 *
 * `isSecureContext` is checked as well as the object, because Chrome keeps
 * `navigator.geolocation` present on an insecure origin and answers every call
 * with PERMISSION_DENIED. Without this the screen would tell somebody to change
 * a browser setting that would not help - the panel is on plain HTTP, and only
 * the operator can fix that.
 */
function geolocationAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator && window.isSecureContext;
}

function currentPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      // The place, not the doorstep. High accuracy wakes the GPS radio, costs
      // battery and seconds, and buys nothing for a line that reads "signed in
      // from Pune".
      enableHighAccuracy: false,
      timeout: POSITION_TIMEOUT_MS,
      maximumAge: POSITION_MAX_AGE_MS,
    });
  });
}

export function LocationGate(): React.JSX.Element {
  const { user, logout, refreshUser } = useSession();
  const { t } = useI18n();

  const [status, setStatus] = useState<Status>(() =>
    geolocationAvailable() ? { kind: 'requesting' } : { kind: 'unsupported' },
  );

  // StrictMode mounts effects twice in development, and two overlapping
  // permission prompts is a mess for anyone testing this locally. The ref also
  // stops a resolved promise writing state into an unmounted screen.
  const isMountedRef = useRef(true);
  const isRunningRef = useRef(false);

  /**
   * Read through a function rather than touching `.current` at each site.
   *
   * The ref is written by an effect cleanup while the awaits below are in
   * flight, which is precisely what these checks are for - but TypeScript's
   * narrowing does not know that and treats every check after the first as
   * dead. A call it cannot see through keeps each one honest.
   */
  const isMounted = (): boolean => isMountedRef.current;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const share = useCallback(async (): Promise<void> => {
    if (!geolocationAvailable()) {
      setStatus({ kind: 'unsupported' });
      return;
    }

    if (isRunningRef.current) return;
    isRunningRef.current = true;
    setStatus({ kind: 'requesting' });

    let position: GeolocationPosition;

    try {
      position = await currentPosition();
    } catch (error) {
      isRunningRef.current = false;
      if (!isMounted()) return;

      // GeolocationPositionError is not an Error subclass, so `instanceof` is
      // no use; the numeric codes are the contract.
      const code = (error as GeolocationPositionError | undefined)?.code;

      if (code === 1) setStatus({ kind: 'denied' });
      else if (code === 3) setStatus({ kind: 'timedOut' });
      else setStatus({ kind: 'unavailable' });
      return;
    }

    if (!isMounted()) {
      isRunningRef.current = false;
      return;
    }

    setStatus({ kind: 'submitting' });

    try {
      const result = await api.post<SessionLocationResponse>('/admin/auth/session/location', {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracyM: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
      });

      if (!isMounted()) return;
      setStatus({ kind: 'recorded', place: result.place });

      // The session object still says the panel is locked. Re-reading /me is
      // what unlocks it - and it reads the state the backend actually holds
      // rather than assuming the write landed.
      await refreshUser();
    } catch (error) {
      if (!isMounted()) return;

      const message =
        error instanceof NetworkError || error instanceof ApiError
          ? error.message
          : t('auth.location.failed');

      setStatus({ kind: 'failed', message });
    } finally {
      isRunningRef.current = false;
    }
  }, [refreshUser, t]);

  // Ask straight away. Somebody who has just typed a password is expecting one
  // more step, not a screen that waits to be told to start.
  useEffect(() => {
    void share();
  }, [share]);

  const isBusy = status.kind === 'requesting' || status.kind === 'submitting';

  const problem: string | null = (() => {
    switch (status.kind) {
      case 'denied':
        return t('auth.location.denied');
      case 'unavailable':
        return t('auth.location.unavailable');
      case 'timedOut':
        return t('auth.location.timedOut');
      case 'unsupported':
        return t('auth.location.unsupported');
      case 'failed':
        return status.message;
      default:
        return null;
    }
  })();

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-sunken px-4 py-10">
      <div className="w-full max-w-sm">
        {/* The same reasoning as on the sign-in and change-password screens:
            this is a hard gate, so the language picker has to be reachable
            from it or somebody who cannot read the panel is stuck at it. */}
        <LanguageSwitcher placement="auth" />

        <div className="mb-6 flex flex-col items-center text-center">
          <span
            aria-hidden="true"
            className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white"
          >
            U
          </span>
          <h1 className="text-lg font-semibold tracking-tight text-ink">
            {t('auth.location.heading')}
          </h1>
          <p className="mt-1 text-sm text-ink-muted">{t('auth.location.intro')}</p>
          {user !== null && (
            <p className="mt-1 text-xs text-ink-subtle">
              {t('auth.location.signedInAs', { email: user.email })}
            </p>
          )}
        </div>

        <div className="space-y-4 rounded-lg border border-border bg-surface p-6 shadow-card">
          {problem !== null && (
            <div
              role="alert"
              className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
            >
              {problem}
            </div>
          )}

          {isBusy && (
            <div className="flex items-center gap-2.5 text-sm text-ink-muted">
              <Spinner className="h-4 w-4 shrink-0 text-ink-subtle" />
              <span role="status">
                {status.kind === 'requesting'
                  ? t('auth.location.requesting')
                  : t('auth.location.submitting')}
              </span>
            </div>
          )}

          {/* Between the successful post and `refreshUser` resolving, this
              screen is still the one on show. Saying what was recorded beats a
              spinner that looks like nothing happened. */}
          {status.kind === 'recorded' && (
            <p role="status" className="text-sm text-ink">
              {t('auth.location.recorded', { place: status.place })}
            </p>
          )}

          {status.kind === 'requesting' && (
            <p className="text-xs leading-relaxed text-ink-muted">{t('auth.location.prompt')}</p>
          )}

          {/* Nothing to retry on a browser that has no geolocation to give -
              only the operator can change that, so the button would be a lie. */}
          {!isBusy && status.kind !== 'recorded' && status.kind !== 'unsupported' && (
            <Button variant="primary" className="w-full" onClick={() => void share()}>
              {status.kind === 'denied'
                ? t('auth.location.allow')
                : t('common.retry')}
            </Button>
          )}

          <p className="text-xs leading-relaxed text-ink-subtle">{t('auth.location.why')}</p>

          {/* A way out for somebody who will not or cannot share it. Signing
              out is better than leaving them on a dead screen with the session
              still open in the browser. */}
          <p className="text-center">
            <button
              type="button"
              onClick={() => void logout()}
              className="rounded text-sm font-medium text-accent underline-offset-2 transition-colors hover:text-accent-hover hover:underline"
            >
              {t('auth.location.signOut')}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
