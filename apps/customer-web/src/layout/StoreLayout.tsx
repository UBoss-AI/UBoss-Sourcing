/**
 * The storefront shell.
 *
 * Carries three global states that must never lose a customer's progress:
 *
 *   - **Offline.** A banner, not a blocking screen. The pages already
 *     rendered stay readable, and a cart being edited keeps its typed
 *     quantities — replacing the page would throw that away for a condition
 *     that often lasts seconds.
 *   - **Maintenance / backend down.** Also a banner, driven by 503s the API
 *     client surfaces.
 *   - **Route changes.** Focus moves to `<main>`, because a single-page app
 *     never reloads and a screen reader would otherwise never learn the page
 *     changed.
 */
import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { ServiceBanner } from '@/app/ServiceBanner';
import { CountryPicker } from '@/components/CountryPicker';
import { Footer } from './Footer';
import { Header } from './Header';

/** True while the browser reports no connectivity. */
function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState(
    () => typeof navigator === 'undefined' || navigator.onLine,
  );

  useEffect(() => {
    const goOnline = (): void => {
      setIsOnline(true);
    };
    const goOffline = (): void => {
      setIsOnline(false);
    };

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);

    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  return isOnline;
}

function OfflineBanner(): React.JSX.Element {
  return (
    <div
      role="status"
      className="bg-warning-soft px-4 py-2.5 text-center text-sm font-medium text-warning"
    >
      You are offline. You can keep browsing what has already loaded — changes will not be saved
      until you reconnect.
    </div>
  );
}

export function StoreLayout(): React.JSX.Element {
  const isOnline = useOnlineStatus();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  // A single-page app does not reload, so focus stays where it was and a
  // screen reader never learns the page changed. Moving focus to the main
  // region is what a full page load would have done.
  useEffect(() => {
    mainRef.current?.focus();
    // Scrolling to the top is what a page load does too. Without it, arriving
    // at a product from halfway down a category list starts mid-description.
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [location.pathname]);

  return (
    <div className="flex min-h-screen flex-col">
      <a href="#main" className="skip-link">
        Skip to content
      </a>

      {/* Offline is the browser's own signal and takes precedence: if there
          is no connection at all, nothing else is worth reporting. */}
      {isOnline ? <ServiceBanner /> : <OfflineBanner />}

      <Header />

      {/* Asked once, on first sign-in. Renders nothing afterwards. */}
      <CountryPicker />

      <main
        id="main"
        ref={mainRef}
        tabIndex={-1}
        className="mx-auto w-full max-w-content flex-1 px-4 py-6 outline-none sm:py-8"
      >
        <Outlet />
      </main>

      <Footer />
    </div>
  );
}
