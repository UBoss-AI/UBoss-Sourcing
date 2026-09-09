/**
 * How a warehouse is drawn on the map, for whichever map is drawing it.
 *
 * One builder rather than one per provider, and that is the whole reason this
 * file exists. Leaflet and Google Maps take their marker content in different
 * shapes - a string of HTML for Leaflet's `divIcon`, a real element for
 * Google's `AdvancedMarkerElement` - and two implementations of "what does a
 * warehouse look like" is how a deployment on Google ends up with markers that
 * are subtly a different size from the same panel on OpenStreetMap.
 *
 * Built with DOM calls rather than a template string, and that is a security
 * decision rather than a style one. `divIcon` assigns its HTML with
 * `innerHTML`, so the previous version of this had to hand-escape the
 * warehouse's code. `textContent` cannot be talked into running anything, so
 * the escaping goes away rather than having to stay correct - and a warehouse
 * called `Pune <b>2</b>` reads as its own name on both maps.
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
      return 'border-danger bg-danger text-white';
    case 'MAINTENANCE':
      return 'border-ink-muted bg-surface-sunken text-ink';
    case 'LIMITED':
      return 'border-warning bg-warning text-white';
    case 'OPERATIONAL':
      // The default warehouse in the palette's own teal, so the place every
      // unqualified receipt lands in is pickable out of a cluster.
      return warehouse.isDefault
        ? 'border-operational bg-operational text-white'
        : 'border-accent bg-accent text-white';
  }
}

/** The box both providers reserve for one marker, in pixels. */
export const MARKER_BOX = 28;

/**
 * One marker, as an element.
 *
 * A ring with the warehouse's initial in it, rather than a pin: at this size a
 * pin's point is what says where the thing is, and a circle centred on the
 * coordinate is both smaller and more precise. The low-stock ones carry a dot
 * so the warning does not rest on colour alone - the panel's contrast audit
 * covers palettes, not what a red circle means to somebody who cannot see red.
 *
 * The outer element fills its box and centres the circle in it, which is what
 * lets Leaflet position it by `iconSize`/`iconAnchor` and Google position it
 * by its own anchor without either of them knowing the circle's size.
 */
export function markerElement(warehouse: PlacedWarehouse, isSelected: boolean): HTMLElement {
  const box = document.createElement('span');
  box.className = 'flex items-center justify-center';
  box.style.width = `${String(MARKER_BOX)}px`;
  box.style.height = `${String(MARKER_BOX)}px`;

  const circle = document.createElement('span');
  circle.className = [
    'relative flex items-center justify-center rounded-full border-2 font-semibold shadow-card',
    isSelected ? 'h-8 w-8 text-xs' : 'h-6 w-6 text-xxs',
    markerTone(warehouse),
    isSelected ? 'ring-2 ring-ring' : '',
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
 * The same marker as a string, for Leaflet's `divIcon`.
 *
 * `divIcon` takes markup, not an element, so this is the one place the element
 * gets serialised. Going through `markerElement` rather than assembling a
 * second template is what keeps the two maps drawing the same marker.
 */
export function markerHtml(warehouse: PlacedWarehouse, isSelected: boolean): string {
  return markerElement(warehouse, isSelected).outerHTML;
}
