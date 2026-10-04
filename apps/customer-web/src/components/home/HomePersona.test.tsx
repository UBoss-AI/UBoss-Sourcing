/**
 * The home page differs by who is looking (checklist ENH-003): guest,
 * business buyer, private buyer, seller and somebody coming back.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomePersona } from './HomePersona';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { jsonResponse, makeSession, renderWithProviders } from '@/test/harness';

const fetchMock = vi.fn();
const config = { ...FALLBACK_CONFIG, features: { ...FALLBACK_CONFIG.features, rfq: true, buyerCompanies: true } };
const GUEST = makeSession({ user: null, isCustomer: false });

function sellerAnswer(seller: unknown): void {
  fetchMock.mockImplementation((url: string) =>
    Promise.resolve(jsonResponse(url.includes('/sellers/me') ? { seller } : {})),
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  sellerAnswer(null);
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

async function panel(): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { level: 2 });
  return heading.closest('section') as HTMLElement;
}

function hrefs(section: HTMLElement): (string | null)[] {
  return within(section).getAllByRole('link').map((link) => link.getAttribute('href'));
}

describe('home persona (ENH-003)', () => {
  it('offers a guest an account, suppliers and selling, and asks nothing about sellers', async () => {
    renderWithProviders(<HomePersona />, { config, session: GUEST });
    const section = await panel();
    expect(section).toHaveAttribute('data-persona', 'guest');
    expect(hrefs(section)).toEqual(['/register', '/suppliers', '/sell']);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/sellers/me'))).toBe(false);
  });

  it('gives a private buyer their orders, saved items and a way to buy for a company', async () => {
    renderWithProviders(<HomePersona />, { config, session: makeSession() });
    const section = await panel();
    expect(section).toHaveAttribute('data-persona', 'private');
    expect(hrefs(section)).toEqual(['/account/orders', '/account/wishlist', '/account/companies']);
  });

  it('names the company a business buyer is buying for and offers quotes, a SKU list and the team', async () => {
    const company = { companyId: 'co-1', companyName: 'Kerala Clinics', companyStatus: 'APPROVED', role: 'BUYER', applicationReference: 'A-1' } as const;
    renderWithProviders(<HomePersona />, { config, session: makeSession({ buyerContext: { kind: 'COMPANY', ...company } }) });
    const section = await panel();
    expect(section).toHaveAttribute('data-persona', 'business');
    expect(within(section).getByRole('heading', { name: 'Buying for Kerala Clinics' })).toBeInTheDocument();
    expect(hrefs(section)).toEqual(['/account/rfqs/new', '/cart', '/account/companies/co-1']);
  });

  it('leaves out quotes when requests for quotation are switched off', async () => {
    const company = { companyId: 'co-1', companyName: 'Kerala Clinics', companyStatus: 'APPROVED', role: 'BUYER', applicationReference: 'A-1' } as const;
    renderWithProviders(<HomePersona />, {
      config: { ...config, features: { ...config.features, rfq: false } },
      session: makeSession({ buyerContext: { kind: 'COMPANY', ...company } }),
    });
    expect(hrefs(await panel())).not.toContain('/account/rfqs/new');
  });

  it('points a trading seller at Seller Hub, but not somebody whose application is still open', async () => {
    sellerAnswer({ status: 'APPROVED', isTrading: true });
    const first = renderWithProviders(<HomePersona />, { config, session: makeSession() });
    const section = await panel();
    expect(section).toHaveAttribute('data-persona', 'seller');
    expect(hrefs(section)).toEqual(['/seller/dashboard', '/seller/orders', '/seller/listings']);
    first.unmount();

    sellerAnswer({ status: 'SUBMITTED', isTrading: false });
    renderWithProviders(<HomePersona />, { config, session: makeSession() });
    expect(await panel()).toHaveAttribute('data-persona', 'private');
  });

  it('welcomes somebody coming back and leads with what they last looked at', async () => {
    window.localStorage.setItem(
      'recently-viewed.v1',
      JSON.stringify([{ kind: 'product', slug: 'nitrile-gloves', name: 'Nitrile gloves', viewedAt: new Date().toISOString() }]),
    );
    renderWithProviders(<HomePersona />, { config, session: GUEST });
    const section = await panel();
    expect(section).toHaveAttribute('data-returning', 'true');
    expect(within(section).getByRole('heading', { name: /^Welcome back\./ })).toBeInTheDocument();
    expect(hrefs(section).slice(0, 2)).toEqual(['/product/nitrile-gloves', '/login']);
  });

  it('welcomes a signed-in buyer back above their own persona', async () => {
    window.localStorage.setItem(
      'recently-viewed.v1',
      JSON.stringify([{ kind: 'supplier', slug: 'acme', name: 'Acme', viewedAt: new Date().toISOString() }]),
    );
    renderWithProviders(<HomePersona />, { config, session: makeSession() });
    const section = await panel();
    expect(section).toHaveAttribute('data-persona', 'private');
    expect(within(section).getByRole('heading', { name: 'Welcome back. Your own purchases' })).toBeInTheDocument();
    expect(hrefs(section)[0]).toBe('/suppliers/acme');
  });
});
