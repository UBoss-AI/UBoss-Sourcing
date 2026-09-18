/**
 * The greeting page's search module.
 *
 * It opens as a pill — a magnifier and four words — and unfolds on a press
 * into one large search bar with a two-item row above it. Unfolding is the
 * gooey transition from `ui/gooey-input.tsx`: the pill stretches into the bar
 * while a round bubble pinches off its left end, the two joined by a neck that
 * thins and breaks. The bubble is not decoration once it has landed; it is the
 * Search button.
 *
 * **Why the bar is not simply there.** A page that opens on a full search bar,
 * a row of tabs, a camera, a microphone and a legal notice asks somebody to
 * read six things before they have decided they want any of them. The pill
 * asks one question, and everything else arrives when the answer is yes. What
 * that costs is honest and worth writing down: the AI Mode link and the
 * catalogue field are one press further away than they were, and neither is
 * visible to somebody who never presses. It buys a greeting that opens on one
 * clear invitation instead of a control panel.
 *
 * The row looks like two tabs and is not two tabs, because the two items are
 * different kinds of thing:
 *
 *   - **Products** is where you already are. The bar under it searches the
 *     catalogue: submitting goes to `/products?q=`, the browse-all page with a
 *     term applied, so the filters, facets, pagination and category structure
 *     that already exist are the ones the results arrive in. Submitting an
 *     empty box goes to the same page with no term, which is the whole
 *     catalogue. Nothing here renders a result — this module hands off, and
 *     the catalogue page owns what a result looks like. Being the current item
 *     is also what puts the greeting page's product list below the fold, and
 *     since it is always the current item on this page, that list is always
 *     there.
 *   - **AI Mode** is a **link to another page**, and pressing it goes straight
 *     there. It used to switch the bar into an "ask a question" mode and
 *     navigate on submit, which meant two presses to reach a page that is
 *     better at asking questions than a one-line bar with a Search button
 *     could ever be — AI Mode has a composer, a transcript and a conversation
 *     list. So the row now does the honest thing: the item that leads
 *     somewhere leads there on press.
 *
 * **Whatever is typed travels with them.** Pressing AI Mode with words in the
 * box parks them for the AI page to pick up, with intent `compose` — they land
 * in the composer ready to edit rather than being asked on arrival, because
 * switching to AI Mode is not the same act as pressing Search. See
 * `lib/ai-mode.ts` for why that is `sessionStorage` and not a query parameter.
 *
 * **So there is no `role="tablist"` here, and there was.** A tablist promises
 * that its items switch panels within the page and that arrow keys move
 * between them; one of these two items leaves the page. Announcing navigation
 * as tab selection is the kind of ARIA that makes a screen reader describe a
 * control that no longer exists. What is left is a labelled row with the
 * current item marked `aria-current` and the other one a link.
 *
 * The AI Mode item is absent, rather than disabled, on a deployment with no AI
 * provider configured. The bar is then a search bar with nothing above it,
 * which is the honest shape for that deployment — the same rule the rest of
 * the storefront follows for a capability the operator has not switched on.
 *
 * ---
 *
 * WHEN IT FOLDS BACK UP
 *
 * On `Escape`, and when focus leaves the whole module with the box empty.
 * Three things about that rule are deliberate:
 *
 *   - **The box being empty is the condition.** Folding a bar that somebody has
 *     typed into throws their words away, and they would have to be typed
 *     again to find out that is what happened.
 *   - **It is the module that has to lose focus, not the field.** The field
 *     loses focus every time somebody reaches for the camera or the microphone
 *     beside it, and a module that folded on that would make both buttons
 *     unclickable — the control would move out from under the pointer between
 *     the press starting and landing.
 *   - **An open image dialog holds it open.** Opening the dialog moves focus
 *     into it, and the dialog is outside this module, so without the guard the
 *     bar would fold behind its own dialog and the customer would be returned
 *     to a pill when they closed it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Link, useNavigate } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { CameraIcon, CloseIcon, MicIcon, SearchIcon, SparkIcon } from '@/components/icons';
import { Spinner } from '@/components/ui';
import { GooeyFilter } from '@/components/ui/gooey-input';
import { GOOEY_SPRING, useGooeyFilterId } from '@/components/ui/gooey';
import { cx } from '@/lib/cx';
import { usePrefersReducedMotion } from '@/lib/reduced-motion';
import { AI_MODE_PATH, setPendingQuestion } from '@/lib/ai-mode';
import { useVoiceSearch } from '@/lib/voice-search';
import { useI18n } from '@/i18n/i18n-context';
import { languageOption } from '@/i18n/languages';
import { ImageSearchDialog } from './ImageSearchDialog';

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

/** The shared type of the two items, so they cannot drift apart visually. */
const ITEM_CLASS =
  'relative inline-flex items-center gap-1.5 rounded-sm pb-2.5 text-lg font-semibold tracking-tight transition-colors sm:text-xl';

/**
 * AI Mode, then a hairline, then Products.
 *
 * **The underline is a child of the current item, not a measured element that
 * slides.** It used to be the latter, because the selection moved between two
 * items of different widths in eight languages and arithmetic could not place
 * it. Nothing moves any more — Products is always the current item on this
 * page — so the underline is a `span` inside it, which is exact in every
 * language for free and takes a `ResizeObserver`, a `document.fonts.ready`
 * handler and a layout effect out of the module.
 */
function SearchModes({ onLeaveForAi }: { onLeaveForAi: () => void }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <nav
      aria-label={t('heroSearch.modesLabel')}
      className="flex items-end gap-4 border-b border-transparent sm:gap-5"
    >
      {/* AI Mode on the left, where it has been since the row was two tabs.
          The current item being second is not an accident to tidy up: this is
          the order somebody has learned, and the underline is what says where
          they are. */}
      <Link
        to={AI_MODE_PATH}
        onClick={onLeaveForAi}
        // Full-strength ink, not grey. This is a real thing a visitor is being
        // offered, and a greyed one reads as unavailable rather than as
        // not-current — the underline and the brand colour are what say which
        // of the two you are on.
        className={cx(ITEM_CLASS, 'text-ink hover:text-brand')}
      >
        {t('heroSearch.aiMode')}
        <SparkIcon className="h-4 w-4 shrink-0 text-ink-subtle transition-colors" />
      </Link>

      {/* A hairline between the two, not a gap doing the same job at a
          distance. With two items of very different widths — and eight
          languages' worth of both — space alone stops reading as a separation
          and starts reading as an accident. */}
      <span aria-hidden="true" className="mb-3.5 h-5 w-px bg-border" />

      <span aria-current="true" className={cx(ITEM_CLASS, 'text-brand')}>
        {t('heroSearch.products')}
        <span
          aria-hidden="true"
          className="absolute bottom-0 left-0 right-0 h-[3px] rounded-full bg-brand"
        />
      </span>
    </nav>
  );
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

/**
 * Room the bubble needs at the left of the bar once it has pinched off.
 *
 * A margin rather than padding, so the bar genuinely starts to the right of
 * the bubble with a gap between them. Padding would have left the two
 * overlapping, and two overlapping shapes under this filter are one shape —
 * there would be nothing for the neck to break.
 */
const BUBBLE_LANE = 'ml-[4.5rem]';

export function HeroSearch(): React.JSX.Element {
  const { t, language } = useI18n();
  const navigate = useNavigate();
  const { features } = useStorefront();
  const reduced = usePrefersReducedMotion();

  const hasAi = features.assistant;
  const hasImageSearch = features.imageSearch === true;

  const [isOpen, setIsOpen] = useState(false);
  // True from the press until the spring has settled. The gooey filter is
  // mounted for exactly that window — an SVG filter left over a live text
  // field re-runs on every keystroke and costs the text its subpixel
  // antialiasing. `ui/gooey-input.tsx` carries the long version.
  const [isMorphing, setIsMorphing] = useState(false);
  const [term, setTerm] = useState('');
  const [isNavigating, setIsNavigating] = useState(false);
  const [isImageDialogOpen, setIsImageDialogOpen] = useState(false);

  const moduleRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pillRef = useRef<HTMLButtonElement>(null);

  const filterId = useGooeyFilterId('hero-search-goo');
  const panelId = `${filterId}-panel`;

  /*
   * The filter comes off on a timer as well as on the animation finishing.
   *
   * `onLayoutAnimationComplete` is the ordinary way out, and it does not fire
   * when motion decides there was no layout change to animate — which is the
   * case in any environment that reports every box as zero, jsdom among them.
   * Without this the filter would be mounted for the rest of the visit, and a
   * live text field under an SVG filter repaints on every keystroke.
   */
  useEffect(() => {
    if (!isMorphing) return undefined;

    const timer = window.setTimeout(() => {
      setIsMorphing(false);
    }, 600);

    return () => {
      window.clearTimeout(timer);
    };
  }, [isMorphing]);

  const open = useCallback(() => {
    setIsOpen(true);
    if (!reduced) setIsMorphing(true);
    // The field is mounted by this same render, so focus waits for it.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [reduced]);

  const close = useCallback(() => {
    setIsOpen(false);
    if (!reduced) setIsMorphing(true);
    requestAnimationFrame(() => {
      pillRef.current?.focus();
    });
  }, [reduced]);

  /*
   * A transcript is appended, not assigned.
   *
   * Somebody who typed "syringe" and then said "18 gauge" means both. Assigning
   * would silently discard the half they typed, which is the failure people
   * describe as "it deleted what I wrote".
   */
  const appendTranscript = useCallback((text: string) => {
    setTerm((current) => (current.trim().length === 0 ? text : `${current.trim()} ${text}`));
    inputRef.current?.focus();
  }, []);

  const voice = useVoiceSearch({
    // The interface language decides what the engine expects to hear. A Polish
    // reader dictating into an `en-GB` recogniser gets nonsense.
    language: languageOption(language).intlLocale,
    onTranscript: appendTranscript,
  });

  /*
   * Submitting only ever means one thing now: search the catalogue.
   *
   * An empty term is not an error and not a no-op — it is "show me
   * everything", and the catalogue page with no `q` is exactly that.
   */
  const submit = (): void => {
    const query = term.trim();
    void navigate(query.length === 0 ? '/products' : `/products?q=${encodeURIComponent(query)}`);
  };

  /*
   * Leaving for AI Mode, with whatever is in the box.
   *
   * `compose`, not `send`: they pressed a link to a different page, not
   * Search, so the words land in the composer for them to finish rather than
   * being asked on their behalf. An empty box parks nothing — see
   * `setPendingQuestion`.
   *
   * The spinner is set because the AI page is a lazy route: on a slow
   * connection the chunk takes a moment, and a link that visibly does nothing
   * gets pressed again.
   */
  const leaveForAi = (): void => {
    setPendingQuestion(term, 'compose');
    setIsNavigating(true);
  };

  /** See WHEN IT FOLDS BACK UP in the header for all three conditions. */
  const handleModuleBlur = (event: React.FocusEvent<HTMLDivElement>): void => {
    if (!isOpen || term.length > 0 || isImageDialogOpen) return;
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setIsOpen(false);
    if (!reduced) setIsMorphing(true);
  };

  /*
   * Escape folds it back up, from wherever inside it focus happens to be.
   *
   * Subscribed on the element rather than written as an `onKeyDown` prop,
   * because a `div` carrying a keyboard handler is a static element pretending
   * to be an interactive one — `jsx-a11y/no-static-element-interactions` is an
   * error here, and it is right: the handler is not this element's behaviour,
   * it is a shortcut that happens to be scoped to its subtree. Every control
   * that can hold focus in here is a real button, link or field already.
   */
  useEffect(() => {
    const module = moduleRef.current;
    if (module === null || !isOpen) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };

    module.addEventListener('keydown', onKeyDown);

    return () => {
      module.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, close]);

  const isListening = voice.status === 'listening' || voice.status === 'starting';

  return (
    <div ref={moduleRef} className="mt-8 w-full max-w-2xl" onBlur={handleModuleBlur}>
      {isMorphing && <GooeyFilter filterId={filterId} blur={6} />}

      {/* One item is not a row. With no AI provider configured the module is a
          search bar, and a row above it would be a label pretending to be a
          choice. */}
      <AnimatePresence initial={false}>
        {isOpen && hasAi && (
          <motion.div
            initial={reduced ? false : { opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            // Aligned with the bar rather than with the module, so the row sits
            // over the field and not over the bubble's lane.
            className={BUBBLE_LANE}
          >
            <SearchModes onLeaveForAi={leaveForAi} />
          </motion.div>
        )}
      </AnimatePresence>

      {/*
       * The gooey layer. Everything inside it is subject to the filter while
       * the module is morphing, which is why the dialog, the live region and
       * the notice are all outside: a filter creates a containing block, and a
       * `<dialog>` under one stops being positioned against the viewport.
       */}
      <div
        className="relative"
        style={isMorphing ? { filter: `url(#${filterId})` } : undefined}
      >
        <motion.div
          // `layout` rather than an animated width: the pill is sized by its
          // own text in eight languages and the bar is sized by its container,
          // so there is no pair of numbers to interpolate between. Motion
          // measures both and animates the difference.
          layout={!reduced}
          transition={reduced ? { duration: 0 } : GOOEY_SPRING}
          onLayoutAnimationComplete={() => {
            setIsMorphing(false);
          }}
          className={cx(
            'bg-surface shadow-lift transition-[border-color,box-shadow]',
            isOpen
              ? cx(
                  'rounded-2xl border-2 border-brand/25 focus-within:border-brand focus-within:shadow-card-hover hover:border-brand/40',
                  BUBBLE_LANE,
                )
              : 'w-fit rounded-full border-2 border-brand/25 hover:border-brand/40',
          )}
        >
          {isOpen ? (
            <form
              id={panelId}
              role="search"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
              /*
               * The bar. A two-row box rather than a single line, which is what
               * gives the controls under it room to be labelled instead of being
               * a row of unexplained glyphs.
               *
               * `focus-within` rather than a focus ring on the input: the input
               * has no border of its own, so the box is what has to respond, and
               * it has to respond to any of the controls inside it taking focus.
               * It is set on the box above, which is the element with the border.
               */
              className="p-1.5"
            >
              <div className="flex items-center gap-1 px-3 pt-2.5">
                <label htmlFor="hero-search-input" className="sr-only">
                  {t('heroSearch.placeholderProducts')}
                </label>
                <input
                  id="hero-search-input"
                  ref={inputRef}
                  // `text`, not `search`: `type=search` gives WebKit its own
                  // clear button, and two crosses in one field is one too many.
                  type="text"
                  value={term}
                  onChange={(event) => {
                    setTerm(event.target.value);
                  }}
                  placeholder={t('heroSearch.placeholderProducts')}
                  autoComplete="off"
                  enterKeyHint="search"
                  maxLength={300}
                  className="min-w-0 flex-1 bg-transparent py-1.5 text-base text-ink outline-none placeholder:text-ink-subtle"
                />

                {term.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setTerm('');
                      inputRef.current?.focus();
                    }}
                    aria-label={t('heroSearch.clear')}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-ink-subtle transition-colors hover:bg-surface-hover hover:text-ink"
                  >
                    <CloseIcon className="h-4 w-4" />
                  </button>
                )}
              </div>

              <div className="mt-1 flex items-center justify-between gap-2 px-2 pb-1.5">
                {/* Left: the ways of searching that are not typing. */}
                <div className="flex min-w-0 items-center gap-1">
                  {hasImageSearch && (
                    <button
                      type="button"
                      onClick={() => {
                        setIsImageDialogOpen(true);
                      }}
                      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-sm font-medium text-ink-muted transition-colors hover:bg-brand-soft hover:text-brand"
                    >
                      <CameraIcon className="h-[1.15rem] w-[1.15rem] shrink-0" />
                      {/* The label is hidden on the narrowest screens, where the
                          bar has to hold four controls. The accessible name comes
                          from the `sr-only` span, so it never disappears. */}
                      <span className="hidden sm:inline">{t('heroSearch.imageSearch')}</span>
                      <span className="sr-only sm:hidden">{t('heroSearch.imageSearch')}</span>
                    </button>
                  )}

                  {voice.isSupported && (
                    <button
                      type="button"
                      onClick={() => {
                        if (isListening) voice.stop();
                        else voice.start();
                      }}
                      aria-pressed={isListening}
                      aria-label={isListening ? t('voice.stopListening') : t('voice.startListening')}
                      className={cx(
                        'relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors',
                        isListening
                          ? 'bg-danger-fill text-white'
                          : 'text-ink-muted hover:bg-brand-soft hover:text-brand',
                      )}
                    >
                      <MicIcon className="h-[1.15rem] w-[1.15rem]" />
                      {/* The pulse is a sibling ring, not an animation on the
                          button: animating the button itself would move the icon,
                          and it is switched off wholesale by reduced motion. */}
                      {isListening && (
                        <span
                          aria-hidden="true"
                          className="absolute inset-0 animate-ping rounded-full bg-danger/40"
                        />
                      )}
                    </button>
                  )}
                </div>

                {/*
                 * There is no second Search button here, and there was a
                 * filled one. The bubble that pinches off the bar's left end
                 * IS the submit: two controls with the same name doing the
                 * same thing is one of them that somebody has to rule out
                 * first, and the round one is where this module's motion has
                 * just put the eye. Enter still submits, as it always did.
                 */}
              </div>
            </form>
          ) : (
            <button
              ref={pillRef}
              type="button"
              aria-expanded={false}
              aria-controls={panelId}
              onClick={open}
              className="inline-flex items-center gap-3 rounded-full py-3.5 pl-5 pr-7 text-left outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-fill text-white">
                <SearchIcon className="h-4 w-4" />
              </span>
              <span className="text-base font-medium text-ink sm:text-lg">
                {t('heroSearch.placeholderProducts')}
              </span>
            </button>
          )}
        </motion.div>

        {/*
         * The bubble that pinches off the bar's left end, and then stays as the
         * Search button.
         *
         * It is a real control rather than an ornament, which is the whole
         * reason it is allowed to remain on screen: a round blob that detaches,
         * travels and then does nothing is an animation with a leftover.
         */}
        <AnimatePresence initial={false}>
          {isOpen && (
            <motion.button
              type="button"
              onClick={submit}
              disabled={isNavigating}
              aria-label={t('heroSearch.search')}
              initial={reduced ? false : { scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={reduced ? { opacity: 0 } : { scale: 0, opacity: 0 }}
              transition={reduced ? { duration: 0 } : GOOEY_SPRING}
              /*
               * The half-height shift is motion's, not Tailwind's.
               *
               * A `-translate-y-1/2` class on an element motion is animating
               * loses: motion writes the whole `transform` inline from the
               * values it is tracking, and a class it does not know about is
               * simply overwritten. The bubble then hangs half its own height
               * below the bar — which is exactly how it looked.
               */
              style={{ y: '-50%' }}
              className="absolute left-0 top-1/2 flex h-14 w-14 items-center justify-center rounded-full bg-brand-fill text-white shadow-card outline-none transition-colors hover:bg-brand-fill-hover focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:bg-ink-subtle"
            >
              {isNavigating ? <Spinner className="h-5 w-5" /> : <SearchIcon className="h-5 w-5" />}
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/*
       * The live region for dictation.
       *
       * One node that is always in the DOM, rather than one that appears when
       * something happens: a live region added to the page at the same moment
       * as its content is frequently not announced at all, because the
       * assistive technology never saw it empty.
       */}
      <div role="status" aria-live="polite" className="mt-2 min-h-5 px-1 text-xs">
        {voice.status === 'starting' && (
          <span className="text-ink-muted">{t('voice.allowMicrophone')}</span>
        )}
        {voice.status === 'listening' && (
          <span className="font-medium text-danger">
            {t('voice.listening')}
            {voice.interim.length > 0 && (
              <span className="ml-1.5 font-normal italic text-ink-muted">{voice.interim}</span>
            )}
          </span>
        )}
        {voice.status === 'idle' && voice.errorKey !== null && (
          <span className="text-danger">{t(voice.errorKey)}</span>
        )}
      </div>

      {/* The AI disclosure, where the AI is. AI Act Art. 50(1) is about telling
          somebody before they engage, and the moment they might engage is the
          moment the AI Mode link is in front of them — which is the moment the
          bar is open, and not before. */}
      {isOpen && hasAi && (
        <p className="mt-1 px-1 text-xs leading-relaxed text-ink-muted">{t('heroSearch.aiNotice')}</p>
      )}

      {/* Mounted only while open. A closed `<dialog>` in this design system is
          still `display: flex` — the Modal sets it for its own column layout —
          so it would otherwise sit visible under the search bar. Every other
          Modal in the storefront is mounted the same way. */}
      {hasImageSearch && isImageDialogOpen && (
        <ImageSearchDialog
          isOpen
          onClose={() => {
            setIsImageDialogOpen(false);
          }}
        />
      )}
    </div>
  );
}
