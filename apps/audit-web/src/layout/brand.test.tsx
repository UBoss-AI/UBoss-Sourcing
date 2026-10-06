/**
 * What the console calls itself — and, more importantly, what it does not.
 *
 * Gloviaa Mart, over `Source with Intelligence | Deliver with Confidence`: the
 * product, and its tagline, identical to the other three applications. Both
 * strings live in `lib/brand.ts` and nowhere else, and `Powered by UBOSS` is
 * the sign-in screen's small print.
 *
 * THE SECOND HALF OF THIS FILE IS THE IMPORTANT HALF.
 *
 * The inspection agency's name arrives with the session and must never be a
 * constant. An inspector reads it to know whose jobs they are looking at, and
 * a rename that quietly put the product's name in that slot would look like
 * the console signing them into the wrong agency. So the brand is asserted to
 * be fixed, and the agency is asserted to be whatever the session says.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nextProvider } from 'react-i18next';
import { SidebarProvider } from '@/components/ui/sidebar';
import { SessionProvider } from '@/auth/session';
import { ThemeProvider } from '@/app/ThemeProvider';
import { i18n } from '@/i18n/config';
import { PARENT_ATTRIBUTION, PORTAL_TITLE, PRODUCT_BRAND, PRODUCT_TAGLINE } from '@/lib/brand';
import { agency, sessionFor } from '@/test/session-fixture';
import { BrandLockup } from './BrandLockup';
import { LoginPage } from '@/pages/LoginPage';

/**
 * The innermost element whose whole text is `text`. The wordmark is two spans
 * now — "Gloviaa" and "Mart" in different faces — so the name is no longer
 * one text node that `getByText` can match on its own.
 */
function whole(text: string): (content: string, element: Element | null) => boolean {
  return (_content, element) =>
    element !== null &&
    element.textContent === text &&
    ![...element.children].some((child) => child.textContent === text);
}

vi.mock('@/lib/audit', () => ({
  fetchSession: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const audit = await import('@/lib/audit');
const fetchSession = vi.mocked(audit.fetchSession);

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
  it('is the product over its tagline', () => {
    renderBrand();

    expect(screen.getByText(whole(PRODUCT_BRAND))).toBeDefined();
    expect(screen.getByText(PRODUCT_TAGLINE)).toBeDefined();
    // The attribution is the sign-in screen's small print now, not the
    // lockup's second line.
    expect(screen.queryByText(PARENT_ATTRIBUTION)).toBeNull();
  });

  it('sets the name and the tagline in the one wordmark face', () => {
    renderBrand();

    expect(screen.getByText(whole(PRODUCT_BRAND)).className).toContain('font-brand');
    // Only "Mart" leaves the script, for the interface face.
    expect(screen.getByText('Mart').className).toContain('font-sans');
    // Shown as a light, lowercase "mart"; the text itself stays "Mart".
    expect(screen.getByText('Mart').className).toMatch(/font-light.*lowercase/);
    expect(screen.getByText(PRODUCT_TAGLINE).className).toContain('font-brand');
  });

  it('spells both of them the one way', () => {
    renderBrand();

    // Written as a sentence, not in capitals.
    expect(screen.getByText(whole('Gloviaa Mart')).textContent).toBe('Gloviaa Mart');
    expect(screen.getByText('Source with Intelligence | Deliver with Confidence').textContent).toBe('Source with Intelligence | Deliver with Confidence');
  });

  it('is named with both lines, for a rail too narrow to show them', () => {
    renderBrand();

    expect(
      screen.getByRole('img', { name: `${PRODUCT_BRAND} — ${PRODUCT_TAGLINE}` }),
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
    expect(renderBrand().textContent).not.toContain('UBOSS');
  });
});

describe('the tab', () => {
  it('is what says which portal this is', () => {
    expect(PORTAL_TITLE).toBe('Gloviaa Mart Audit Console');
  });
});

describe('the agency’s own name', () => {
  it('is whatever the session says, and never the product’s', async () => {
    fetchSession.mockResolvedValue(sessionFor({ agency: agency('Northgate Inspection') }));

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
      expect(screen.getByText(/signed in for Northgate Inspection/i)).toBeDefined();
    });

    // The brand is on the same screen, and the two are not the same thing.
    expect(screen.getByText(whole(PRODUCT_BRAND))).toBeDefined();
    expect(screen.queryByText(/signed in for Gloviaa Mart/i)).toBeNull();

    // Who makes the portal is the column's small print — once, and not the
    // lockup's second line.
    expect(screen.getAllByText(PARENT_ATTRIBUTION)).toHaveLength(1);
  });

  it('changes with the session, where the brand does not', async () => {
    fetchSession.mockResolvedValue(sessionFor({ agency: agency('Harbour Labs', 'agency-b') }));

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
      expect(screen.getByText(/signed in for Harbour Labs/i)).toBeDefined();
    });

    expect(screen.queryByText(/Northgate Inspection/)).toBeNull();
    expect(screen.getByText(whole(PRODUCT_BRAND))).toBeDefined();
  });
});
