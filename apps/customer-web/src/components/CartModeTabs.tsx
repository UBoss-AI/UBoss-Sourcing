/**
 * Buy this now, or have it delivered again and again.
 *
 * Two ways to spend the same basket, and until now the second one was a link
 * in the summary panel that a buyer had to scroll past the whole cart to find.
 * Putting them side by side at the top of the cart is the honest shape: they
 * are alternatives, not a purchase and an afterthought.
 *
 * **Links, not a tab panel**, and the distinction is not pedantry. These lead
 * to two different routes — `/cart` and `/accounts/schedule` — so a real
 * `role="tablist"` would promise a screen reader that the content below swaps
 * in place, which it does not; the page navigates. A navigation region with
 * `aria-current="page"` on the one you are on says exactly what is true, and
 * it comes with working middle-click, open-in-new-tab and back button for
 * free. The segmented look is the same either way.
 *
 * **Nothing is removed by this.** Instant Buy is the cart the storefront
 * always had, on the same route, with the same checkout: it is the default
 * because it is what most people came for, and the tab merely names what was
 * previously unnamed.
 *
 * The row renders only where the second destination exists. A deployment with
 * recurring orders switched off has one way to spend a basket, and a tab
 * leading to a screen that explains it is switched off teaches the customer
 * that the navigation lies — the same rule `account-nav.ts` follows.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { animate, motion, useMotionValue } from 'motion/react';
import { CartIcon, RepeatIcon } from '@/components/icons';
import { cx } from '@/lib/cx';
import { usePrefersReducedMotion } from '@/lib/reduced-motion';
import { useStorefront } from '@/app/storefront-context';
import { useI18n } from '@/i18n/i18n-context';

/** Which of the two the current screen is. */
export type CartMode = 'instant' | 'schedule';

/** Where the schedule half of the cart lives. */
export const SCHEDULE_CART_PATH = '/accounts/schedule';

/*
 * The rubber thumb.
 *
 * A switch plays in two phases, the way a finger drags a pill: first both
 * edges stretch to cover the old tab and the new one together, then the
 * leading edge springs onto the new tab while the trailing edge follows,
 * overshoots by a few pixels and relaxes back. Edges that stretch, land and
 * squash read as one object moving, where a plain slide reads as a box being
 * repositioned.
 *
 * Each page mounts its own copy of this row, so the animation cannot run
 * across the navigation. It runs on the page being left, and the route
 * changes once the thumb has landed: `NAVIGATE_AFTER_MS` is long enough for
 * the landing to read and short enough that the click does not feel ignored.
 */
const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const SPRING_UI = { type: 'spring', duration: 0.3, bounce: 0 } as const;
const SPRING_RELAX = { type: 'spring', duration: 0.16, bounce: 0 } as const;
const STRETCH_SECONDS = 0.19;
const HANDOFF_MS = 150;
const SQUASH_PX = 3;
const NAVIGATE_AFTER_MS = 340;
/** `rounded-md`, so the clipped label layer has the pill's own corners. */
const THUMB_RADIUS_PX = 6;

interface Slot {
  l: number;
  r: number;
}

const MODES: readonly CartMode[] = ['instant', 'schedule'];

function tabClass(): string {
  return cx(
    // A generous hit area on a phone, where this is the first thing thumbed —
    // so the two split the width below `sm` and size to their own labels above
    // it. Left at `flex-1` throughout, a laptop gets two 700px pills, which
    // read as a pair of banners rather than as a choice between two tabs.
    'relative flex flex-1 items-center justify-center gap-2 rounded-md py-2.5 text-sm',
    'px-3 sm:flex-none sm:px-6',
    'font-medium',
  );
}

export function CartModeTabs({ current }: { current: CartMode }): React.JSX.Element | null {
  const { t } = useI18n();
  const { features } = useStorefront();
  const navigate = useNavigate();
  const reduced = usePrefersReducedMotion();

  const layerRef = useRef<HTMLDivElement>(null);
  const linkRefs = useRef<(HTMLAnchorElement | null)[]>([]);
  const slots = useRef<Slot[]>([]);
  const timers = useRef<number[]>([]);
  const leaving = useRef(false);
  const gen = useRef(0);

  // The thumb's two edges, in px from the start of the row's content box.
  const edgeL = useMotionValue(0);
  const edgeR = useMotionValue(0);
  const innerW = useRef(0);
  // Written by `sync`, not derived with `useTransform`: a derived value
  // subscribes after the first layout effect has already placed the edges,
  // so it kept its initial zero until something happened to move them.
  const width = useMotionValue(0);
  const clipPath = useMotionValue('inset(0 100% 0 0)');
  const sync = useRef(() => {
    const l = edgeL.get();
    const r = edgeR.get();
    width.set(Math.max(0, r - l));
    clipPath.set(
      `inset(0 ${Math.max(0, innerW.current - r)}px 0 ${Math.max(0, l)}px round ${THUMB_RADIUS_PX}px)`,
    );
  }).current;

  const index = MODES.indexOf(current);
  const enabled = features.recurringOrders;

  const tabs = [
    { mode: 'instant' as const, to: '/cart', icon: CartIcon, label: t('cartTabs.instantBuy') },
    {
      mode: 'schedule' as const,
      to: SCHEDULE_CART_PATH,
      icon: RepeatIcon,
      label: t('cartTabs.scheduleCart'),
    },
  ];

  // Measured, not computed: the labels are translated, so the two tabs are
  // as wide as their words in whichever of the eight languages is showing.
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    const measure = (): void => {
      const layer = layerRef.current;
      if (!layer) return;
      const box = layer.getBoundingClientRect();
      slots.current = linkRefs.current.map((el) => {
        if (!el) return { l: 0, r: 0 };
        const r = el.getBoundingClientRect();
        return { l: r.left - box.left, r: r.right - box.left };
      });
      innerW.current = box.width;
      const slot = slots.current[index];
      if (slot && !leaving.current) {
        edgeL.jump(slot.l);
        edgeR.jump(slot.r);
      }
      sync();
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (layerRef.current) observer.observe(layerRef.current);
    // Typed as always present; jsdom has none.
    if ('fonts' in document) void document.fonts.ready.then(measure);
    return () => {
      observer.disconnect();
    };
  }, [enabled, index, t, edgeL, edgeR, sync]);

  // Every frame of an animation repaints the pill and the label clip.
  useEffect(() => {
    const offL = edgeL.on('change', sync);
    const offR = edgeR.on('change', sync);
    return () => {
      offL();
      offR();
    };
  }, [edgeL, edgeR, sync]);

  useEffect(
    () => () => {
      timers.current.forEach((id) => {
        window.clearTimeout(id);
      });
      edgeL.stop();
      edgeR.stop();
    },
    [edgeL, edgeR],
  );

  if (!enabled) return null;

  const land = (to: number, dir: number): void => {
    const b = slots.current[to];
    if (!b) return;
    const g = ++gen.current;
    const [lead, leadTo, trail, trailTo] =
      dir > 0 ? [edgeR, b.r, edgeL, b.l] : [edgeL, b.l, edgeR, b.r];
    void animate(lead, leadTo, { ...SPRING_UI, velocity: lead.getVelocity() });
    void animate(trail, trailTo + dir * SQUASH_PX, {
      ...SPRING_UI,
      velocity: trail.getVelocity(),
    }).then(() => {
      if (gen.current === g) void animate(trail, trailTo, SPRING_RELAX);
    });
  };

  const travel = (from: number, to: number): void => {
    const a = slots.current[from];
    const b = slots.current[to];
    if (!a || !b) return;
    gen.current += 1;
    const tween = { duration: STRETCH_SECONDS, ease: EASE_OUT };
    void animate(edgeL, Math.min(a.l, b.l), tween);
    void animate(edgeR, Math.max(a.r, b.r), tween);
    timers.current.push(
      window.setTimeout(() => {
        land(to, Math.sign((b.l + b.r) / 2 - (a.l + a.r) / 2) || 1);
      }, HANDOFF_MS),
    );
  };

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>, to: number, path: string): void => {
    // Anything but a plain click keeps the link's own behaviour: open in a new
    // tab, copy the address, and so on.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
      return;
    }
    if (to === index) return;
    // Without movement, or before the row has been measured, the link
    // navigates on its own, still with the page transition where allowed.
    if (reduced || slots.current.length === 0) return;
    e.preventDefault();
    if (leaving.current) return;
    leaving.current = true;
    travel(index, to);
    timers.current.push(
      window.setTimeout(() => {
        void navigate(path, { viewTransition: true });
      }, NAVIGATE_AFTER_MS),
    );
  };

  return (
    <nav
      aria-label={t('cartTabs.label')}
      className="mb-6"
      // Lifted out of the page that fades, so the pill holds still while the
      // content beneath it changes. See `index.css`.
      style={{ viewTransitionName: 'cart-mode-tabs' }}
    >
      <div
        className={cx(
          // The sunken track under two pills, with the brand tint bled in from
          // the left. Subtle on purpose: this is a control, and a saturated
          // gradient behind a control competes with the thing it contains.
          'relative flex gap-1 rounded-lg border border-border bg-gradient-to-r from-brand-soft/60 to-surface-sunken p-1',
          'shadow-sunken',
          // Full width on a phone, hugging its content from `sm`.
          'w-full sm:inline-flex sm:w-auto',
        )}
      >
        {/* The pill itself, under the links: a raised, filled shape rather
            than a recoloured word, because "which of these am I in" is the
            only question this row answers. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-1">
          <motion.div
            className="absolute inset-y-0 left-0 rounded-md bg-surface shadow-card ring-1 ring-inset ring-border"
            style={{ x: edgeL, width }}
          />
        </div>

        {tabs.map((tab, i) => {
          const Icon = tab.icon;
          const isCurrent = tab.mode === current;
          return (
            <Link
              key={tab.mode}
              ref={(el) => {
                linkRefs.current[i] = el;
              }}
              to={tab.to}
              onClick={(e) => {
                handleClick(e, i, tab.to);
              }}
              className={cx(
                tabClass(),
                'text-ink-muted transition-colors motion-reduce:transition-none',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
                'focus-visible:ring-offset-surface-sunken',
                !isCurrent && 'hover:text-ink',
              )}
              {...(isCurrent ? { 'aria-current': 'page' as const } : {})}
            >
              <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
              {tab.label}
            </Link>
          );
        })}

        {/* The same two labels again in the selected colour, cut to the
            pill's shape. As the pill stretches over a word, that word turns
            brand-coloured exactly where the pill covers it, mid-letter. */}
        <motion.div
          ref={layerRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-1 flex gap-1 text-brand"
          style={{ clipPath }}
        >
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <span key={tab.mode} className={tabClass()}>
                <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />
                {tab.label}
              </span>
            );
          })}
        </motion.div>
      </div>

      {/* One line, because the difference between the two is worth a sentence
          and not a paragraph: one takes money today, the other takes it again
          on a date the customer chooses. */}
      <p className="mt-2 px-1 text-xs text-ink-muted">
        {current === 'instant' ? t('cartTabs.instantHint') : t('cartTabs.scheduleHint')}
      </p>
    </nav>
  );
}
