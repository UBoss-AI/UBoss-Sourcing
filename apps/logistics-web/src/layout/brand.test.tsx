/**
 * What the portal calls itself — and, more importantly, what it does not.
 *
 * The portal used to be "UBOSS Logistics" on one line. It is Glovia now, over
 * `Powered by UBOSS`: the product, and who makes it. Both strings live in
 * `lib/brand.ts` and nowhere else.
 *
 * THE SECOND HALF OF THIS FILE IS THE IMPORTANT HALF.
 *
 * A carrier's own company name arrives with the session and is the one thing
 * on the rail that must never be a constant. A dispatcher at Sahyadri Express
 * on a shared depot machine reads that name to know whose consignments they
 * are looking at, and a rename that quietly put the product's name in that
 * slot would be indistinguishable, from the depot, from the portal having
 * signed them into the wrong carrier. So the brand is asserted to be fixed,
 * and the company is asserted to be whatever the session says and nothing
 * else.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { SidebarProvider } from '@/components/ui/sidebar';
import { SessionProvider } from '@/auth/session';
import { ThemeProvider } from '@/app/ThemeProvider';
import { i18n } from '@/i18n/config';
import { PARENT_ATTRIBUTION, PORTAL_TITLE, PRODUCT_BRAND } from '@/lib/brand';
import type { PortalSession } from '@/lib/types';
import { BrandLockup } from './BrandLockup';
import { LoginPage } from '@/pages/LoginPage';

vi.mock('@/lib/logistics', () => ({
  fetchSession: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const logistics = await import('@/lib/logistics');
const fetchSession = vi.mocked(logistics.fetchSession);

function sessionFor(company: string): PortalSession {
  return {
    user: {
      id: 'user-1',
      email: 'dispatch@sahyadri.example',
      fullName: 'Signed-in Person',
      role: 'DISPATCHER',
      permissions: [],
      isDriver: false,
    },
    partner: {
      id: 'partner-a',
      code: 'LP-00001',
      displayName: company,
      status: 'ACTIVE',
      canAcceptNewWork: true,
    },
    mfa: { required: false, enrolled: false, sessionVerified: false, recoveryCodesRemaining: 0 },
  };
}

/** The rail, pinned open — a collapsed one hides the wording from everybody. */
function renderBrand(collapsible = true): HTMLElement {
  const { container } = render(
    <I18nextProvider i18n={i18n}>
      <SidebarProvider open animate={false}>
        <BrandLockup collapsible={collapsible} />
      </SidebarProvider>
    </I18nextProvider>,
  );

  return container;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the portal’s brand lockup', () => {
  it('is the product over its attribution', () => {
    renderBrand();

    expect(screen.getByText(PRODUCT_BRAND)).toBeDefined();
    expect(screen.getByText(PARENT_ATTRIBUTION)).toBeDefined();
  });

  it('spells both of them the one way', () => {
    renderBrand();

    // Written as a sentence and uppercased by CSS, not written in capitals.
    expect(screen.getByText('Glovia').textContent).toBe('Glovia');
    expect(screen.getByText('Powered by UBOSS').textContent).toBe('Powered by UBOSS');
  });

  it('is named with both lines, for a rail too narrow to show them', () => {
    renderBrand();

    expect(
      screen.getByRole('img', { name: `${PRODUCT_BRAND} — ${PARENT_ATTRIBUTION}` }),
    ).toBeDefined();
  });

  it('is the same lockup on the sign-in screen as on the rail', () => {
    // Different wrapper, same two lines: the sign-in screen has no rail to
    // fold into, and that is the only difference between the two.
    const rail = renderBrand(true).textContent;
    const auth = renderBrand(false).textContent;

    expect(rail).toBe(auth);
  });

  it('no longer says what it used to say', () => {
    expect(renderBrand().textContent).not.toContain('UBOSS Logistics');
  });
});

describe('the tab', () => {
  it('is what says which portal this is', () => {
    expect(PORTAL_TITLE).toBe('Glovia Logistics');
  });
});

describe('the carrier’s own name', () => {
  it('is whatever the session says, and never the product’s', async () => {
    fetchSession.mockResolvedValue(sessionFor('Sahyadri Express'));

    render(
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <MemoryRouter initialEntries={['/login']}>
            <SessionProvider>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
              </Routes>
            </SessionProvider>
          </MemoryRouter>
        </ThemeProvider>
      </I18nextProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/signed in as Sahyadri Express/i)).toBeDefined();
    });

    // The brand is on the same screen, and the two are not the same thing.
    expect(screen.getByText(PRODUCT_BRAND)).toBeDefined();
    expect(screen.queryByText(/signed in as Glovia/i)).toBeNull();
  });

  it('changes with the session, where the brand does not', async () => {
    fetchSession.mockResolvedValue(sessionFor('Konkan Freight'));

    render(
      <I18nextProvider i18n={i18n}>
        <ThemeProvider>
          <MemoryRouter initialEntries={['/login']}>
            <SessionProvider>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
              </Routes>
            </SessionProvider>
          </MemoryRouter>
        </ThemeProvider>
      </I18nextProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/signed in as Konkan Freight/i)).toBeDefined();
    });

    expect(screen.queryByText(/Sahyadri Express/)).toBeNull();
    expect(screen.getByText(PRODUCT_BRAND)).toBeDefined();
  });
});
