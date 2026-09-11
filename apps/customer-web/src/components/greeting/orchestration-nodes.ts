/**
 * The four capabilities the sourcing hub arranges itself around, and what
 * pressing one of them actually does.
 *
 * Kept out of the component for one reason: **where a node goes depends on who
 * is asking**, and that is a rule about this product rather than a detail of a
 * drawing. Three of the four have a customer screen behind them and one is
 * deliberately somebody else's job. Written as data, the whole map is readable
 * at once and testable without rendering an SVG.
 *
 * The rule the resolution below never breaks: **a node never links somewhere
 * the person pressing it cannot go.** A tile that navigates to a sign-in
 * redirect, or to a 404 on a deployment that has the feature switched off, is
 * worse than one that explains itself — the customer learns nothing except
 * that the page lied to them. So a node that cannot navigate returns a note
 * saying why, and where a way forward exists the note carries it.
 *
 * **ERP used to return a note always, and no longer does.** The reason it did
 * was real: a connection is a URL plus a credential this installation's server
 * then calls, and for a long time the only screen for one was in the admin
 * panel. It is now a buyer-facing feature — a customer connects their *own*
 * SAP, monday.com or in-house system at `/account/integrations/erp` — and the
 * risk that kept it out is handled where it has to be, in `outbound-http.ts`
 * and the credential vault, rather than by declining to offer it. So the node
 * navigates like every other one, behind the same sign-in branch.
 *
 * ---
 *
 * **Two nodes used to be here and are deliberately gone: Warehouse Network
 * and Inventory Sync.** Both described the operator's own logistics rather
 * than anything a buyer could act on, and both ended up resolving to the
 * catalogue — so the hub was spending a third of its circle pointing twice at
 * a page it already points at. What a buyer can act on is what that network
 * can ship, and that is the catalogue, reachable from the search bar beside
 * this drawing. Do not re-add them without a customer screen to put behind
 * them.
 */
import { CalendarIcon, CardIcon, LinkIcon, SparkIcon } from '@/components/icons';
import type { TranslationKey } from '@/i18n/i18n-context';

export type OrchestrationNodeId = 'assistant' | 'schedules' | 'erp' | 'autopay';

/**
 * Which of the two drawn guides a node is grouped with.
 *
 * It used to decide which way a node travelled: the two groups counter-rotated
 * at different periods. All four cards ride the same circle, though, so two
 * rates on one circle meant they passed through each other — twice a minute
 * one card covered another's wording. Every card now shares one orbit and one
 * direction, and stays 90° from its neighbours forever.
 *
 * What is left for this field is which ring guide and which spoke group a node
 * is drawn with, which is still two of each because each is drawn for its own
 * pair of angles. See `--orch-orbit-period` in orchestration.css.
 */
export type OrchestrationRing = 'inner' | 'outer';

export interface OrchestrationNode {
  id: OrchestrationNodeId;
  /**
   * Degrees counter-clockwise from three o'clock, the way school geometry
   * measures them and the way `Math.cos` reads them.
   *
   * SVG turns the other way, so the drawing negates this exactly once — in
   * `svgRotation` below — rather than each call site remembering to. The four
   * are 90° apart, which is what keeps the labels from touching once the whole
   * arrangement is turning.
   */
  angle: number;
  ring: OrchestrationRing;
  icon: (props: { className?: string }) => React.JSX.Element;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
}

/*
 * Clockwise from the upper left, matching the order they are read in.
 *
 * Placed on the diagonals rather than at twelve, three, six and nine o'clock.
 * A card is far wider than it is tall, so a node parked due east has its
 * outer edge closest to the frame — and once the whole arrangement rotates,
 * every node visits due east. The diagonals are where the four sit furthest
 * from one another, which is the arrangement that survives being turned.
 *
 * The pairing across the circle is deliberate rather than decorative: what a
 * customer decides (schedules, auto-pay) sits on one diagonal, and what the
 * installation does on their behalf (the assistant, the ERP hand-off) on the
 * other.
 */
export const ORCHESTRATION_NODES: readonly OrchestrationNode[] = [
  {
    id: 'assistant',
    angle: 135,
    ring: 'outer',
    icon: SparkIcon,
    labelKey: 'greeting.node.assistant',
    hintKey: 'greeting.node.assistantHint',
  },
  {
    id: 'schedules',
    angle: 45,
    ring: 'inner',
    icon: CalendarIcon,
    labelKey: 'greeting.node.schedules',
    hintKey: 'greeting.node.schedulesHint',
  },
  {
    id: 'erp',
    angle: -45,
    ring: 'outer',
    icon: LinkIcon,
    labelKey: 'greeting.node.erp',
    hintKey: 'greeting.node.erpHint',
  },
  {
    id: 'autopay',
    angle: -135,
    ring: 'inner',
    icon: CardIcon,
    labelKey: 'greeting.node.autopay',
    hintKey: 'greeting.node.autopayHint',
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

/**
 * Where each node's centre sits, as a fraction of the square.
 *
 * The one number the whole arrangement is squeezed between, and it is squeezed
 * from both sides now that the ring turns:
 *
 *   - **Too large and it leaves the frame.** Every card visits every angle, so
 *     both of its half-dimensions matter: 9rem wide when it is due east, and
 *     9.5rem tall when it is due north. In a 30rem frame at 0.37 the ring is
 *     499px across and 507px tall — the width spills 10px and the height 13px
 *     into the hero's own 48px padding, which
 *     is why the hero must never be padded more tightly than the ring is tall.
 *   - **Too small and the cards sit on the orb.** The sphere is 33% of the
 *     stage and its aura is visible to about 19% of it, so a card whose inner
 *     edge is inside that overlaps the graphic it is meant to orbit. At 0.37
 *     the nearest a card comes is 102px against the aura's 90px.
 *
 * Four numbers decide all of that: this fraction, the card's 9rem width, its
 * 9.5rem height (in orchestration.css) and the orb's 33%. Change any one and
 * check **due north and due east**, not the diagonal — the diagonal is where
 * there is most room, which is why a change that is wrong still looks fine
 * there.
 */
const NODE_RADIUS_FRACTION = 0.37;

/** A radial line runs from just outside the orb to just short of the tile. */
export const LINE_START = 74;
export const LINE_END = 116;

/** The two orbital paths, in user units from the centre. */
export const RING_INNER = 88;
export const RING_OUTER = 112;

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
  | { kind: 'note'; bodyKey: TranslationKey; to?: string; ctaKey?: TranslationKey };

/** The sign-in note, which two of the four can produce. */
function signIn(bodyKey: TranslationKey): NodeOutcome {
  return { kind: 'note', bodyKey, to: '/login', ctaKey: 'greeting.signIn' };
}

export function resolveNode(id: OrchestrationNodeId, access: OrchestrationAccess): NodeOutcome {
  const { isCustomer, isSessionLoading, hasAssistant, hasRecurringOrders } = access;

  switch (id) {
    /*
     * The assistant is AI Mode, which is a page at `/ai` and no longer a panel
     * pinned to the corner of every screen. That is why this returns an
     * ordinary link where it used to return an intent the hub had to translate
     * into a window event — a node that navigates is a node that middle-clicks,
     * opens in a new tab and reads as a link to a screen reader.
     *
     * The only node with **no session branch at all**, and that is the rule
     * above being followed rather than broken: AI Mode is open, so there is
     * nowhere a guest pressing this cannot go. It does not even wait for the
     * session to settle, because the answer does not depend on it — and a tile
     * that sat inert for 200ms while `/auth/me` decided nothing would be a
     * stall for its own sake.
     */
    case 'assistant':
      if (!hasAssistant) return { kind: 'note', bodyKey: 'greeting.note.assistantOff' };
      return { kind: 'link', to: '/ai' };

    case 'schedules':
      if (!hasRecurringOrders) return { kind: 'note', bodyKey: 'greeting.note.schedulesOff' };
      if (isSessionLoading) return { kind: 'pending' };
      if (!isCustomer) return signIn('greeting.note.schedulesGuest');
      return { kind: 'link', to: '/account/schedules' };

    case 'autopay':
      if (isSessionLoading) return { kind: 'pending' };
      if (!isCustomer) return signIn('greeting.note.autopayGuest');
      return { kind: 'link', to: '/account/autopay' };

    case 'erp':
      if (isSessionLoading) return { kind: 'pending' };
      if (!isCustomer) return signIn('greeting.note.erpGuest');
      return { kind: 'link', to: '/account/integrations/erp' };
  }
}

/** A point on the circle of a given radius, in the drawing's own units. */
export function pointAt(angle: number, radius: number): { x: number; y: number } {
  return {
    x: Number((HUB_CENTRE + radius * Math.cos(radians(angle))).toFixed(2)),
    y: Number((HUB_CENTRE - radius * Math.sin(radians(angle))).toFixed(2)),
  };
}
