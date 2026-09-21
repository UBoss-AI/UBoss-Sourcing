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
 *   - **Nothing typed is ever lost.** A step keeps every keystroke on the
 *     device as it is typed and offers it back on the next visit, which is
 *     what makes an expired session survivable. That is the property the last
 *     group here holds the screen to, because it is the one a seller notices
 *     only when it has already failed them.
 */
import { screen, waitFor, within } from '@testing-library/react';
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
  // Drafts live on the device and outlive a test unless they are swept.
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.localStorage.clear();
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

/*
 * What happens to a half-filled step nobody pressed Save on.
 *
 * The scenario these are written from is the one a seller reported: they were
 * partway through their business details, went to find a certificate, came
 * back to an expired session, signed in again and found empty boxes. Nothing
 * in the code was broken - there was simply no copy of what they had typed
 * anywhere but the tab they had left.
 *
 * So: the copy is written on the keystroke, it is offered back by name rather
 * than slipped in silently, and it can be thrown away. A sign-in is a page
 * load, which is why the second test reloads the screen rather than trying to
 * simulate one.
 */
describe('work that was typed but never sent', () => {
  it('keeps every keystroke on the device without anybody pressing Save', async () => {
    serve(onboarding({ lastStepKey: 'store_profile' }), {
      account: { displayName: 'Onboarding Steps Co', description: null },
      profile: { supportEmail: null, supportPhone: null },
    });
    renderPage();

    expect(await openStepHeading()).toBe('Store details');

    await userEvent.type(await screen.findByLabelText(/About your business/), 'We pack stationery.');

    // No Save, no PATCH - and the answer is already somewhere other than React.
    await waitFor(() => {
      expect(window.localStorage.length).toBe(1);
    });

    const raw = window.localStorage.getItem(
      'uboss.seller.onboarding.v1.seller-1.store_profile',
    );
    expect(raw).not.toBeNull();
    expect(raw).toContain('We pack stationery.');
  });

  it('offers it back when the seller returns, and says where it came from', async () => {
    serve(onboarding({ lastStepKey: 'store_profile' }), {
      account: { displayName: 'Onboarding Steps Co', description: null },
      profile: { supportEmail: null, supportPhone: null },
    });

    // What the previous visit left behind before the session ended.
    window.localStorage.setItem(
      'uboss.seller.onboarding.v1.seller-1.store_profile',
      JSON.stringify({
        savedAt: Date.now(),
        values: {
          description: 'We pack stationery.',
          supportEmail: null,
          supportPhone: null,
        },
      }),
    );

    renderPage();

    expect(await openStepHeading()).toBe('Store details');

    // Back in the box...
    const description = await screen.findByLabelText(/About your business/);
    expect(description).toHaveValue('We pack stationery.');

    // ...and said out loud, rather than quietly disagreeing with the server.
    expect(screen.getByText(/brought back what you typed/i)).toBeInTheDocument();
  });

  /*
   * Found on screen rather than reasoned about, which is why it is here.
   *
   * The auto-save sent the support email, the step went green, the draft was
   * dropped because the server had it - and reopening the step showed an EMPTY
   * box. A reopened form has no local edit, so it falls back to the stored
   * profile, and the page was still holding the copy it fetched before the
   * save. "Done" beside an empty required field is exactly the disagreement
   * this whole feature exists to prevent.
   */
  it('re-reads the stored profile after saving by itself, not just the checklist', async () => {
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

    // The debounce, then the PATCH nobody pressed a button for.
    await waitFor(
      () => {
        expect(lastPatchTo('/seller/store-profile')).toMatchObject({
          supportEmail: 'help@onboarding-steps.example',
        });
      },
      { timeout: 6000 },
    );

    const patchAt = fetchMock.mock.calls.findIndex(
      ([input, init]) =>
        String(input).includes('/seller/store-profile') &&
        (init as RequestInit | undefined)?.method === 'PATCH',
    );

    await waitFor(
      () => {
        const refetched = fetchMock.mock.calls
          .slice(patchAt + 1)
          .some(([input]) => String(input).includes('/seller/business-profile'));
        expect(refetched).toBe(true);
      },
      { timeout: 6000 },
    );
  }, 15000);

  it('throws it away and shows what is stored when the seller says so', async () => {
    serve(onboarding({ lastStepKey: 'store_profile' }), {
      account: { displayName: 'Onboarding Steps Co', description: 'What the server holds.' },
      profile: { supportEmail: null, supportPhone: null },
    });

    window.localStorage.setItem(
      'uboss.seller.onboarding.v1.seller-1.store_profile',
      JSON.stringify({
        savedAt: Date.now(),
        values: { description: 'A draft nobody sent.', supportEmail: null, supportPhone: null },
      }),
    );

    renderPage();

    expect(await openStepHeading()).toBe('Store details');
    expect(await screen.findByLabelText(/About your business/)).toHaveValue('A draft nobody sent.');

    await userEvent.click(screen.getByRole('button', { name: /Discard/i }));

    expect(await screen.findByLabelText(/About your business/)).toHaveValue(
      'What the server holds.',
    );
    expect(screen.queryByText(/brought back what you typed/i)).not.toBeInTheDocument();
    expect(window.localStorage.length).toBe(0);
  });
});
