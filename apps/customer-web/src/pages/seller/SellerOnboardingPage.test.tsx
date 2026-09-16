/**
 * Where the seller application opens, and how somebody moves through it.
 *
 * The screen used to open on the first UNFINISHED step. Contact verification
 * is step one and is normally already done, so a seller who had never seen
 * this page before was dropped into the middle of their own application - and
 * the step it landed on was whichever one the server had touched last, not one
 * they had chosen.
 *
 * Two properties, both of which a person would notice and neither of which a
 * type checker would:
 *
 *   - **It opens at the beginning** when there is nothing to carry on from.
 *   - **There is a way forward from a step** without going back to the rail,
 *     which on a phone is off the bottom of the screen by the time a step is
 *     filled in.
 */
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SellerOnboardingPage } from './SellerOnboardingPage';
import type { SellerIdentity } from '@/lib/seller';
import { jsonResponse, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  // jsdom has no layout, so it has no scrolling either.
  vi.stubGlobal('scrollTo', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function step(
  key: string,
  title: string,
  state: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    key,
    title,
    summary: `About ${title}.`,
    state,
    isRequiredForSubmission: true,
    message: null,
    requirements: [],
    ...overrides,
  };
}

/** An application with the first step done and the rest not started. */
function onboarding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    steps: [
      step('account_verification', 'Contact verification', 'COMPLETE'),
      step('business_identity', 'Business identity', 'NOT_STARTED'),
      step('store_profile', 'Store details', 'IN_PROGRESS'),
    ],
    completedSteps: 1,
    requiredSteps: 3,
    percentComplete: 33,
    lastStepKey: null,
    canSubmit: false,
    blockingSteps: [
      { key: 'business_identity', title: 'Business identity' },
      { key: 'store_profile', title: 'Store details' },
    ],
    ...overrides,
  };
}

const seller: SellerIdentity = {
  sellerAccountId: 'seller-1',
  displayName: 'Onboarding Steps Co',
  legalName: 'Onboarding Steps Co Ltd',
  slug: 'onboarding-steps-co',
  status: 'DRAFT',
  role: 'OWNER',
  isTrading: false,
  isApplicationEditable: true,
  logoUrl: null,
  permissions: [],
  lock: { isSet: true, isOpen: true },
};

function serve(
  view: Record<string, unknown>,
  stored: { account?: Record<string, unknown> | null; profile?: Record<string, unknown> | null } = {},
): void {
  fetchMock.mockImplementation((input: unknown) => {
    const url = String(input);

    if (url.includes('/seller/onboarding')) return Promise.resolve(jsonResponse(view));
    if (url.includes('/seller/business-profile')) {
      return Promise.resolve(
        jsonResponse({ account: stored.account ?? null, profile: stored.profile ?? null }),
      );
    }
    if (url.includes('/seller/store-profile')) {
      return Promise.resolve(jsonResponse({ state: 'COMPLETE', missing: [] }));
    }

    return Promise.resolve(jsonResponse({}));
  });
}

/** The body of the last PATCH the page sent to one endpoint. */
function lastPatchTo(path: string): Record<string, unknown> {
  const call = [...fetchMock.mock.calls]
    .reverse()
    .find(([input, init]) => String(input).includes(path) && (init as RequestInit | undefined)?.method === 'PATCH');

  if (call === undefined) throw new Error(`No PATCH to ${path}`);

  const { body } = call[1] as RequestInit;
  if (typeof body !== 'string') throw new Error(`The PATCH to ${path} sent no JSON body`);

  return JSON.parse(body) as Record<string, unknown>;
}

function renderPage(): void {
  renderWithProviders(
    <Routes>
      <Route element={<Outlet context={seller} />}>
        <Route path="/seller/onboarding" element={<SellerOnboardingPage />} />
      </Route>
    </Routes>,
    { route: '/seller/onboarding' },
  );
}

/** The panel on the right, by the step whose heading it carries. */
async function openStepHeading(): Promise<string> {
  const headings = await screen.findAllByRole('heading', { level: 2 });
  return headings[0]?.textContent ?? '';
}

describe('SellerOnboardingPage', () => {
  it('opens on contact verification, not on the first unfinished step', async () => {
    serve(onboarding());
    renderPage();

    expect(await openStepHeading()).toBe('Contact verification');
  });

  it('carries on from the step the seller last saved', async () => {
    serve(onboarding({ lastStepKey: 'store_profile' }));
    renderPage();

    expect(await openStepHeading()).toBe('Store details');
  });

  it('offers the next step from the bottom of the one on screen', async () => {
    serve(onboarding());
    renderPage();

    expect(await openStepHeading()).toBe('Contact verification');

    const moving = screen.getByRole('navigation', { name: 'Move between steps' });
    await userEvent.click(
      within(moving).getByRole('button', { name: /Business identity/ }),
    );

    expect(await openStepHeading()).toBe('Business identity');

    // And back, which the first step did not offer.
    await userEvent.click(within(moving).getByRole('button', { name: /Back/ }));
    expect(await openStepHeading()).toBe('Contact verification');
  });

  /*
   * The bug a seller actually hit: Store details needs a description AND a
   * support email, the form sent every box on every save, and an untouched box
   * went out as `null` - which clears it. So entering the second wiped the
   * first and the step could never be finished.
   */
  it('sends the description it is showing, not a null for the box nobody touched', async () => {
    serve(onboarding({ lastStepKey: 'store_profile' }), {
      account: { displayName: 'Onboarding Steps Co', description: 'We pack stationery.' },
      profile: { supportEmail: null, supportPhone: null },
    });
    renderPage();

    expect(await openStepHeading()).toBe('Store details');

    await userEvent.type(
      await screen.findByLabelText(/Support email/),
      'help@onboarding-steps.example',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await screen.findByText(/This step is finished/);

    expect(lastPatchTo('/seller/store-profile')).toEqual({
      description: 'We pack stationery.',
      supportEmail: 'help@onboarding-steps.example',
      supportPhone: null,
    });
  });
});
