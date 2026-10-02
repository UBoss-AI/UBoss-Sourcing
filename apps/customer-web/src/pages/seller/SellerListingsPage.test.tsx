/**
 * Seller Hub -> Listings: archiving (checklist SCREEN-035).
 *
 *   - a live listing has an Archive action, and it asks before doing anything;
 *   - confirming sends the ARCHIVED status to the listing status route;
 *   - keeping it sends nothing;
 *   - an archived listing has no Archive action and shows the translated label.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, Route, Routes } from 'react-router-dom';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import type { OfferRow } from '@/lib/seller';
import { SellerListingsPage } from './SellerListingsPage';
import type { SellerOutletContext } from './SellerLayout';

const SELLER = {
  status: 'APPROVED',
  displayName: 'Acme Medical',
  isTrading: true,
} as unknown as SellerOutletContext;

const fetchMock = vi.fn<typeof fetch>();

function row(overrides: Partial<OfferRow> = {}): OfferRow {
  return {
    id: 'O1'.padEnd(26, '0'),
    status: 'ACTIVE',
    productId: 'P1'.padEnd(26, '0'),
    productName: 'Valve body',
    productSlug: 'valve-body',
    imageUrl: null,
    sellerSku: 'VALVE-001',
    brandName: null,
    priceMinor: '12000',
    currency: 'INR',
    minimumOrderQuantity: 1,
    availableQuantity: 10,
    reservedQuantity: 0,
    qualityScore: null,
    statusReason: null,
    updatedAt: '2026-09-01T00:00:00.000Z',
    locations: [],
    ...overrides,
  };
}

interface Call {
  url: string;
  method: string;
  body: unknown;
}
const calls: Call[] = [];

function serve(rows: OfferRow[]): void {
  fetchMock.mockImplementation((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    if (url.includes('/status')) return Promise.resolve(new Response(null, { status: 204 }));
    if (url.includes('/seller/listings')) {
      return Promise.resolve(jsonResponse({ rows, total: rows.length, counts: { ACTIVE: 1 } }));
    }
    return Promise.resolve(jsonResponse({ rows: [], total: 0, counts: {} }));
  });
}

function render(route = '/seller/listings'): void {
  renderWithProviders(
    <Routes>
      <Route element={<Outlet context={SELLER} />}>
        <Route path="/seller/listings" element={<SellerListingsPage />} />
      </Route>
    </Routes>,
    { route },
  );
}

beforeEach(() => {
  calls.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('archiving a listing', () => {
  it('asks first, then archives through the status route', async () => {
    const user = userEvent.setup();
    serve([row()]);
    render();

    const [archive] = await screen.findAllByRole('button', { name: 'Archive' });
    await user.click(archive!);

    // Nothing has been sent yet: opening the dialog is not archiving.
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Archive VALVE-001\?/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Archive this listing' }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === 'PATCH');
      expect(patch?.url).toContain(`/seller/listings/${'O1'.padEnd(26, '0')}/status`);
      expect(patch?.body).toMatchObject({ status: 'ARCHIVED' });
    });
  });

  it('sends nothing when the seller keeps the listing', async () => {
    const user = userEvent.setup();
    serve([row()]);
    render();

    const [archive] = await screen.findAllByRole('button', { name: 'Archive' });
    await user.click(archive!);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Keep it' }));

    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('offers no Archive action on a listing that is already archived', async () => {
    serve([row({ status: 'ARCHIVED' })]);
    render('/seller/listings?tab=ARCHIVED');

    await screen.findAllByText('VALVE-001');
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.getAllByText('Archived').length).toBeGreaterThan(0);
  });
});

describe('a listing the marketplace has blocked', () => {
  it('shows Blocked with the reason, and offers no way round it', async () => {
    serve([
      row({
        status: 'BLOCKED',
        statusReason: 'Safety alert: batch recalled.',
      }),
    ]);
    render('/seller/listings?tab=BLOCKED');

    await screen.findAllByText('VALVE-001');
    expect(screen.getAllByText('Blocked').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Safety alert: batch recalled.').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Put on sale' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  });
});

describe('copying a listing (JOURNEY-028)', () => {
  it('asks for a new code, sends it, and opens the new draft', async () => {
    const user = userEvent.setup();
    const draftId = 'D1'.padEnd(26, '0');
    fetchMock.mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      if (url.includes('/duplicate')) return Promise.resolve(jsonResponse({ draftId }, 201));
      if (url.includes('/seller/listings')) {
        return Promise.resolve(jsonResponse({ rows: [row()], total: 1, counts: { ACTIVE: 1 } }));
      }
      return Promise.resolve(jsonResponse({ rows: [], total: 0, counts: {} }));
    });
    renderWithProviders(
      <Routes>
        <Route element={<Outlet context={SELLER} />}>
          <Route path="/seller/listings" element={<SellerListingsPage />} />
          <Route path="/seller/listings/new" element={<p>The new draft</p>} />
        </Route>
      </Routes>,
      { route: '/seller/listings' },
    );

    const [copy] = await screen.findAllByRole('button', { name: 'Copy' });
    await user.click(copy!);
    const dialog = await screen.findByRole('dialog');
    const code = within(dialog).getByLabelText(/Your code for the copy/);
    expect(code).toHaveValue('VALVE-001-COPY');
    // The same code as the original cannot be sent.
    await user.clear(code);
    await user.type(code, 'VALVE-001');
    expect(within(dialog).getByRole('button', { name: 'Copy into a new draft' })).toBeDisabled();
    await user.clear(code);
    await user.type(code, 'VALVE-002');
    await user.click(within(dialog).getByRole('button', { name: 'Copy into a new draft' }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === 'POST' && call.url.includes('/duplicate'));
      expect(post?.url).toContain(`/seller/listings/${'O1'.padEnd(26, '0')}/duplicate`);
      expect(post?.body).toEqual({ sellerSku: 'VALVE-002' });
    });
    expect(await screen.findByText('The new draft')).toBeInTheDocument();
  });
});
