/**
 * The greeting page's hub and account panel.
 *
 * What these are actually guarding is the one rule the whole feature rests on:
 * **a node never offers something the person pressing it cannot have.** A
 * decorative diagram that quietly links a guest into a session guard, or links
 * anybody at all into a feature this deployment has switched off, is worse
 * than no diagram — and it is exactly the kind of regression that a screenshot
 * review sails straight past, because it looks perfect until it is pressed.
 *
 * The animation itself is not asserted here and cannot be: jsdom has no
 * layout, no computed transform and no `matchMedia`, so "the orb rotates" is
 * not a thing this suite can know. What it *can* know is the structural fact
 * the animation depends on — that the word in the middle is not inside the
 * element that spins — and that is checked below. The motion itself is
 * verified by a person in a browser, including with reduced motion switched
 * on, which `docs/ACCESSIBILITY.md` already says is how this project treats
 * the properties jsdom cannot see.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GreetingPanel } from './GreetingPanel';
import { SourcingHub } from './SourcingHub';
import { resolveNode } from './orchestration-nodes';
import type { OrchestrationAccess } from './orchestration-nodes';
import { ASSISTANT_OPEN_EVENT } from '@/lib/assistant-panel';
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

/** One active plan, running a week on Tuesday. */
function makeSchedule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sch-1',
    name: 'Theatre consumables',
    status: 'ACTIVE',
    summary: 'Every 7 days at 06:00 (Asia/Kolkata)',
    frequency: 'WEEKLY',
    intervalDays: null,
    weekday: 2,
    monthDay: null,
    timezone: 'Asia/Kolkata',
    runAtMinute: 360,
    startDate: '2026-09-01',
    endDate: null,
    maxOccurrences: null,
    occurrenceCount: 3,
    nextRunAt: '2026-09-15T00:30:00.000Z',
    lastRunAt: '2026-09-08T00:30:00.000Z',
    paymentMode: 'AUTO',
    payerEmail: null,
    hasMandate: true,
    consentAcceptedAt: '2026-08-01T09:00:00.000Z',
    failureCount: 0,
    maxFailures: 3,
    pausedReason: null,
    cancelReason: null,
    itemCount: 4,
    ...overrides,
  };
}

function makeAutoPay(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'ACTIVE',
    enabled: true,
    paymentMethodId: 'pm-1',
    paymentMethodLabel: 'Visa ending 4242',
    paymentMethodUsable: true,
    maxTransactionMinor: null,
    approvalThresholdMinor: null,
    limitCurrency: null,
    retryPreference: 'STANDARD',
    notifyOnCharge: true,
    notifyOnFailure: true,
    consentAcceptedAt: '2026-08-01T09:00:00.000Z',
    consentVersion: '1',
    consentWithdrawnAt: null,
    enabledAt: '2026-08-01T09:00:00.000Z',
    pausedAt: null,
    currentConsentVersion: '1',
    ...overrides,
  };
}

const fetchMock = vi.fn();

/** Serve the three optional reads the account panel makes. */
function serveAccount({
  fullName = 'Priya Nair',
  schedules = [makeSchedule()],
  autoPay = makeAutoPay(),
  autoPayAvailable = true,
}: {
  fullName?: string | null;
  schedules?: Record<string, unknown>[];
  autoPay?: Record<string, unknown>;
  autoPayAvailable?: boolean;
} = {}): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/account/autopay')) {
      return Promise.resolve(
        jsonResponse({ autoPay, available: autoPayAvailable, consentVersion: '1' }),
      );
    }

    if (url.includes('/account/profile')) {
      return Promise.resolve(
        jsonResponse({
          profile: {
            id: 'profile-1',
            email: 'buyer@example.test',
            fullName,
            organization: null,
            department: null,
            phone: null,
            gstin: null,
            consentAcceptedAt: null,
            activatedAt: null,
            lastLoginAt: null,
            orderCount: 2,
            scheduleCount: schedules.length,
          },
          purchasingLimits: {
            perOrderMinMinor: null,
            perOrderMaxMinor: null,
            requiresOrderApproval: false,
            currency: 'INR',
          },
          spend: {
            monthToDateMinor: '0',
            capMinor: null,
            remainingMinor: null,
            currency: 'INR',
          },
        }),
      );
    }

    if (url.includes('/recurring-schedules')) {
      return Promise.resolve(jsonResponse({ schedules }));
    }

    return Promise.resolve(jsonResponse({}));
  });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  serveAccount();
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

    for (const id of ['schedules', 'autopay', 'assistant'] as const) {
      const outcome = resolveNode(id, guest);

      expect(outcome.kind).toBe('note');
      // The way *in*, not the way to the guarded page.
      expect(outcome).toMatchObject({ to: '/login' });
    }
  });

  it('offers a guest no AI action at all, only a way in', () => {
    const outcome = resolveNode('assistant', makeAccess({ isCustomer: false }));

    expect(outcome.kind).not.toBe('assistant');
    expect(outcome).toMatchObject({ to: '/login' });
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
    // Both of these would otherwise answer "sign in" and then change their
    // minds 200ms later, which is the flicker the pending state exists for.
    expect(resolveNode('autopay', makeAccess({ isSessionLoading: true }))).toEqual({
      kind: 'pending',
    });
    expect(resolveNode('assistant', makeAccess({ isSessionLoading: true }))).toEqual({
      kind: 'pending',
    });
  });

  it('keeps the two administrator-owned nodes out of a customer route', () => {
    // Warehouses and ERP have no customer screen and are not supposed to grow
    // one: a connection is a URL plus a credential belonging to whoever runs
    // the installation. Both explain, whoever is asking.
    for (const access of [makeAccess(), makeAccess({ isCustomer: false })]) {
      expect(resolveNode('erp', access).kind).toBe('note');
      expect(resolveNode('warehouses', access)).toMatchObject({
        kind: 'note',
        to: '/products',
      });
    }
  });

  it('sends inventory to the catalogue, which is open to everybody', () => {
    expect(resolveNode('inventory', makeAccess({ isCustomer: false }))).toEqual({
      kind: 'link',
      to: '/products',
    });
  });
});

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

describe('the sourcing hub', () => {
  it('renders all six capabilities as one list of controls', () => {
    renderWithProviders(<SourcingHub />, { config: makeConfig() });

    const list = screen.getByRole('list');

    // Some are links and some are buttons — which one a node is depends on
    // whether it has anywhere to send this particular visitor. What matters
    // here is that all six are controls in one list, in one tab order.
    const controls = [
      ...within(list).getAllByRole('link'),
      ...within(list).getAllByRole('button'),
    ].map((element) => element.getAttribute('aria-labelledby'));

    expect(controls).toHaveLength(6);

    for (const label of [
      'AI Assistant',
      'Warehouse Network',
      'Scheduled Orders',
      'ERP Integration',
      'Autopay',
      'Inventory Sync',
    ]) {
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

  it('says nothing to a screen reader that the nodes do not already say', () => {
    const { container } = renderWithProviders(<SourcingHub />, { config: makeConfig() });

    // Every name in the drawing is also rendered as text in the node beside
    // it. A diagram that announced itself would read the same six words twice.
    expect(container.querySelector('svg.orch-web')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('gives each node its own name and its own description', () => {
    renderWithProviders(<SourcingHub />, { config: makeConfig() });

    const node = screen.getByRole('button', { name: 'ERP Integration' });

    // Not one merged label: "ERP Integration Orders handed to your own system,
    // button" is not a thing anybody can skim a list of six of.
    expect(node).toHaveAccessibleName('ERP Integration');
    expect(node).toHaveAccessibleDescription('Orders handed to your own system');
  });

  it('takes a customer straight to the screen a node stands for', () => {
    renderWithProviders(<SourcingHub />, { config: makeConfig() });

    expect(screen.getByRole('link', { name: 'Scheduled Orders' })).toHaveAttribute(
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

    await user.click(screen.getByRole('button', { name: 'Scheduled Orders' }));

    const note = await screen.findByRole('status');
    expect(within(note).getByText(/Sign in to plan a delivery/)).toBeInTheDocument();
    expect(within(note).getByRole('link', { name: /Sign in/ })).toHaveAttribute('href', '/login');
  });

  it('does not offer a guest an AI composer, only a way in', async () => {
    const user = userEvent.setup();
    const opened = vi.fn();
    window.addEventListener(ASSISTANT_OPEN_EVENT, opened);

    renderWithProviders(<SourcingHub />, { config: makeConfig(), session: GUEST });
    await user.click(screen.getByRole('button', { name: 'AI Assistant' }));

    expect(opened).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(/signed-in account/);

    window.removeEventListener(ASSISTANT_OPEN_EVENT, opened);
  });

  it('opens the chat panel for a customer instead of navigating anywhere', async () => {
    const user = userEvent.setup();
    const opened = vi.fn();
    window.addEventListener(ASSISTANT_OPEN_EVENT, opened);

    renderWithProviders(<SourcingHub />, { config: makeConfig() });
    await user.click(screen.getByRole('button', { name: 'AI Assistant' }));

    expect(opened).toHaveBeenCalledTimes(1);
    // Nothing to dismiss: the panel it opened is the answer.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    window.removeEventListener(ASSISTANT_OPEN_EVENT, opened);
  });

  it('highlights the spoke belonging to the node under the pointer', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<SourcingHub />, { config: makeConfig() });

    const root = container.querySelector('.orch');
    expect(root).not.toBeNull();
    expect(root).not.toHaveAttribute('data-orch-active');

    // The attribute is the whole mechanism — the stylesheet brightens the
    // line from it, and writing it costs no render.
    await user.hover(screen.getByRole('button', { name: 'ERP Integration' }));
    expect(root).toHaveAttribute('data-orch-active', 'erp');

    await user.unhover(screen.getByRole('button', { name: 'ERP Integration' }));
    expect(root).not.toHaveAttribute('data-orch-active');
  });

  it('leaves every node inert until the session is known', () => {
    renderWithProviders(<SourcingHub />, {
      config: makeConfig(),
      session: makeSession({ isLoading: true, isCustomer: false, user: null }),
    });

    expect(screen.getByRole('button', { name: 'Autopay' })).toBeDisabled();
    // The ones that do not depend on the session are not held up by it.
    expect(screen.getByRole('link', { name: 'Inventory Sync' })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderWithProviders(<SourcingHub />, { config: makeConfig() });

    await expectNoA11yViolations(container);
  });
});

// ---------------------------------------------------------------------------
// The account panel
// ---------------------------------------------------------------------------

describe('the account panel', () => {
  it('renders nothing at all for a guest', () => {
    renderWithProviders(<GreetingPanel />, { config: makeConfig(), session: GUEST });

    expect(screen.queryByRole('region', { name: 'Your account' })).not.toBeInTheDocument();
    // And asks the account API for nothing, either. Every read is `enabled`
    // behind the customer gate, so a stranger on the front page makes exactly
    // the requests they made before this panel existed: none.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the soonest delivery and a way to manage it', async () => {
    renderWithProviders(<GreetingPanel />, { config: makeConfig() });

    expect(await screen.findByText('Next scheduled order')).toBeInTheDocument();
    expect(screen.getByText(/Theatre consumables/)).toBeInTheDocument();
    // The server's own words for the recurrence, never rebuilt here.
    expect(screen.getByText(/Every 7 days at 06:00/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Manage schedule/ })).toHaveAttribute(
      'href',
      '/account/schedules/sch-1',
    );
  });

  it('picks the soonest of several plans, not the first one listed', async () => {
    serveAccount({
      schedules: [
        makeSchedule({ id: 'sch-late', name: 'Quarterly', nextRunAt: '2026-12-01T00:30:00.000Z' }),
        makeSchedule({ id: 'sch-soon', name: 'Weekly', nextRunAt: '2026-09-11T00:30:00.000Z' }),
      ],
    });

    renderWithProviders(<GreetingPanel />, { config: makeConfig() });

    expect(await screen.findByRole('link', { name: /Manage schedule/ })).toHaveAttribute(
      'href',
      '/account/schedules/sch-soon',
    );
  });

  it('says a charge will fail before it fails', async () => {
    serveAccount({ autoPay: makeAutoPay({ paymentMethodUsable: false }) });

    renderWithProviders(<GreetingPanel />, { config: makeConfig() });

    expect(await screen.findByText('Payment action required')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open Autopay/ })).toHaveAttribute(
      'href',
      '/account/autopay',
    );
  });

  it('reports a paused authority as its own thing, not as a broken card', async () => {
    serveAccount({ autoPay: makeAutoPay({ status: 'PAUSED', enabled: true }) });

    renderWithProviders(<GreetingPanel />, { config: makeConfig() });

    expect(await screen.findByText('Autopay is paused')).toBeInTheDocument();
    expect(screen.queryByText('Payment action required')).not.toBeInTheDocument();
  });

  it('warns when something is scheduled and nothing can pay for it', async () => {
    serveAccount({
      autoPay: makeAutoPay({ status: 'DISABLED', enabled: false, paymentMethodId: null }),
    });

    renderWithProviders(<GreetingPanel />, { config: makeConfig() });

    expect(await screen.findByText('Payment action required')).toBeInTheDocument();
    expect(screen.getByText(/no standing authority to charge/)).toBeInTheDocument();
  });

  /*
   * Guidance is guidance. Every action above it stays live, because a
   * customer who has not finished setting up auto-pay can still order — and a
   * setup notice that disables the buttons beside it turns a five-minute task
   * into a support call.
   */
  it('never lets setup guidance take an action away', async () => {
    serveAccount({ autoPay: makeAutoPay({ paymentMethodUsable: false }) });

    renderWithProviders(<GreetingPanel />, { config: makeConfig() });

    expect(await screen.findByText('Payment action required')).toBeInTheDocument();

    for (const name of ['View dashboard', 'Build a cart', 'Schedule a cart']) {
      expect(screen.getByRole('link', { name: new RegExp(name) })).toBeInTheDocument();
    }
  });

  it('explains the ERP hand-off rather than pretending to be able to do it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GreetingPanel />, { config: makeConfig() });

    const toggle = await screen.findByRole('button', { name: /Connect ERP API/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/created by an administrator under Settings/)).toBeInTheDocument();
  });

  it('offers no repeat-purchase action on a deployment that has them switched off', async () => {
    renderWithProviders(<GreetingPanel />, { config: makeConfig({ recurringOrders: false }) });

    expect(await screen.findByRole('link', { name: /View dashboard/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Schedule a cart/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Next scheduled order')).not.toBeInTheDocument();
  });

  it('offers no AI action on a deployment with no assistant', async () => {
    renderWithProviders(<GreetingPanel />, { config: makeConfig({ assistant: false }) });

    expect(await screen.findByRole('link', { name: /View dashboard/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ask AI/ })).not.toBeInTheDocument();
  });

  it('survives an account with no name on it', async () => {
    serveAccount({ fullName: null, schedules: [] });

    renderWithProviders(<GreetingPanel />, { config: makeConfig() });

    // The panel still renders; nothing anywhere says "undefined".
    expect(await screen.findByText(/no repeat purchases running/)).toBeInTheDocument();
    expect(screen.getByText('Your account')).toBeInTheDocument();
  });

  it('keeps the page usable when the account reads fail', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({}, 500)));

    renderWithProviders(<GreetingPanel />, { config: makeConfig() });

    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
    // The actions are not casualties of a failed summary.
    expect(screen.getByRole('link', { name: /Build a cart/ })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    renderWithProviders(<GreetingPanel />, { config: makeConfig() });
    const panel = await screen.findByRole('region', { name: 'Your account' });

    await expectNoA11yViolations(panel);
  });
});
