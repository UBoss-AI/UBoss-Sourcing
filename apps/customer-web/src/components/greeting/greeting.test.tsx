/**
 * The greeting page's sourcing hub.
 *
 * What these are actually guarding is the one rule the whole feature rests on:
 * **a node never offers something the person pressing it cannot have.** A
 * decorative diagram that quietly links a guest into a session guard, or links
 * anybody at all into a feature this deployment has switched off, is worse
 * than no diagram — and it is exactly the kind of regression that a screenshot
 * review sails straight past, because it looks perfect until it is pressed.
 *
 * The animation itself is not asserted here and cannot be: jsdom has no
 * layout, no computed transform and no `matchMedia`, so "the ring rotates" is
 * not a thing this suite can know. What it *can* know is the structural facts
 * the animation depends on, and those are the ones that break silently:
 *
 *   - the word in the middle is not inside the element that spins;
 *   - every card sits inside an orbit layer AND a counter-rotation layer, in
 *     that order, because the second is what keeps the wording upright while
 *     the first sweeps it round the orb;
 *   - both rings are populated, because they turn in opposite directions and a
 *     ring with nothing on it is four cards rotating as one rigid cross.
 *
 * The motion itself is verified by a person in a browser, including with
 * reduced motion switched on, which `docs/ACCESSIBILITY.md` already says is
 * how this project treats the properties jsdom cannot see.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SourcingHub } from './SourcingHub';
import { ORCHESTRATION_NODES, resolveNode } from './orchestration-nodes';
import type { OrchestrationAccess } from './orchestration-nodes';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { expectNoA11yViolations } from '@/test/axe';
import { jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import type { StorefrontConfig } from '@/lib/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A deployment with everything switched on, unless a test says otherwise. */
function makeConfig(features: Partial<StorefrontConfig['features']> = {}): StorefrontConfig {
  return {
    ...FALLBACK_CONFIG,
    features: {
      ...FALLBACK_CONFIG.features,
      recurringOrders: true,
      assistant: true,
      ...features,
    },
  };
}

const GUEST = makeSession({ user: null, isCustomer: false });

function makeAccess(overrides: Partial<OrchestrationAccess> = {}): OrchestrationAccess {
  return {
    isCustomer: true,
    isSessionLoading: false,
    hasAssistant: true,
    hasRecurringOrders: true,
    ...overrides,
  };
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  // The hub itself reads nothing. The header identity hook the greeting shares
  // may, depending on what a test renders, so an empty 200 keeps a stray read
  // from failing a test about something else.
  fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({})));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The rule, without a DOM
// ---------------------------------------------------------------------------

describe('what a node does', () => {
  it('sends an activated customer to the screen behind it', () => {
    expect(resolveNode('schedules', makeAccess())).toEqual({
      kind: 'link',
      to: '/account/schedules',
    });
    expect(resolveNode('autopay', makeAccess())).toEqual({
      kind: 'link',
      to: '/account/autopay',
    });
  });

  it('never links a guest into a route the session guard would bounce', () => {
    const guest = makeAccess({ isCustomer: false });

    for (const id of ['schedules', 'autopay'] as const) {
      const outcome = resolveNode(id, guest);

      expect(outcome.kind).toBe('note');
      // The way *in*, not the way to the guarded page.
      expect(outcome).toMatchObject({ to: '/login' });
    }
  });

  it('sends everybody to the AI Mode page, signed in or not', () => {
    // The corner chat widget is gone and AI Mode is open, so this is an
    // ordinary link for both — no intent for the hub to translate into a
    // window event, and no sign-in note, because there is nowhere a guest
    // pressing it cannot go.
    expect(resolveNode('assistant', makeAccess())).toEqual({ kind: 'link', to: '/ai' });
    expect(resolveNode('assistant', makeAccess({ isCustomer: false }))).toEqual({
      kind: 'link',
      to: '/ai',
    });
  });

  it('explains a capability this deployment has switched off instead of linking to it', () => {
    expect(resolveNode('schedules', makeAccess({ hasRecurringOrders: false }))).toEqual({
      kind: 'note',
      bodyKey: 'greeting.note.schedulesOff',
    });

    expect(resolveNode('assistant', makeAccess({ hasAssistant: false }))).toEqual({
      kind: 'note',
      bodyKey: 'greeting.note.assistantOff',
    });
  });

  it('decides nothing while the session is still unknown', () => {
    // This would otherwise answer "sign in" and then change its mind 200ms
    // later, which is the flicker the pending state exists for.
    expect(resolveNode('autopay', makeAccess({ isSessionLoading: true }))).toEqual({
      kind: 'pending',
    });
    // The assistant is deliberately absent from that: its answer does not
    // depend on the session, so there is nothing to hold back for.
    expect(resolveNode('assistant', makeAccess({ isSessionLoading: true }))).toEqual({
      kind: 'link',
      to: '/ai',
    });
  });

  it('sends a signed-in customer to their own ERP integration', () => {
    // This node used to explain itself to everybody, because a connection was
    // a URL plus a credential belonging to whoever runs the installation and
    // there was no customer screen for one. There is now: a buyer connects
    // their OWN SAP, monday.com or in-house system, and the risk that kept it
    // out is handled in `outbound-http.ts` and the credential vault rather
    // than by declining to offer it.
    expect(resolveNode('erp', makeAccess())).toEqual({
      kind: 'link',
      to: '/account/integrations/erp',
    });
  });

  it('asks a guest to sign in rather than linking somewhere they cannot go', () => {
    // The rule this file exists to hold: a node never links somewhere the
    // person pressing it cannot get to.
    expect(resolveNode('erp', makeAccess({ isCustomer: false })).kind).toBe('note');
    expect(resolveNode('erp', makeAccess({ isSessionLoading: true })).kind).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// What is on the circle
// ---------------------------------------------------------------------------

describe('the node table', () => {
  it('carries four capabilities and no operator logistics', () => {
    // Warehouse Network and Inventory Sync were removed deliberately: both
    // described the operator's own network rather than anything a buyer could
    // act on, and both resolved to the catalogue, which the search bar beside
    // this drawing already reaches. Re-adding either without a customer screen
    // behind it should fail here first.
    expect(ORCHESTRATION_NODES.map((node) => node.id)).toEqual([
      'assistant',
      'schedules',
      'erp',
      'autopay',
    ]);
  });

  it('puts nodes on both rings, and spaces them evenly', () => {
    const rings = new Set(ORCHESTRATION_NODES.map((node) => node.ring));

    // The two rings turn in opposite directions. If every node were on one of
    // them the arrangement would be a rigid cross being spun, which is the
    // thing the two-ring split exists to avoid.
    expect(rings).toEqual(new Set(['inner', 'outer']));

    // 90° apart, on the diagonals. Evenly spaced is what keeps two labels from
    // arriving in the same place once the whole ring is turning.
    const angles = [...ORCHESTRATION_NODES.map((node) => node.angle)].sort((a, b) => a - b);
    expect(angles).toEqual([-135, -45, 45, 135]);
  });
});

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

describe('the sourcing hub', () => {
  it('renders all four capabilities as one list of controls', () => {
    renderWithProviders(<SourcingHub />, { config: makeConfig() });

    const list = screen.getByRole('list');

    // Some are links and some are buttons — which one a node is depends on
    // whether it has anywhere to send this particular visitor. For a signed-in
    // customer with every capability on, all four are links; for a guest, three
    // of them are buttons carrying a sign-in note. `queryAllByRole` rather than
    // `getAllByRole`, because either group being empty is a legitimate outcome
    // and only the total matters here.
    const controls = [
      ...within(list).queryAllByRole('link'),
      ...within(list).queryAllByRole('button'),
    ];

    expect(controls).toHaveLength(4);

    for (const label of ['AI Assistant', 'Schedule your Cart', 'ERP Integration', 'Autopay']) {
      expect(within(list).getByText(label)).toBeInTheDocument();
    }
  });

  /*
   * The point of the whole component. The orb rotates in three dimensions and
   * its highlight orbits; the word does neither, because it is a sibling of
   * both rather than a child. If somebody ever moves the label inside
   * `.orch-orb` it will look fine in a screenshot and be unreadable in
   * motion — so the structure is asserted rather than the appearance.
   */
  it('keeps the word in the middle out of everything that rotates', () => {
    const { container } = renderWithProviders(<SourcingHub />, { config: makeConfig() });

    const label = screen.getByText('Sourcing');
    const orb = container.querySelector('.orch-orb');
    const wire = container.querySelector('.orch-orb-wire');

    expect(orb).not.toBeNull();
    expect(wire).not.toBeNull();
    expect(orb?.contains(label)).toBe(false);
    expect(wire?.contains(label)).toBe(false);
    expect(label.closest('.orch-hub-label')).not.toBeNull();
  });

  /*
   * The same rule one level out: the cards orbit, and their wording does not.
   *
   * The orbit and the counter-rotation are a matched pair — same period,
   * opposite direction — and the only thing that makes a card readable while
   * it travels. Deleting one of the two wrappers as "an extra div" is the
   * change this exists to catch, and it would look perfectly fine in a
   * screenshot: the cards would simply be upside down for half of every
   * minute.
   */
  it('wraps every card in an orbit layer and a counter-rotation inside it', () => {
    const { container } = renderWithProviders(<SourcingHub />, { config: makeConfig() });

    const nodes = [...container.querySelectorAll('.orch-node')];
    expect(nodes).toHaveLength(4);

    for (const node of nodes) {
      // The ring is on the node, because it decides both the direction of the
      // orbit and the direction of the cancellation.
      expect(['inner', 'outer']).toContain(node.getAttribute('data-ring'));

      const control = node.querySelector('.orch-node-control');
      expect(control).not.toBeNull();

      const spin = control?.closest('.orch-node-spin') ?? null;
      const orbit = control?.closest('.orch-node-orbit') ?? null;

      expect(spin).not.toBeNull();
      expect(orbit).not.toBeNull();
      // Order matters: the cancellation has to be *inside* the orbit. Outside
      // it, the two would compose the other way round and the card would still
      // turn over.
      expect(orbit?.contains(spin as Node)).toBe(true);
    }
  });

  it('says nothing to a screen reader that the nodes do not already say', () => {
    const { container } = renderWithProviders(<SourcingHub />, { config: makeConfig() });

    // Every name in the drawing is also rendered as text in the node beside
    // it. A diagram that announced itself would read the same four words twice.
    expect(container.querySelector('svg.orch-web')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('gives each node its own name and its own description', () => {
    renderWithProviders(<SourcingHub />, { config: makeConfig() });

    // A link now, not a button: a signed-in customer has somewhere to go.
    const node = screen.getByRole('link', { name: 'ERP Integration' });

    // Not one merged label: "ERP Integration Orders handed to your own system,
    // button" is not a thing anybody can skim a list of four of.
    expect(node).toHaveAccessibleName('ERP Integration');
    expect(node).toHaveAccessibleDescription('Orders handed to your own system');
  });

  it('takes a customer straight to the screen a node stands for', () => {
    renderWithProviders(<SourcingHub />, { config: makeConfig() });

    expect(screen.getByRole('link', { name: 'Schedule your Cart' })).toHaveAttribute(
      'href',
      '/account/schedules',
    );
    expect(screen.getByRole('link', { name: 'Autopay' })).toHaveAttribute(
      'href',
      '/account/autopay',
    );
  });

  it('explains itself when a node has nowhere to send you, and offers the way in', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SourcingHub />, { config: makeConfig(), session: GUEST });

    await user.click(screen.getByRole('button', { name: 'Schedule your Cart' }));

    const note = await screen.findByRole('status');
    expect(within(note).getByText(/Sign in to plan a delivery/)).toBeInTheDocument();
    expect(within(note).getByRole('link', { name: /Sign in/ })).toHaveAttribute('href', '/login');
  });

  it('links a guest to AI Mode as well', () => {
    renderWithProviders(<SourcingHub />, { config: makeConfig(), session: GUEST });

    // A link, not a button raising a sign-in note: somebody deciding whether
    // this catalogue has what they need may ask before opening an account.
    expect(screen.getByRole('link', { name: 'AI Assistant' })).toHaveAttribute('href', '/ai');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('links a customer straight to the AI Mode page', () => {
    // No panel to open and no event to dispatch: AI Mode is a page, so the
    // node is a link and middle-click and Open in new tab both work.
    renderWithProviders(<SourcingHub />, { config: makeConfig() });

    expect(screen.getByRole('link', { name: 'AI Assistant' })).toHaveAttribute('href', '/ai');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('highlights the spoke belonging to the node under the pointer', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<SourcingHub />, { config: makeConfig() });

    const root = container.querySelector('.orch');
    expect(root).not.toBeNull();
    expect(root).not.toHaveAttribute('data-orch-active');

    // The attribute is the whole mechanism — the stylesheet brightens the
    // line from it, and writing it costs no render.
    await user.hover(screen.getByRole('link', { name: 'ERP Integration' }));
    expect(root).toHaveAttribute('data-orch-active', 'erp');

    await user.unhover(screen.getByRole('link', { name: 'ERP Integration' }));
    expect(root).not.toHaveAttribute('data-orch-active');
  });

  it('leaves a session-dependent node inert until the session is known', () => {
    renderWithProviders(<SourcingHub />, {
      config: makeConfig(),
      session: makeSession({ isLoading: true, isCustomer: false, user: null }),
    });

    expect(screen.getByRole('button', { name: 'Autopay' })).toBeDisabled();
    // The one that does not depend on the session is not held up by it.
    expect(screen.getByRole('link', { name: 'AI Assistant' })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderWithProviders(<SourcingHub />, { config: makeConfig() });

    await expectNoA11yViolations(container);
  });
});
