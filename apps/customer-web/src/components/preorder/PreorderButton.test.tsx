/**
 * The Preorder button: always present, truthful about what it will do, and
 * the one way into a preorder for all three entry points - the i beside it,
 * the bulk suggestion at the minimum, and the button itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import { PREORDER_EVENT } from '@/lib/preorder-info';
import { PreorderButton } from './PreorderButton';

const AVAILABLE = {
  available: true,
  offerId: '01OFFER0000000000000000000',
  sellerName: 'Gamma Manufacturing',
  currency: 'INR',
  listUnitPriceMinor: '10000',
  instantStockBaseUnits: 500,
  units: [
    { unit: 'PIECE', baseUnits: 1 },
    { unit: 'CARTON', baseUnits: 48 },
  ],
  moq: {
    unit: 'PIECE',
    quantity: 1000,
    incrementQuantity: 100,
    maxQuantity: null,
    minimumBaseUnits: 1000,
    incrementBaseUnits: 100,
    maximumBaseUnits: null,
  },
  pricingMode: 'FIXED',
  tiers: [{ minBaseUnits: 1000, unitPriceMinor: '9000' }],
  window: {
    today: '2026-09-24',
    earliest: '2026-10-04',
    latest: null,
    decidedBy: 'PRODUCTION',
    timezone: 'Asia/Kolkata',
    hasPublishedTransit: false,
  },
  deliveryCountries: [],
  allowPartialFulfilment: false,
  allowSplitDelivery: false,
  cancellationTerms: null,
  specialInstructions: null,
};

/** The same terms with a different minimum - a seller's own, or a variant's. */
function withMoq(quantity: number, unit = 'PIECE', unitSize = 1) {
  return {
    ...AVAILABLE,
    moq: {
      ...AVAILABLE.moq,
      unit,
      quantity,
      incrementQuantity: 1,
      minimumBaseUnits: quantity * unitSize,
      incrementBaseUnits: unitSize,
    },
  };
}

interface Viewer {
  signedIn: boolean;
  isBusinessBuyer: boolean;
  addressId: string | null;
  preorderInfo: { policyVersion: string; acknowledged: boolean };
}

function viewer(overrides: Partial<Viewer> = {}): Viewer {
  return {
    signedIn: true,
    isBusinessBuyer: true,
    addressId: null,
    preorderInfo: { policyVersion: 'PREORDER_INFO_V1', acknowledged: false },
    ...overrides,
  };
}

/**
 * The API, by URL. `eligibility` may depend on the variant asked about, which
 * is how a variant with its own minimum is modelled.
 */
function stubApi(
  eligibility: Record<string, unknown> | ((variantId: string | null) => unknown),
  who: Viewer,
  options: { acknowledgementStatus?: number; acknowledgementBody?: unknown } = {},
) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.includes('/preorders/acknowledgement') && method === 'POST') {
      const version = bodyOf(init).policyVersion;
      return Promise.resolve(
        jsonResponse(
          options.acknowledgementBody ?? {
            acknowledgement: {
              type: 'PREORDER_INFO',
              policyVersion: version,
              acknowledgedAt: '2026-09-24T10:00:00.000Z',
            },
          },
          options.acknowledgementStatus ?? 200,
        ),
      );
    }
    if (url.includes('/preorders/eligibility')) {
      const variantId = new URL(url, 'http://x').searchParams.get('variantId');
      const answer = typeof eligibility === 'function' ? eligibility(variantId) : eligibility;
      return Promise.resolve(jsonResponse({ eligibility: answer, viewer: who }));
    }
    if (url.includes('/account/addresses')) return Promise.resolve(jsonResponse({ addresses: [] }));
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function acknowledgementCalls(fetchMock: ReturnType<typeof stubApi>): unknown[] {
  return fetchMock.mock.calls
    .filter(([input, init]) => {
      const url = input instanceof Request ? input.url : input.toString();
      return url.includes('/preorders/acknowledgement') && init?.method?.toUpperCase() === 'POST';
    })
    .map(([, init]) => bodyOf(init));
}

function bodyOf(init: RequestInit | undefined): { policyVersion: string } {
  return JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { policyVersion: string };
}

function Where(): React.JSX.Element {
  const location = useLocation();
  return <p data-testid="where">{location.pathname + location.search}</p>;
}

/**
 * The product page's part in it: a quantity the buyer changes and an option
 * they can switch, feeding the button exactly as ProductPage does.
 */
function Page({
  initialPieces,
  regularOrderAllowed,
}: {
  initialPieces: number;
  regularOrderAllowed: boolean | null;
}): React.JSX.Element {
  const [pieces, setPieces] = useState(initialPieces);
  const [variantId, setVariantId] = useState<string | null>(null);
  return (
    <>
      <p data-testid="pieces">{pieces}</p>
      <button type="button" onClick={() => { setPieces((n) => n + 1); }}>
        plus one
      </button>
      <button type="button" onClick={() => { setPieces((n) => n - 1); }}>
        minus one
      </button>
      <button type="button" onClick={() => { setVariantId('01VARIANTLARGE000000000000'); }}>
        choose large
      </button>
      <PreorderButton
        productId="01PRODUCT00000000000000000"
        productName="Examination gloves"
        imageUrl={null}
        variantId={variantId}
        variantName={variantId === null ? null : 'Large'}
        isReady
        pieces={pieces}
        regularOrderAllowed={regularOrderAllowed}
      />
      <Where />
    </>
  );
}

function renderPage(
  options: {
    isCustomer?: boolean;
    route?: string;
    pieces?: number;
    regularOrderAllowed?: boolean | null;
    isReady?: boolean;
  } = {},
) {
  return renderWithProviders(
    <Routes>
      <Route
        path="/product/:slug"
        element={
          options.isReady === false ? (
            <PreorderButton
              productId="01PRODUCT00000000000000000"
              productName="Examination gloves"
              imageUrl={null}
              variantId={null}
              variantName={null}
              isReady={false}
            />
          ) : (
            <Page
              initialPieces={options.pieces ?? 1}
              regularOrderAllowed={options.regularOrderAllowed ?? true}
            />
          )
        }
      />
      <Route path="/login" element={<Where />} />
    </Routes>,
    {
      route: options.route ?? '/product/gloves?size=m',
      session:
        options.isCustomer === false ? makeSession({ isCustomer: false, user: null }) : makeSession(),
    },
  );
}

/** The Preorder button itself - not the i, whose name also says "preorder". */
async function preorderButton(): Promise<HTMLElement> {
  const button = await screen.findByRole('button', { name: /^preorder$/i });
  await waitFor(() => {
    expect(button).toBeEnabled();
  });
  return button;
}

function infoButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Preorder information' });
}

async function pressTimes(label: string, times: number): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    fireEvent.click(screen.getByRole('button', { name: label }));
  }
  // Let the suggestion's settle timer run.
  await act(async () => {
    await new Promise((resolve) => {
      setTimeout(resolve, 700);
    });
  });
}

describe('PreorderButton', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // --- What the button says about itself --------------------------------------

  it('stays visible and disabled, saying why, when the seller has configured nothing', async () => {
    stubApi(
      { available: false, reason: 'NOT_CONFIGURED', message: 'x', offerId: null, sellerName: null },
      viewer(),
    );
    renderPage();

    const button = await screen.findByRole('button', { name: /^preorder$/i });
    await waitFor(() => {
      expect(button).toBeDisabled();
    });
    expect(
      screen.getByText('Bulk preorder configuration is not currently available for this product.'),
    ).toBeInTheDocument();
    // The i is still there, and still says why rather than a minimum.
    fireEvent.click(infoButton());
    const dialog = await screen.findByRole('dialog', { name: 'Bulk preorder information' });
    expect(
      within(dialog).getByText('Bulk preorder configuration is not currently available for this product.'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
  });

  it('asks for an option first, without asking the server, when none is chosen', () => {
    const fetchMock = stubApi(AVAILABLE, viewer());
    renderPage({ isReady: false });

    expect(screen.getByRole('button', { name: /^preorder$/i })).toBeDisabled();
    expect(screen.getByText(/choose one option/i)).toBeInTheDocument();
    expect(infoButton()).toBeEnabled();
    // Nothing about the terms is asked for. (The chat button beside it may ask
    // whether the team is online; that is not a question about this product.)
    const asked = fetchMock.mock.calls.map(([input]) => (input instanceof Request ? input.url : input.toString()));
    expect(asked.filter((url) => !url.includes('/preorder-chats/availability'))).toEqual([]);
  });

  it('is disabled for an account with no company, with a way to add one', async () => {
    stubApi(AVAILABLE, viewer({ isBusinessBuyer: false }));
    renderPage();

    expect(await screen.findByText('Preorders are for business accounts.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^preorder$/i })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Add your company' })).toHaveAttribute('href', '/account/profile');
  });

  // --- 1-3. The i beside Preorder ------------------------------------------------

  it('lays out [ Preorder (i) ] [ Chat with UBOSS ] as separate, labelled buttons', async () => {
    stubApi(AVAILABLE, viewer());
    renderPage();

    const preorder = await preorderButton();
    const info = infoButton();
    // The i sits over Preorder's right end, but as a sibling, never nested: a
    // button inside a button is invalid and unusable.
    expect(preorder.contains(info)).toBe(false);
    expect(info.contains(preorder)).toBe(false);
    expect(preorder.nextElementSibling).toBe(info);
    const chat = screen.getByRole('button', { name: 'Chat with the Glovia team about this product' });
    expect(info.compareDocumentPosition(chat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(chat.contains(info)).toBe(false);
    expect(info).toHaveAttribute('aria-haspopup', 'dialog');
    expect(info).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the product’s own minimum from the i, and closes on Escape with focus back', async () => {
    stubApi(withMoq(10, 'UK_PALLET', 1200), viewer());
    renderPage();
    await preorderButton();

    const info = infoButton();
    info.focus();
    fireEvent.click(info);

    const dialog = await screen.findByRole('dialog', { name: 'Bulk preorder information' });
    expect(within(dialog).getByText('10 UK pallets')).toBeInTheDocument();
    expect(within(dialog).getByText('(12,000 pieces)')).toBeInTheDocument();
    expect(within(dialog).getByText(/does not accept any terms/)).toBeInTheDocument();
    expect(info).toHaveAttribute('aria-expanded', 'true');

    // Escape is the dialog's `cancel` event.
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(info);
    });
  });

  it('reports opening the information without naming the person', async () => {
    stubApi(AVAILABLE, viewer());
    const seen: unknown[] = [];
    const listener = (event: Event): void => {
      seen.push((event as CustomEvent).detail);
    };
    window.addEventListener(PREORDER_EVENT, listener);
    renderPage();
    await preorderButton();
    fireEvent.click(infoButton());
    await screen.findByRole('dialog');
    window.removeEventListener(PREORDER_EVENT, listener);

    expect(seen).toContainEqual({
      name: 'preorder_info_opened',
      productId: '01PRODUCT00000000000000000',
      variantId: null,
    });
    expect(JSON.stringify(seen)).not.toMatch(/@|email|userId/i);
  });

  // --- 4-6. First use asks first ------------------------------------------------

  it('asks for the acknowledgement on the first Preorder press instead of opening the form', async () => {
    const fetchMock = stubApi(AVAILABLE, viewer());
    renderPage({ pieces: 1500 });

    fireEvent.click(await preorderButton());

    const dialog = await screen.findByRole('dialog', { name: 'Bulk preorder information' });
    expect(screen.queryByText('Request a bulk preorder')).toBeNull();
    expect(within(dialog).getByText('1,000 pieces')).toBeInTheDocument();

    const agree = within(dialog).getByRole('button', { name: 'Agree and continue to preorder' });
    expect(agree).toBeDisabled();
    const box = within(dialog).getByRole('checkbox', {
      name: 'I understand the minimum quantity and preorder process.',
    });
    fireEvent.click(box);
    expect(agree).toBeEnabled();
    fireEvent.click(box);
    expect(agree).toBeDisabled();
    fireEvent.click(box);
    fireEvent.click(agree);

    // Recorded on the server at the version it named, then straight into the
    // form - on the quantity the page had, not reset to the minimum or to 0.
    expect(await screen.findByText('Request a bulk preorder')).toBeInTheDocument();
    expect(acknowledgementCalls(fetchMock)).toEqual([{ policyVersion: 'PREORDER_INFO_V1' }]);
    expect(screen.getByLabelText('How many')).toHaveValue('1500');
  });

  it('closes on "Not now" and records nothing', async () => {
    const fetchMock = stubApi(AVAILABLE, viewer());
    renderPage();
    fireEvent.click(await preorderButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Not now' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(acknowledgementCalls(fetchMock)).toEqual([]);
    expect(screen.queryByText('Request a bulk preorder')).toBeNull();
  });

  it('opens the form at the minimum when the page quantity is below it', async () => {
    stubApi(AVAILABLE, viewer({ preorderInfo: { policyVersion: 'PREORDER_INFO_V1', acknowledged: true } }));
    renderPage({ pieces: 3 });
    fireEvent.click(await preorderButton());
    expect(await screen.findByText('Request a bulk preorder')).toBeInTheDocument();
    expect(screen.getByLabelText('How many')).toHaveValue('1000');
  });

  it('shows the server’s refusal in place when the note changed while it was open', async () => {
    stubApi(AVAILABLE, viewer(), {
      acknowledgementStatus: 409,
      acknowledgementBody: {
        error: {
          code: 'PREORDER_INFO_OUTDATED',
          message: 'x',
          details: [{ field: 'policyVersion', code: 'OUTDATED', meta: { policyVersion: 'PREORDER_INFO_V2' } }],
        },
      },
    });
    renderPage();
    fireEvent.click(await preorderButton());
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agree and continue to preorder' }));

    expect(
      await within(dialog).findByText(
        'The preorder information has been updated. Read the new version and confirm it again.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Request a bulk preorder')).toBeNull();
  });

  // --- 7-8. Versions ---------------------------------------------------------------

  it('goes straight to the form when the current version is already acknowledged', async () => {
    const fetchMock = stubApi(
      AVAILABLE,
      viewer({ preorderInfo: { policyVersion: 'PREORDER_INFO_V1', acknowledged: true } }),
    );
    renderPage();
    fireEvent.click(await preorderButton());

    expect(await screen.findByText('Request a bulk preorder')).toBeInTheDocument();
    expect(acknowledgementCalls(fetchMock)).toEqual([]);
  });

  it('lets an acknowledged buyer read the note again without ticking it again', async () => {
    stubApi(AVAILABLE, viewer({ preorderInfo: { policyVersion: 'PREORDER_INFO_V1', acknowledged: true } }));
    renderPage();
    await preorderButton();
    fireEvent.click(infoButton());

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue to preorder' }));
    expect(await screen.findByText('Request a bulk preorder')).toBeInTheDocument();
  });

  it('asks again when the operator has raised the version', async () => {
    // The buyer acknowledged V1; the server now says V2 is current and that
    // this account has not acknowledged it.
    const fetchMock = stubApi(
      AVAILABLE,
      viewer({ preorderInfo: { policyVersion: 'PREORDER_INFO_V2', acknowledged: false } }),
    );
    renderPage();
    fireEvent.click(await preorderButton());

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agree and continue to preorder' }));
    await screen.findByText('Request a bulk preorder');
    expect(acknowledgementCalls(fetchMock)).toEqual([{ policyVersion: 'PREORDER_INFO_V2' }]);
  });

  // --- 9-12, 16. The bulk suggestion --------------------------------------------------

  it('suggests a preorder once when the quantity goes from 999 to 1,000', async () => {
    stubApi(AVAILABLE, viewer());
    renderPage({ pieces: 998 });
    await preorderButton();

    await pressTimes('plus one', 1); // 999: under, nothing
    expect(screen.queryByRole('dialog')).toBeNull();

    await pressTimes('plus one', 1); // 1,000: crossed
    const dialog = await screen.findByRole('dialog', { name: 'Ordering in bulk?' });
    expect(within(dialog).getByText('You have selected 1,000 pieces.')).toBeInTheDocument();
    expect(within(dialog).getByText('1,000 pieces')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Start preorder' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Continue with regular order' })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue with regular order' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    // The quantity is untouched by choosing the regular order.
    expect(screen.getByTestId('pieces')).toHaveTextContent('1000');

    // 1,000 → 1,001 → 1,005: already over, so nothing new.
    await pressTimes('plus one', 5);
    expect(screen.queryByRole('dialog')).toBeNull();

    // Back under and over again: dismissed for this product this session.
    await pressTimes('minus one', 10);
    await pressTimes('plus one', 10);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not interrupt a quantity that only passes through the minimum', async () => {
    stubApi(AVAILABLE, viewer());
    renderPage({ pieces: 999 });
    await preorderButton();
    // Up and straight back down before the quantity settles.
    fireEvent.click(screen.getByRole('button', { name: 'plus one' }));
    fireEvent.click(screen.getByRole('button', { name: 'minus one' }));
    await pressTimes('minus one', 0);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('uses the product’s own minimum, not a default', async () => {
    stubApi(withMoq(250), viewer());
    renderPage({ pieces: 249 });
    await preorderButton();
    await pressTimes('plus one', 1);
    const dialog = await screen.findByRole('dialog', { name: 'Ordering in bulk?' });
    expect(within(dialog).getByText('250 pieces')).toBeInTheDocument();
  });

  it('says so, with no regular-order button, where a regular order is not allowed', async () => {
    stubApi(AVAILABLE, viewer());
    renderPage({ pieces: 999, regularOrderAllowed: false });
    await preorderButton();
    await pressTimes('plus one', 1);
    const dialog = await screen.findByRole('dialog', { name: 'Ordering in bulk?' });
    expect(within(dialog).queryByRole('button', { name: 'Continue with regular order' })).toBeNull();
    expect(within(dialog).getByText(/a regular order is not available/i)).toBeInTheDocument();
  });

  it('leads "Start preorder" through the acknowledgement into the form, quantity kept', async () => {
    const fetchMock = stubApi(AVAILABLE, viewer());
    renderPage({ pieces: 999 });
    await preorderButton();
    await pressTimes('plus one', 1);

    fireEvent.click(await screen.findByRole('button', { name: 'Start preorder' }));
    const dialog = await screen.findByRole('dialog', { name: 'Bulk preorder information' });
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agree and continue to preorder' }));

    expect(await screen.findByText('Request a bulk preorder')).toBeInTheDocument();
    expect(screen.getByLabelText('How many')).toHaveValue('1000');
    expect(acknowledgementCalls(fetchMock)).toHaveLength(1);
  });

  it('goes from "Start preorder" straight to the form once acknowledged', async () => {
    stubApi(AVAILABLE, viewer({ preorderInfo: { policyVersion: 'PREORDER_INFO_V1', acknowledged: true } }));
    renderPage({ pieces: 999 });
    await preorderButton();
    await pressTimes('plus one', 1);
    fireEvent.click(await screen.findByRole('button', { name: 'Start preorder' }));
    expect(await screen.findByText('Request a bulk preorder')).toBeInTheDocument();
  });

  it('reads a new option’s own minimum as soon as the option changes', async () => {
    stubApi(
      (variantId) => (variantId === null ? withMoq(1000) : withMoq(50, 'CARTON', 48)),
      viewer(),
    );
    renderPage();
    await preorderButton();
    fireEvent.click(infoButton());
    expect(await within(await screen.findByRole('dialog')).findByText('1,000 pieces')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });

    fireEvent.click(screen.getByRole('button', { name: 'choose large' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^preorder$/i })).toBeEnabled();
    });
    fireEvent.click(infoButton());
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('50 cartons')).toBeInTheDocument();
    expect(within(dialog).getByText('(2,400 pieces)')).toBeInTheDocument();
  });

  // --- Guests -----------------------------------------------------------------------

  it('lets a guest read and tick the note, then sends them to sign in with the intent kept', async () => {
    const fetchMock = stubApi(AVAILABLE, viewer({ signedIn: false, isBusinessBuyer: false }));
    renderPage({ isCustomer: false });

    fireEvent.click(await preorderButton());
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/sign in to your business account/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Agree and continue to preorder' }));

    const where = screen.getByTestId('where').textContent;
    expect(where.startsWith('/login?next=')).toBe(true);
    expect(decodeURIComponent(where.slice('/login?next='.length))).toBe(
      '/product/gloves?size=m&preorder=1',
    );
    // Nothing recorded for a guest: there is no account to record it against.
    expect(acknowledgementCalls(fetchMock)).toEqual([]);
  });

  it('records a guest’s tick against their account after sign-in, then opens the form', async () => {
    window.sessionStorage.setItem('uboss.preorder.guestAcknowledged', 'PREORDER_INFO_V1');
    const fetchMock = stubApi(AVAILABLE, viewer());
    renderPage({ route: '/product/gloves?size=m&preorder=1' });

    expect(await screen.findByText('Request a bulk preorder')).toBeInTheDocument();
    expect(acknowledgementCalls(fetchMock)).toEqual([{ policyVersion: 'PREORDER_INFO_V1' }]);
    await waitFor(() => {
      expect(screen.getByTestId('where').textContent).toBe('/product/gloves?size=m');
    });
  });

  it('back from sign-in without a tick, asks for it before the form', async () => {
    stubApi(AVAILABLE, viewer());
    renderPage({ route: '/product/gloves?size=m&preorder=1' });

    expect(await screen.findByRole('dialog', { name: 'Bulk preorder information' })).toBeInTheDocument();
    expect(screen.queryByText('Request a bulk preorder')).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId('where').textContent).toBe('/product/gloves?size=m');
    });
  });

  it('reopens the form after sign-in for a buyer who has already acknowledged', async () => {
    stubApi(AVAILABLE, viewer({ preorderInfo: { policyVersion: 'PREORDER_INFO_V1', acknowledged: true } }));
    renderPage({ route: '/product/gloves?size=m&preorder=1' });

    expect(await screen.findByText('Request a bulk preorder')).toBeInTheDocument();
    expect(screen.getByText('In pieces: at least 1,000, then in steps of 100.')).toBeInTheDocument();
    expect(screen.getAllByText('Nothing is charged when you send a request.').length).toBeGreaterThan(0);
  });
});
