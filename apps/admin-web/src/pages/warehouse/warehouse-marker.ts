/**
 * How a warehouse is drawn on the map, for whichever map is drawing it.
 *
 * One builder rather than one per provider, and that is the whole reason this
 * file exists. Two implementations of "what does a warehouse look like" is how
 * a deployment on Google ends up with markers that are subtly a different size
 * from the same panel on OpenStreetMap. MapLibre's `Marker` and Google's
 * `AdvancedMarkerElement` both take a real element, so one builder serves
 * both.
 *
 * Built with DOM calls rather than a template string, and that is a security
 * decision rather than a style one. `textContent` cannot be talked into
 * running anything, so there is no escaping here that has to stay correct -
 * and a warehouse called `Pune <b>2</b>` reads as its own name on both maps.
 */
import type { PlacedWarehouse, Warehouse } from '@/lib/warehouses';

/**
 * A marker's colour.
 *
 * The operational status decides it, because that is the question a map of
 * warehouses is opened to answer: which of these can ship today. The record
 * state overrides it in one case only - a retired warehouse is drawn hollow,
 * because whether a place nobody uses any more is "operational" is not a
 * meaningful question.
 *
 * Colour is never the only signal. Every marker's warehouse is in the table
 * below it with the status written out, the marker carries the code's initial,
 * and the low-stock ones get a dot as well as a hue.
 */
export function markerTone(warehouse: Warehouse): string {
  if (!warehouse.isActive) return 'border-border-strong bg-surface text-ink-subtle';

  switch (warehouse.operationalStatus) {
    case 'SUSPENDED':
      return 'border-danger bg-danger-fill text-white';
    case 'MAINTENANCE':
      return 'border-ink-muted bg-surface-sunken text-ink';
    case 'LIMITED':
      return 'border-warning bg-warning-fill text-white';
    case 'OPERATIONAL':
      // The default warehouse in the palette's own teal, so the place every
      // unqualified receipt lands in is pickable out of a cluster.
      return warehouse.isDefault
        ? 'border-operational bg-operational-fill text-white'
        : 'border-brand bg-brand-fill text-white';
  }
}

/**
 * The box a marker's element reserves, in pixels.
 *
 * Not exported: both renderers position a marker by its element's own box -
 * MapLibre anchors at its centre, Google at the bottom of it - so neither has
 * to be told a size.
 */
const MARKER_BOX = 28;

/**
 * What being the selected marker looks like, and what being an ordinary one
 * looks like.
 *
 * Two lists rather than a ternary inside the class string, because they are
 * also what `setMarkerSelected` swaps at runtime and a marker that was built
 * selected has to be indistinguishable from one that was made selected
 * afterwards. Written once, so the two cannot drift.
 */
const SELECTED_CLASSES = ['h-8', 'w-8', 'text-xs', 'ring-2', 'ring-ring'];
const UNSELECTED_CLASSES = ['h-6', 'w-6', 'text-xxs'];

/**
 * One marker, as an element.
 *
 * A ring with the warehouse's initial in it, rather than a pin: at this size a
 * pin's point is what says where the thing is, and a circle centred on the
 * coordinate is both smaller and more precise. The low-stock ones carry a dot
 * so the warning does not rest on colour alone - the panel's contrast audit
 * covers palettes, not what a red circle means to somebody who cannot see red.
 *
 * The optional pulse is the one piece of motion on the map that is not drawn
 * by MapLibre, and it is a CSS animation on this element rather than a paint
 * property on a layer: the marker is a DOM node, so the compositor animates it
 * for free and `motion-reduce` switches it off without any JavaScript
 * checking a media query.
 *
 * The outer element fills its box and centres the circle in it, which is what
 * lets MapLibre anchor it by the box's centre and Google by the box's bottom
 * edge without either of them knowing the circle's size.
 */
export function markerElement(
  warehouse: PlacedWarehouse,
  isSelected: boolean,
  /**
   * Is this the warehouse whose delivery coverage is being shown?
   *
   * A different question from `isSelected`, and the two are visible at once:
   * a row can be selected in the table while the pointer is over a different
   * marker. Selected is "this is the record open in the panel"; pulsing is
   * "this is the one the ring on the map belongs to".
   */
  isPulsing = false,
): HTMLElement {
  const box = document.createElement('span');
  box.className = 'relative flex items-center justify-center';
  box.style.width = `${String(MARKER_BOX)}px`;
  box.style.height = `${String(MARKER_BOX)}px`;

  // Behind the circle rather than around it, and `pointer-events-none` so a
  // ring that has grown to two and a half times the marker's size does not
  // swallow clicks meant for the marker beside it.
  //
  // Built into every marker and hidden on most of them, rather than added and
  // removed as the pointer moves. That is what lets the map answer "point at
  // a different warehouse" by switching one attribute instead of throwing
  // away every marker element and building new ones - a rebuild is visible as
  // a blink of the whole map, and on the marker under the cursor it discards
  // the hover the browser was tracking halfway through the gesture.
  //
  // `hidden` rather than a class: a `display: none` element runs no
  // animation, so the pulse starts from its own first frame each time a halo
  // is shown rather than joining one already in progress.
  const halo = document.createElement('span');
  halo.dataset.markerHalo = '';
  halo.className =
    'pointer-events-none absolute inset-1.5 rounded-full bg-brand animate-marker-pulse motion-reduce:animate-none';
  halo.hidden = !isPulsing;
  box.appendChild(halo);

  const circle = document.createElement('span');
  circle.dataset.markerCircle = '';
  circle.className = [
    'relative flex items-center justify-center rounded-full border-2 font-semibold shadow-card',
    // The answer to the pointer arriving, before anything else has happened.
    // Coverage waits 140ms to be sure the hover was meant; this does not wait
    // at all, so the marker acknowledges the cursor at once and the panel that
    // follows reads as the second half of one gesture rather than as something
    // that happened on its own. Transform only, so it is composited and costs
    // no layout, and `motion-reduce` drops it.
    'transition-transform duration-150 ease-out hover:scale-110 motion-reduce:transition-none',
    markerTone(warehouse),
    ...(isSelected ? SELECTED_CLASSES : UNSELECTED_CLASSES),
  ]
    .filter((part) => part.length > 0)
    .join(' ');

  // The code's first character, or a question mark for a code that is somehow
  // all whitespace. `textContent`, so a name with markup in it is a name.
  circle.textContent = warehouse.code.trim().charAt(0).toUpperCase() || '?';

  if (warehouse.stock.lowStockCount > 0) {
    const dot = document.createElement('span');
    dot.className =
      'absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-surface bg-danger';
    circle.appendChild(dot);
  }

  box.appendChild(circle);
  return box;
}

/**
 * Move the selection to or from one marker, in place.
 *
 * Same bargain as `setMarkerPulse` and the same reason: the selected marker
 * is a ring two sizes larger, and rebuilding every marker to grow one of them
 * discards the element the pointer is currently on. Clicking a marker is
 * exactly when that happens - it selects the warehouse it is hovering - so
 * without this, opening a record threw away the hover that was showing that
 * record's delivery coverage.
 *
 * The z-index stays with the caller: it belongs to the outer element, which
 * is the one the map renderer positions, and only the map knows what else it
 * has put there.
 */
export function setMarkerSelected(element: HTMLElement, isSelected: boolean): void {
  const circle = element.querySelector<HTMLElement>('[data-marker-circle]');
  if (circle === null) return;

  circle.classList.remove(...(isSelected ? UNSELECTED_CLASSES : SELECTED_CLASSES));
  circle.classList.add(...(isSelected ? SELECTED_CLASSES : UNSELECTED_CLASSES));
}

/**
 * Turn one marker's pulse on or off, in place.
 *
 * The counterpart to building a halo into every marker: pointing at another
 * warehouse becomes a change to one attribute rather than a rebuild of every
 * marker on the map. Takes the outer element a renderer already holds -
 * MapLibre's `marker.getElement()` - so a caller needs to have kept nothing
 * besides the marker itself.
 */
export function setMarkerPulse(element: HTMLElement, isPulsing: boolean): void {
  const halo = element.querySelector<HTMLElement>('[data-marker-halo]');
  if (halo === null) return;
  halo.hidden = !isPulsing;
}
