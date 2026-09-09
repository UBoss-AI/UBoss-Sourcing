/**
 * The six capabilities the sourcing hub arranges itself around, and what
 * pressing one of them actually does.
 *
 * Kept out of the component for one reason: **where a node goes depends on who
 * is asking**, and that is a rule about this product rather than a detail of a
 * drawing. Three of the six have a customer screen behind them, two are
 * deliberately somebody else's job, and one is not a page at all. Written as
 * data, the whole map is readable at once and testable without rendering an
 * SVG.
 *
 * The rule the resolution below never breaks: **a node never links somewhere
 * the person pressing it cannot go.** A tile that navigates to a sign-in
 * redirect, or to a 404 on a deployment that has the feature switched off, is
 * worse than one that explains itself — the customer learns nothing except
 * that the page lied to them. So a node that cannot navigate returns a note
 * saying why, and where a way forward exists the note carries it.
 *
 * Two of them return a note *always*, and that is not a gap waiting to be
 * filled in:
 *
 *   - **Warehouses** are the operator's own network. There is no customer API
 *     for them and there should not be one; what the customer can act on is
 *     what that network can ship, which is the catalogue.
 *   - **ERP** is a URL plus a credential that this installation's server then
 *     calls. Creating one belongs to whoever runs the installation, which is
 *     why the screen for it is in the admin panel and why `lib/autopay.ts`
 *     says the same thing about the surface that used to be here.
 */
import {
  CalendarIcon,
  CardIcon,
  LayersIcon,
  LinkIcon,
  SparkIcon,
  WarehouseIcon,
} from '@/components/icons';
import type { TranslationKey } from '@/i18n/i18n-context';

export type OrchestrationNodeId =
  | 'assistant'
  | 'warehouses'
  | 'schedules'
  | 'erp'
  | 'autopay'
  | 'inventory';

export interface OrchestrationNode {
  id: OrchestrationNodeId;
  /**
   * Degrees counter-clockwise from three o'clock, the way school geometry
   * measures them and the way `Math.cos` reads them.
   *
   * SVG turns the other way, so the drawing negates this exactly once — in
   * `svgRotation` below — rather than each call site remembering to. The six
   * are 60° apart, which is what keeps the labels from touching.
   */
  angle: number;
  icon: (props: { className?: string }) => React.JSX.Element;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
}

/*
 * Clockwise from the top, matching the order they are read in.
 *
 * The pairing across the circle is deliberate rather than decorative: what a
 * customer decides (schedules, auto-pay) sits on one side, what the
 * installation does on their behalf (ERP, inventory, warehouses) on the other,
 * and the assistant — which is neither — sits at the top on its own.
 */
export const ORCHESTRATION_NODES: readonly OrchestrationNode[] = [
  {
    id: 'assistant',
    angle: 90,
    icon: SparkIcon,
    labelKey: 'greeting.node.assistant',
    hintKey: 'greeting.node.assistantHint',
  },
  {
    id: 'schedules',
    angle: 30,
    icon: CalendarIcon,
    labelKey: 'greeting.node.schedules',
    hintKey: 'greeting.node.schedulesHint',
  },
  {
    id: 'erp',
    angle: -30,
    icon: LinkIcon,
    labelKey: 'greeting.node.erp',
    hintKey: 'greeting.node.erpHint',
  },
  {
    id: 'autopay',
    angle: -90,
    icon: CardIcon,
    labelKey: 'greeting.node.autopay',
    hintKey: 'greeting.node.autopayHint',
  },
  {
    id: 'inventory',
    angle: -150,
    icon: LayersIcon,
    labelKey: 'greeting.node.inventory',
    hintKey: 'greeting.node.inventoryHint',
  },
  {
    id: 'warehouses',
    angle: 150,
    icon: WarehouseIcon,
    labelKey: 'greeting.node.warehouses',
    hintKey: 'greeting.node.warehousesHint',
  },
];

// ---------------------------------------------------------------------------
// Geometry
//
// One centre, one node radius, one set of formulae. The drawing and the DOM
// overlay read these same numbers, which is what stops a line from ending
// three pixels off the tile it is supposed to reach.
// ---------------------------------------------------------------------------

/** The drawing's user-unit grid. Square, so `cos`/`sin` need no correction. */
export const HUB_VIEWBOX = 400;
export const HUB_CENTRE = HUB_VIEWBOX / 2;

/** Where each node's centre sits, as a fraction of the square. */
const NODE_RADIUS_FRACTION = 0.4;

/** A radial line runs from just outside the orb to just short of the tile. */
export const LINE_START = 74;
export const LINE_END = 142;

/** The two orbital paths, in user units from the centre. */
export const RING_INNER = 96;
export const RING_OUTER = 128;

function radians(angle: number): number {
  return (angle * Math.PI) / 180;
}

/**
 * A node's centre as CSS percentages of the stage.
 *
 * `top` subtracts, because the screen's y-axis points down and the angle's
 * does not. Getting this backwards mirrors the whole diagram, which looks
 * plausible until the labels no longer match the reference.
 */
export function nodePosition(angle: number): { left: string; top: string } {
  const offset = NODE_RADIUS_FRACTION * 100;

  return {
    left: `${(50 + offset * Math.cos(radians(angle))).toFixed(3)}%`,
    top: `${(50 - offset * Math.sin(radians(angle))).toFixed(3)}%`,
  };
}

/** The same angle as SVG's `rotate()` wants it: clockwise, in degrees. */
export function svgRotation(angle: number): number {
  return -angle;
}

// ---------------------------------------------------------------------------
// What a node does
// ---------------------------------------------------------------------------

/** Everything the resolution below is allowed to look at. */
export interface OrchestrationAccess {
  /** Signed in AND activated. The same gate the rest of the storefront uses. */
  isCustomer: boolean;
  /** True while `/auth/me` is still in flight, so nothing is decided yet. */
  isSessionLoading: boolean;
  /** `features.assistant` — whether this deployment configured an AI key. */
  hasAssistant: boolean;
  /** `features.recurringOrders` — whether repeat purchases are switched on. */
  hasRecurringOrders: boolean;
}

/**
 * What happens when a node is pressed.
 *
 * `pending` exists so that the moment before the session is known renders a
 * node that is present and inert rather than one that offers a guest's answer
 * and then changes its mind. A tile that says "Sign in" for 200ms and then
 * says "Manage" is the flicker every session-aware page starts with.
 */
export type NodeOutcome =
  | { kind: 'pending' }
  | { kind: 'link'; to: string }
  | { kind: 'assistant' }
  | { kind: 'note'; bodyKey: TranslationKey; to?: string; ctaKey?: TranslationKey };

/** The sign-in note, which four of the six can produce. */
function signIn(bodyKey: TranslationKey): NodeOutcome {
  return { kind: 'note', bodyKey, to: '/login', ctaKey: 'greeting.signIn' };
}

export function resolveNode(id: OrchestrationNodeId, access: OrchestrationAccess): NodeOutcome {
  const { isCustomer, isSessionLoading, hasAssistant, hasRecurringOrders } = access;

  switch (id) {
    /*
     * The assistant is a panel pinned to the corner of every page, not a
     * route, so this returns an intent rather than a URL — see `SourcingHub`
     * for how it reaches the widget.
     *
     * A guest is offered a way in and never an AI action. That is the same
     * bargain `ChatWidget` already strikes with a guest, and it is not a
     * courtesy: every `/assistant` route is behind the customer session guard
     * and answers a signed-out browser with a 401.
     */
    case 'assistant':
      if (!hasAssistant) return { kind: 'note', bodyKey: 'greeting.note.assistantOff' };
      if (isSessionLoading) return { kind: 'pending' };
      if (!isCustomer) return signIn('greeting.note.assistantGuest');
      return { kind: 'assistant' };

    case 'schedules':
      if (!hasRecurringOrders) return { kind: 'note', bodyKey: 'greeting.note.schedulesOff' };
      if (isSessionLoading) return { kind: 'pending' };
      if (!isCustomer) return signIn('greeting.note.schedulesGuest');
      return { kind: 'link', to: '/account/schedules' };

    case 'autopay':
      if (isSessionLoading) return { kind: 'pending' };
      if (!isCustomer) return signIn('greeting.note.autopayGuest');
      return { kind: 'link', to: '/account/autopay' };

    /*
     * Inventory sync has no screen of its own and does not need one: what a
     * synchronised stock level is *for* is knowing whether a line can be
     * shipped, and that is on the product. The catalogue is the honest
     * destination, and it is open to guests.
     */
    case 'inventory':
      return { kind: 'link', to: '/products' };

    // Always a note. See the header.
    case 'warehouses':
      return {
        kind: 'note',
        bodyKey: 'greeting.note.warehouses',
        to: '/products',
        ctaKey: 'greeting.note.warehousesCta',
      };

    case 'erp':
      return { kind: 'note', bodyKey: 'greeting.note.erp' };
  }
}

/** A point on the circle of a given radius, in the drawing's own units. */
export function pointAt(angle: number, radius: number): { x: number; y: number } {
  return {
    x: Number((HUB_CENTRE + radius * Math.cos(radians(angle))).toFixed(2)),
    y: Number((HUB_CENTRE - radius * Math.sin(radians(angle))).toFixed(2)),
  };
}
