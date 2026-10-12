/**
 * Every in-page tab switch moves, in every app, without each tab row asking.
 *
 * The cart's two tabs (`CartModeTabs.tsx`) set the standard: the selected
 * pill stretches over the old and the new tab, springs onto the new one, and
 * the content under it changes softly rather than snapping. This app has
 * some twenty tab rows, drawn by half a dozen components in three styles
 * (sunken segmented pills, underlined tabs, filter chips). Rebuilding each
 * one around a measured motion thumb is a rule the next tab row forgets, so
 * this module watches the document instead and animates any `role="tablist"`
 * whose selection moves, whatever drew it and wherever its state lives
 * (component state, or `?tab=` in the address bar).
 *
 * **How the pill glides.** Tabs already mark the selected one with
 * `aria-selected="true"`, so a MutationObserver sees the old tab lose it and
 * the new one gain it in the same commit, before the browser paints. A ghost
 * is laid under the row wearing the new tab's own selected look (background,
 * border, underline, shadow, corners, all copied from its computed style),
 * and that ghost travels from the old tab's box to the new one in the cart's
 * two phases: stretch across both, then land with a few pixels of squash.
 * The new tab's own background is held transparent while the ghost is in
 * flight, so there is one pill on screen, not two.
 *
 * **How the content changes.** The panel the tab controls (`aria-controls`,
 * else the nearest `role="tabpanel"`, else whatever sits straight after the
 * row) fades in and slides a few pixels from the side the tab moved towards.
 *
 * Nothing here changes what the tabs do: no state, no focus, no ARIA. Under
 * `prefers-reduced-motion`, in a background tab, or where the browser has no
 * Web Animations (jsdom) the switch is the ordinary instant one.
 *
 * Page changes are a separate mechanism: `page-transitions.ts`.
 *
 * Kept identical in all four apps.
 */

const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
/** The pill's whole journey: stretch, land, squash, relax. */
const GLIDE_MS = 420;
/** The content's fade, the same length as a page change's. */
const PANEL_MS = 260;
const PANEL_SHIFT_PX = 12;
const SQUASH_PX = 3;

const COPIED = [
  'backgroundColor',
  'backgroundImage',
  'boxShadow',
  'borderTopLeftRadius',
  'borderTopRightRadius',
  'borderBottomLeftRadius',
  'borderBottomRightRadius',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderTopStyle',
  'borderRightStyle',
  'borderBottomStyle',
  'borderLeftStyle',
  'borderTopColor',
  'borderRightColor',
  'borderBottomColor',
  'borderLeftColor',
] as const;

/** What the new tab wears while the ghost wears its look for it. */
const HELD: Record<string, string> = {
  'background-color': 'transparent',
  'background-image': 'none',
  'box-shadow': 'none',
  'border-color': 'transparent',
  transition: 'none',
};

interface Box {
  l: number;
  t: number;
  w: number;
  h: number;
}

function reducedMotion(): boolean {
  // Typed as always present; jsdom has none.
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

function isSelected(el: Element): boolean {
  return el.getAttribute('aria-selected') === 'true';
}

/** A tab's border box, in the tablist's scrolled padding-box coordinates. */
function boxIn(list: HTMLElement, el: Element): Box {
  const outer = list.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return {
    l: r.left - outer.left - list.clientLeft + list.scrollLeft,
    t: r.top - outer.top - list.clientTop + list.scrollTop,
    w: r.width,
    h: r.height,
  };
}

/** Holds inline styles for the length of an animation, then puts them back. */
function hold(el: HTMLElement, styles: Record<string, string>): () => void {
  const before = Object.keys(styles).map(
    (name) => [name, el.style.getPropertyValue(name), el.style.getPropertyPriority(name)] as const,
  );
  for (const [name, value] of Object.entries(styles)) el.style.setProperty(name, value);
  return () => {
    for (const [name, value, priority] of before) {
      if (value) el.style.setProperty(name, value, priority);
      else el.style.removeProperty(name);
    }
  };
}

/** The glide in flight on each row, so a quick second click restarts it cleanly. */
const inFlight = new WeakMap<HTMLElement, () => void>();

function glide(list: HTMLElement, from: HTMLElement, to: HTMLElement, dir: number): void {
  const a = boxIn(list, from);
  const b = boxIn(list, to);
  if (b.w === 0 || a.w === 0) return;

  // A tab's own `transition-colors` would still be at its start, so its
  // computed look would be the unselected one. Switched off first, the look
  // read is where the transition was heading.
  const releaseTransition = hold(to, { transition: 'none' });
  const look = getComputedStyle(to);
  const ghost = document.createElement('div');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.dataset.tabGhost = '';
  const gs = ghost.style;
  for (const prop of COPIED) gs[prop] = look[prop];
  Object.assign(gs, {
    position: 'absolute',
    boxSizing: 'border-box',
    pointerEvents: 'none',
    zIndex: '-1',
    margin: '0',
    left: `${b.l}px`,
    top: `${b.t}px`,
    width: `${b.w}px`,
    height: `${b.h}px`,
  });

  // The ghost sits under the tabs and over the row's own track: a stacking
  // context on the row keeps `z-index: -1` from falling behind the page.
  const listStyle: Record<string, string> = { isolation: 'isolate' };
  if (getComputedStyle(list).position === 'static') listStyle.position = 'relative';
  const releaseList = hold(list, listStyle);
  const heldLook = hold(to, HELD);
  const releaseTo = (): void => {
    heldLook();
    // Flushed while transitions are still off, so the look comes back at
    // once instead of fading in after the ghost has gone.
    getComputedStyle(to).getPropertyValue('background-color');
    releaseTransition();
  };
  // The old tab drops its look at once, rather than fading it out under the
  // ghost that is already leaving.
  const releaseFrom = hold(from, { transition: 'none' });
  list.prepend(ghost);

  const frame = (l: number, t: number, w: number, h: number, offset?: number): Keyframe => ({
    left: `${l}px`,
    top: `${t}px`,
    width: `${w}px`,
    height: `${h}px`,
    ...(offset === undefined ? {} : { offset }),
  });

  // On one row: stretch over both, then the leading edge lands and the
  // trailing edge overshoots by a few pixels and relaxes. Across rows of a
  // wrapped row of chips a stretch would cover the tabs between, so it moves.
  const sameRow = Math.abs(a.t - b.t) < 2;
  const frames: Keyframe[] = sameRow
    ? [
        frame(a.l, a.t, a.w, a.h, 0),
        frame(
          Math.min(a.l, b.l),
          b.t,
          Math.max(a.l + a.w, b.l + b.w) - Math.min(a.l, b.l),
          b.h,
          0.42,
        ),
        dir > 0
          ? frame(b.l + SQUASH_PX, b.t, b.w - SQUASH_PX, b.h, 0.8)
          : frame(b.l, b.t, b.w - SQUASH_PX, b.h, 0.8),
        frame(b.l, b.t, b.w, b.h, 1),
      ]
    : [frame(a.l, a.t, a.w, a.h), frame(b.l, b.t, b.w, b.h)];

  let ended = false;
  const done = (): void => {
    if (ended) return;
    ended = true;
    inFlight.delete(list);
    ghost.remove();
    releaseTo();
    releaseList();
  };
  const animation = ghost.animate(frames, { duration: GLIDE_MS, easing: EASE_OUT });
  animation.onfinish = done;
  animation.oncancel = done;
  // Stopped synchronously, so the next glide measures and holds styles on a
  // row this one has already put back.
  inFlight.set(list, () => {
    done();
    animation.cancel();
  });
  requestAnimationFrame(() => {
    releaseFrom();
  });
}

/** The content a tab shows: the panel it names, a panel beside it, or what follows the row. */
function panelFor(list: HTMLElement, tab: HTMLElement): HTMLElement | null {
  const named = tab.getAttribute('aria-controls');
  const byId = named ? document.getElementById(named) : null;
  if (byId) return byId;
  const near = list.parentElement?.querySelector<HTMLElement>(':scope > [role="tabpanel"]');
  if (near) return near;
  const next = list.nextElementSibling;
  return next instanceof HTMLElement && !next.matches('[role="tablist"]') ? next : null;
}

function reveal(panel: HTMLElement, dir: number): void {
  for (const running of panel.getAnimations()) {
    if ((running as Animation & { id: string }).id === 'tab-panel') running.cancel();
  }
  const animation = panel.animate(
    [
      { opacity: 0, transform: `translateX(${dir * PANEL_SHIFT_PX}px)` },
      { opacity: 1, transform: 'none' },
    ],
    { duration: PANEL_MS, easing: EASE_OUT },
  );
  animation.id = 'tab-panel';
}

function onMutations(records: MutationRecord[]): void {
  if (document.hidden || reducedMotion()) return;
  // One switch is two records in one batch: one tab loses the selection and
  // another gains it. Paired per row, so two rows changing at once each move.
  const lost = new Map<HTMLElement, HTMLElement>();
  const gained = new Map<HTMLElement, HTMLElement>();
  for (const record of records) {
    const tab = record.target;
    if (!(tab instanceof HTMLElement) || tab.getAttribute('role') !== 'tab') continue;
    const list = tab.closest<HTMLElement>('[role="tablist"]');
    if (!list) continue;
    const was = record.oldValue === 'true';
    if (was && !isSelected(tab)) lost.set(list, tab);
    if (!was && isSelected(tab)) gained.set(list, tab);
  }
  for (const [list, to] of gained) {
    const from = lost.get(list);
    if (!from?.isConnected) continue;
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const dir = Math.sign(tabs.indexOf(to) - tabs.indexOf(from)) || 1;
    inFlight.get(list)?.();
    glide(list, from, to, dir);
    const panel = panelFor(list, to);
    if (panel) reveal(panel, dir);
  }
}

let installed = false;

/** Starts watching for tab switches, once, for the life of the page. */
export function installTabMotion(): void {
  if (installed || typeof MutationObserver === 'undefined') return;
  if (typeof Element.prototype.animate !== 'function') return;
  installed = true;
  new MutationObserver(onMutations).observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['aria-selected'],
  });
}
