/**
 * The home page's newly-verified, assurance and market blocks.
 *
 * The rule under test is the same one the verified-suppliers section keeps:
 * **a block appears only when real data gives it something to say**, and says
 * nothing while loading or when the read fails.
 */
import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from '@/pages/HomePage';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { errorResponse, jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import type { VerifiedSupplier } from '@/lib/types';

const fetchMock = vi.fn();
const GUEST = makeSession({ user: null, isCustomer: false });

function supplier(overrides: Partial<VerifiedSupplier> = {}): VerifiedSupplier {
  return {
    slug: 'acme-industries',
    displayName: 'Acme Industries',
    kind: 'MANUFACTURER',
    registrationCountry: 'IN',
    verifiedAt: '2026-01-10T00:00:00.000Z',
    productCount: 12,
    logoUrl: null,
    ...overrides,
  };
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

interface Answers {
  newest?: VerifiedSupplier[];
  assurance?: Record<string, unknown> | 'fail';
  market?: Record<string, unknown> | 'fail';
}

function serve(answers: Answers): void {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/catalog/suppliers')) {
      const list = url.includes('sort=newest') ? (answers.newest ?? []) : [];
      return Promise.resolve(jsonResponse({ suppliers: list, countries: [], total: list.length }));
    }
    if (url.includes('/catalog/assurance')) {
      return Promise.resolve(
        answers.assurance === 'fail' || answers.assurance === undefined
          ? errorResponse(503, 'SERVICE_UNAVAILABLE', 'Unavailable.')
          : jsonResponse(answers.assurance),
      );
    }
    if (url.includes('/catalog/markets/')) {
      return Promise.resolve(
        answers.market === 'fail' || answers.market === undefined
          ? errorResponse(404, 'NOT_FOUND', 'No such market.')
          : jsonResponse(answers.market),
      );
    }
    if (url.includes('/catalog/categories')) return Promise.resolve(jsonResponse({ categories: [] }));
    if (url.includes('/catalog/products')) {
      return Promise.resolve(
        jsonResponse({
          products: [],
          pagination: { page: 1, limit: 12, total: 0, totalPages: 0 },
          currency: 'INR',
          country: 'IN',
        }),
      );
    }
    return Promise.resolve(jsonResponse({}));
  });
}

async function settled(fragment: string): Promise<void> {
  await waitFor(() => {
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes(fragment))).toBe(true);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

function renderHome(): void {
  renderWithProviders(<HomePage />, { config: FALLBACK_CONFIG, session: GUEST });
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('newly verified suppliers', () => {
  it('lists suppliers approved in the last 90 days and leaves older ones out', async () => {
    serve({
      newest: [
        supplier({ slug: 'fresh-co', displayName: 'Fresh Co', verifiedAt: daysAgo(10) }),
        supplier({ slug: 'old-co', displayName: 'Old Co', verifiedAt: daysAgo(200) }),
      ],
    });
    renderHome();

    const section = await screen.findByRole('region', { name: 'Newly verified suppliers' });
    expect(within(section).getByRole('link', { name: /Fresh Co/ })).toHaveAttribute('href', '/suppliers/fresh-co');
    expect(within(section).queryByRole('link', { name: /Old Co/ })).not.toBeInTheDocument();
  });

  it('is absent when nothing was verified recently', async () => {
    serve({ newest: [supplier({ verifiedAt: daysAgo(400) })] });
    renderHome();
    await settled('sort=newest');

    expect(screen.queryByRole('region', { name: 'Newly verified suppliers' })).not.toBeInTheDocument();
  });
});

describe('the assurance explainer', () => {
  it('states only the protections the settings switch on, and links to the full page', async () => {
    serve({
      assurance: {
        verifiedSuppliers: 3,
        inspection: { inUse: false, mandatoryRules: 0 },
        returns: { windowDays: 14, replacementEnabled: true },
        claims: { claimWindowDays: 30, sellerResponseHours: 48, decisionHours: 120, appealWindowDays: 7 },
      },
    });
    renderHome();

    const section = await screen.findByRole('region', { name: 'How buying here is protected' });
    expect(within(section).getByText(/reviewed by .* before it can sell/)).toBeInTheDocument();
    expect(within(section).getByText('Returns can be requested up to 14 days after delivery.')).toBeInTheDocument();
    expect(within(section).getByText('A claim can be raised up to 30 days after delivery.')).toBeInTheDocument();
    // Inspection is not in use, so it is not implied.
    expect(within(section).queryByText(/inspection/i)).not.toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'How assurance works' })).toHaveAttribute('href', '/assurance');
  });

  it('is absent when the facts cannot be read', async () => {
    serve({ assurance: 'fail' });
    renderHome();
    await settled('/catalog/assurance');

    expect(screen.queryByRole('region', { name: 'How buying here is protected' })).not.toBeInTheDocument();
  });
});

describe('the market block', () => {
  it('summarises the selected country and links to its market page', async () => {
    serve({
      market: {
        country: { code: 'IN', name: 'India', currencyCode: 'INR' },
        profile: { headline: null, deliveryPromise: 'Sea freight to Nhava Sheva.' },
        restrictions: [{ effect: 'BLOCK' }, { effect: 'DOCUMENTS_REQUIRED' }],
      },
    });
    renderHome();

    const section = await screen.findByRole('region', { name: 'Shopping from India' });
    expect(within(section).getByText(/quoted in INR/)).toBeInTheDocument();
    expect(within(section).getByText('Some products cannot be sold to India.')).toBeInTheDocument();
    expect(within(section).getByText('Some products need documents for India.')).toBeInTheDocument();
    expect(within(section).getByText('Sea freight to Nhava Sheva.')).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'Read the market guide for India' })).toHaveAttribute('href', '/markets/in');
  });

  it('is absent when the market has no page', async () => {
    serve({ market: 'fail' });
    renderHome();
    await settled('/catalog/markets/');

    expect(screen.queryByRole('region', { name: /Shopping from/ })).not.toBeInTheDocument();
  });
});
