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
import { MarketSuggestionBanner } from '@/components/MarketSuggestionBanner';
import { cx } from '@/lib/cx';
import { AI_MODE_PATH } from '@/lib/ai-mode';
import { useChatViewportHeight } from '@/lib/chat-kit/viewport';
import { isMessagesPath } from '@/lib/preorder-chat';
import { Footer } from './Footer';
import { Header } from './Header';
import { useI18n } from '@/i18n/i18n-context';

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
  const { t } = useI18n();

  return (
    <div
      role="status"
      className="bg-warning-soft px-4 py-2.5 text-center text-sm font-medium text-warning"
    >
      {t('storeLayout.youAreOfflineYouCan')}
    </div>
  );
}

export function StoreLayout(): React.JSX.Element {
  const { t } = useI18n();

  const isOnline = useOnlineStatus();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  /*
   * AI Mode takes the whole frame under the header.
   *
   * The storefront's reading measure — `max-w-content`, with padding — is
   * right for a catalogue and wrong for a two-pane chat application: a
   * conversation sidebar inside a centred 80rem column with 16px gutters is a
   * page pretending to be an app. So this one route drops the measure, the
   * padding and the footer, and takes the remaining height instead.
   *
   * Height comes from the flex column rather than from a `calc()` against the
   * header: the header is two rows on a narrow screen and one on a wide one,
   * and every viewport-minus-a-guess is wrong on one of them. `min-h-0` is the
   * load-bearing half — without it a flex child refuses to shrink below its
   * content and the transcript scrolls the document instead of itself.
   */
  const isImmersive = location.pathname === AI_MODE_PATH;

  /*
   * Sign in and create-account take the full width under the header.
   *
   * The header stays — a customer who arrives at sign-in from a product page
   * must still be able to press the logo and go back. What they drop is the
   * reading measure and the gutters: the screens render a two-column split
   * with the globe on one half, and a split centred inside an 80rem column
   * with 16px padding either side is a split with a margin drawn down the
   * middle of it.
   *
   * From `lg` up they ALSO drop the document's scrollbar, and that is not
   * cosmetic. The globe beside the form was sliding up the screen as the page
   * scrolled, because a `sticky` item can only hold its place while its
   * container has room left under it and a one-viewport globe in a
   * one-viewport grid has none. What was pushing the document past a viewport
   * was this frame's own chrome — the header above and the footer below — so
   * the fix belongs here rather than in the split: the column is pinned to the
   * window's height, the space left under the header is handed to the split as
   * a definite height, and the split scrolls the FORM inside itself instead.
   *
   * Below `lg` none of it applies. The globe is not drawn at all there, the
   * document scrolls exactly as it always has, and the footer is where it was.
   *
   * Listed by path rather than asked of the page, because the decision belongs
   * to whatever draws the frame, and the frame is here.
   */
  const isFullBleed = location.pathname === '/login' || location.pathname === '/register';

  /*
   * The home page draws its own ground, edge to edge.
   *
   * The greeting used to be a rounded card inside the reading measure, and
   * `<main>`'s `py-6 sm:py-8` left a band of the body's sunken colour between
   * the header and the top of that card - the dark strip under the header
   * that nobody had asked for. The page now paints one backdrop behind all of
   * its sections and sets the measure and gutters on its own content, so
   * here it only needs the frame to get out of the way. See `HomePage`.
   */
  const isHome = location.pathname === '/';

  /*
   * Account -> Messages is an application pane, like AI Mode: the window's
   * height exactly, the document never scrolling, and ONE element inside -
   * the message history - scrolling instead.
   *
   * It used to be an ordinary page. The page was the header, the account
   * rail, a page heading, the list and a thread given a fixed `36rem` (or
   * `70dvh` on a phone) - taller than a laptop's window, so the DOCUMENT
   * scrolled: the history scrolled inside a page that also scrolled, the
   * composer started below the fold, and a wheel that reached the end of one
   * carried on into the other. Nothing inside the page could fix that; the
   * frame had to stop being taller than the window.
   *
   * The height is the visual viewport's where there is one (see
   * `lib/chat-kit/viewport.ts`), so a phone's keyboard shrinks the frame
   * instead of covering the composer.
   */
  const isAppPane = isMessagesPath(location.pathname);
  useChatViewportHeight(isAppPane);

  // A single-page app does not reload, so focus stays where it was and a
  // screen reader never learns the page changed. Moving focus to the main
  // region is what a full page load would have done.
  const previousPath = useRef(location.pathname);
  useEffect(() => {
    const from = previousPath.current;
    previousPath.current = location.pathname;
    // Moving between conversations is not a new page: the conversation
    // screen moves focus itself, and the document has nothing to scroll.
    if (from !== location.pathname && isMessagesPath(from) && isMessagesPath(location.pathname)) return;
    mainRef.current?.focus();
    // Scrolling to the top is what a page load does too. Without it, arriving
    // at a product from halfway down a category list starts mid-description.
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [location.pathname]);

  return (
    /*
     * `min-h-screen` everywhere except AI Mode, where it has to be an exact
     * `h-[100dvh]`.
     *
     * The difference is load bearing rather than cosmetic. `min-height` leaves
     * the column's height content-driven, so `flex-1` on `<main>` has no
     * leftover space to claim and the transcript grows the document instead of
     * scrolling inside itself — the composer then sits below the fold and the
     * page scrolls under a fixed header. A definite height is what gives
     * `flex-1` something to fill.
     *
     * `dvh` rather than `vh`: on a phone the two differ by the height of a
     * collapsing browser toolbar, and `vh` is the one that puts the Send button
     * under it.
     */
    <div
      className={cx(
        'flex flex-col',
        isImmersive ? 'h-[100dvh]' : isAppPane ? 'h-[var(--chat-viewport-height,100dvh)] overflow-hidden' : 'min-h-screen',
        // The signed-out screens, from `lg` up only: a window-height column
        // with nothing below it to scroll to, so the earth beside the form
        // holds still. `min-h-screen` stays for the narrow case underneath it.
        //
        // `overflow-hidden` goes with it, and is only safe BECAUSE the split
        // inside now caps itself at `max-h-[100dvh]` and scrolls the form
        // column internally. Nothing reachable can be clipped: a long
        // create-account form scrolls in its own column on any window, however
        // short. Without the clip, a stray pixel of overflow anywhere in the
        // subtree — a WebGL canvas's own absolutely positioned scaffolding
        // will do it — puts the document's scrollbar back, and a wheel over
        // the LEFT half then scrolls the page and takes the picture with it.
        // Which is the whole complaint.
        !isImmersive && isFullBleed && 'lg:h-[100dvh] lg:overflow-hidden',
      )}
    >
      <a href="#main" className="skip-link">
        {t('storeLayout.skipToContent')}
      </a>

      {/* Offline is the browser's own signal and takes precedence: if there
          is no connection at all, nothing else is worth reporting. */}
      {isOnline ? <ServiceBanner /> : <OfflineBanner />}

      <Header />

      {/* Asked once, on first sign-in. Renders nothing afterwards. */}
      <CountryPicker />

      {/* Offers the language's market to a shopper already quoted in another
          one. Under the header so the currency switcher it duplicates is in
          view right above it, and above the content because taking the offer
          reprices everything in that content. */}
      <MarketSuggestionBanner />

      <main
        id="main"
        ref={mainRef}
        tabIndex={-1}
        className={cx(
          'w-full flex-1 outline-none',
          isImmersive && 'min-h-0',
          // The reading measure stays; the height is the frame's, handed down
          // as a flex column so the pane inside has a definite height to fill.
          isAppPane &&
            'mx-auto flex min-h-0 max-w-content flex-col px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 sm:px-4 sm:pt-4 md:pb-4',
          // Full width and no padding of its own: the split inside supplies
          // both halves' gutters, and it needs the whole frame to divide.
          !isImmersive && !isAppPane && !isFullBleed && !isHome && 'mx-auto max-w-content px-4 py-6 sm:py-8',
          // `min-h-0` is the load-bearing half of the sentence above about the
          // sign-in screens: without it a flex child refuses to shrink below
          // its content, the split pushes the column past the window, and the
          // document scrolls again with the globe on board.
          isFullBleed && 'lg:min-h-0',
        )}
      >
        <Outlet />
      </main>

      {/* No footer under a full-height application pane: it would either be
          pushed off screen or steal the height the transcript needs. Every
          link in it is still one press away in the header.

          On the signed-out screens it is rendered and then hidden from `lg`
          up, which is the same reasoning one breakpoint narrower: the frame
          there is exactly the window, and a footer under it would be the one
          thing putting a scrollbar back on the document — and the scrollbar
          is what was taking the globe with it. On a phone, where there is no
          globe and the page scrolls normally, the footer is untouched. */}
      {!isImmersive && !isAppPane && <Footer className={cx(isFullBleed && 'lg:hidden')} />}
    </div>
  );
}
