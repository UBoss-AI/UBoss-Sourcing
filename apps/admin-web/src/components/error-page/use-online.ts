/**
 * Whether the browser thinks it has a network, and a way to act the moment
 * it gets one back.
 *
 * `navigator.onLine` is a floor, not a promise: `false` reliably means there is
 * no network at all, while `true` only means an interface is up. So it is used
 * one way only — to say "you are offline" when the browser is certain — and
 * the page never concludes the server is fine because it says `true`.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);

  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
}

/**
 * Call `onReconnect` once each time the browser goes from offline to online.
 *
 * Driven by the `online` event and nothing else, so it cannot loop: a reload
 * that lands on the same error does not fire it again, only the next real
 * reconnection does. No timer, no polling.
 */
export function useOnReconnect(onReconnect: (() => void) | undefined): void {
  const latest = useRef(onReconnect);

  useEffect(() => {
    latest.current = onReconnect;
  }, [onReconnect]);

  useEffect(() => {
    const handle = (): void => {
      latest.current?.();
    };

    window.addEventListener('online', handle);

    return () => {
      window.removeEventListener('online', handle);
    };
  }, []);
}
