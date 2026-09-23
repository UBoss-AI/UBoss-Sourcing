/**
 * What the storefront calls itself, and who it says stands behind it.
 *
 * The product used to be called UBOSS Sourcing, and the greeting page used to
 * make the name move: a shop's name with one word cycling after it — Sourcing,
 * Intelligence, Optimism, Innovation — so the headline read "UBOSS Sourcing",
 * then "UBOSS Intelligence", then "UBOSS Optimism". The product is Glovia now
 * and the headline does not rotate at all. What rotates is the line beneath
 * it, between the strapline and `Powered by UBOSS`, which are two complete
 * thoughts rather than two spellings of a name.
 *
 * Three things here are worth more than the rest, because all three are the
 * kind of thing that comes back:
 *
 *   - **The header names the SHOP, not the product.** Every buyer runs their
 *     own deployment. A test that only ever saw the fallback configuration
 *     would pass just as happily against a header with `Glovia` hard-coded in
 *     it, so one of these hands it somebody else's name and insists on seeing
 *     that instead.
 *   - **The old rotation cannot come back by accident.** Nothing in the
 *     headline may ever read `UBOSS Sourcing`, `UBOSS Innovation` or `UBOSS
 *     Intelligence` again, and that is asserted against the rendered text
 *     rather than against a list of words that no longer exists.
 *   - **The line below does not change height when it changes.** Both phrases
 *     are in the flow as measuring copies, which is what stops everything
 *     under the hero moving every four seconds on a phone. It is structural,
 *     so it is asserted structurally: jsdom has no layout and cannot be asked
 *     how tall anything is.
 *
 * `components/ui/flip-words.test.tsx` holds the animation itself — the
 * alternation, the timer, reduced motion and what a screen reader is told.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from './HomePage';
import { Header } from '@/layout/Header';
import { Footer } from '@/layout/Footer';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { PARENT_ATTRIBUTION, PRODUCT_BRAND } from '@/lib/brand';
import { jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import type { StorefrontConfig } from '@/lib/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(business: Partial<StorefrontConfig['business']> = {}): StorefrontConfig {
  return {
    ...FALLBACK_CONFIG,
    business: { ...FALLBACK_CONFIG.business, ...business },
  };
}

/** The non-breaking space the animation puts between a phrase's words. */
const NBSP = String.fromCharCode(0xa0);

const GUEST = makeSession({ user: null, isCustomer: false });

/** The English strapline, which is the first of the two phrases. */
const STRAPLINE = 'Source with Intelligence | Deliver with Confidence';

/** Every name the headline used to be able to show, and must not again. */
const RETIRED_HEADLINES = [
  'UBOSS Sourcing',
  'UBOSS Intelligence',
  'UBOSS Optimism',
  'UBOSS Innovation',
];

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/catalog/categories')) {
      return Promise.resolve(jsonResponse({ categories: [] }));
    }

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

    if (url.includes('/cart')) return Promise.resolve(jsonResponse({ cart: { itemCount: 0 } }));

    return Promise.resolve(jsonResponse({}));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The header
// ---------------------------------------------------------------------------

describe('the header lockup', () => {
  it('names the shop on the first line', () => {
    renderWithProviders(<Header />, { config: makeConfig(), session: GUEST });

    // Nothing has overridden the fallback, so the name a fresh deployment
    // carries is the product's own.
    expect(screen.getByText(PRODUCT_BRAND)).toBeInTheDocument();
  });

  it('attributes the product on the second', () => {
    renderWithProviders(<Header />, { config: makeConfig(), session: GUEST });

    const attribution = screen.getByText(PARENT_ATTRIBUTION);

    expect(attribution).toBeInTheDocument();
    // Written as a sentence and uppercased by CSS, not written in capitals.
    // A reader with a stylesheet that does not load, and anything reading the
    // markup, gets `Powered by UBOSS` and not `POWERED BY UBOSS`.
    expect(attribution.textContent).toBe('Powered by UBOSS');
  });

  it('shows the operator their own name and not the product name', () => {
    // The whole point of the product being a thing other companies buy: a
    // deployment that has filled in its business profile is Northwind's shop,
    // and Northwind's customers read Northwind on it.
    renderWithProviders(<Header />, {
      config: makeConfig({ displayName: 'Northwind Industrial' }),
      session: GUEST,
    });

    expect(screen.getByText('Northwind Industrial')).toBeInTheDocument();
    expect(screen.queryByText(PRODUCT_BRAND)).toBeNull();

    // The attribution is a fact about the software, so it is there either way.
    expect(screen.getByText(PARENT_ATTRIBUTION)).toBeInTheDocument();
  });

  it('never says what the header used to say', () => {
    const { container } = renderWithProviders(<Header />, {
      config: makeConfig(),
      session: GUEST,
    });

    expect(container.textContent).not.toContain('Business purchasing');
    expect(container.textContent).not.toContain('UBOSS Sourcing');
  });
});

describe('the footer', () => {
  it('attributes the product beside the shop’s own copyright', () => {
    const { container } = renderWithProviders(<Footer />, {
      config: makeConfig({ displayName: 'Northwind Industrial' }),
      session: GUEST,
    });

    // The copyright line, not the column heading above it — the shop's name
    // is in both, and only one of them is where the attribution belongs.
    const copyright = [...container.querySelectorAll('p')].find((paragraph) =>
      paragraph.textContent.startsWith('©'),
    );

    expect(copyright?.textContent).toContain('Northwind Industrial');
    expect(copyright?.textContent).toContain(PARENT_ATTRIBUTION);
  });
});

// ---------------------------------------------------------------------------
// The greeting
// ---------------------------------------------------------------------------

/** The `h1`, which is the one thing on the page that is the brand. */
function headline(): HTMLElement {
  return screen.getByRole('heading', { level: 1 });
}

/**
 * What the moving line currently says.
 *
 * The animated copy is split into a span per letter and the spaces between its
 * words are non-breaking, so it cannot be found by its text and has to be
 * read off the element. The two measuring copies in the same grid cell are the
 * reason it is scoped rather than taken from the paragraph.
 */
function strapline(container: HTMLElement): string {
  const moving = container.querySelector('.greeting-strapline [aria-hidden="true"]');

  return moving === null ? '' : moving.textContent.replaceAll(NBSP, ' ');
}

describe('the greeting headline', () => {
  it('is the shop’s name, and only the shop’s name', () => {
    renderWithProviders(<HomePage />, { config: makeConfig(), session: GUEST });

    expect(headline().textContent).toBe(PRODUCT_BRAND);
  });

  it('is the operator’s name where there is one', () => {
    renderWithProviders(<HomePage />, {
      config: makeConfig({ displayName: 'Northwind Industrial' }),
      session: GUEST,
    });

    expect(headline().textContent).toBe('Northwind Industrial');
  });

  it('does not rotate, whatever the shop is called', () => {
    // A name ending in one of the words the headline used to cycle was the
    // whole reason `lib/greeting-headline.ts` existed: "Acme Sourcing" read
    // "Acme Sourcing Sourcing". With nothing cycling after the name there is
    // nothing to collide with, and the name arrives exactly as configured.
    renderWithProviders(<HomePage />, {
      config: makeConfig({ displayName: 'Acme Sourcing' }),
      session: GUEST,
    });

    expect(headline().textContent).toBe('Acme Sourcing');
  });

  it('never shows the names it used to cycle through', () => {
    const { container } = renderWithProviders(<HomePage />, {
      config: makeConfig(),
      session: GUEST,
    });

    for (const retired of RETIRED_HEADLINES) {
      expect(container.textContent).not.toContain(retired);
    }
  });
});

describe('the line under the headline', () => {
  it('opens on the strapline', () => {
    const { container } = renderWithProviders(<HomePage />, {
      config: makeConfig(),
      session: GUEST,
    });

    expect(strapline(container)).toBe(STRAPLINE);
  });

  it('reserves the height of both phrases so nothing moves when it changes', () => {
    const { container } = renderWithProviders(<HomePage />, {
      config: makeConfig(),
      session: GUEST,
    });

    const cell = container.querySelector('.greeting-strapline');
    const line = cell?.parentElement;

    expect(line).not.toBeNull();

    // Both phrases, in the flow, in the same grid cell as the moving copy.
    // jsdom has no layout, so what is asserted is the arrangement that makes
    // the height constant rather than the height itself.
    const measured = [...(line?.querySelectorAll(':scope > .invisible') ?? [])].map(
      (span) => span.textContent,
    );

    expect(measured).toEqual([STRAPLINE, PARENT_ATTRIBUTION]);
    expect(line?.className).toContain('grid');
    for (const span of line?.querySelectorAll(':scope > .invisible') ?? []) {
      expect(span.className).toContain('col-start-1');
      expect(span.className).toContain('row-start-1');
      expect(span.getAttribute('aria-hidden')).toBe('true');
    }
    expect(cell?.className).toContain('col-start-1');
    expect(cell?.className).toContain('row-start-1');
  });

  it('is not announced as it changes', () => {
    const { container } = renderWithProviders(<HomePage />, {
      config: makeConfig(),
      session: GUEST,
    });

    // Nothing on this line may be live. A phrase swapping itself inside an
    // `aria-live` region interrupts whatever a screen-reader user is doing,
    // every four seconds, for as long as the page is open.
    const cell = container.querySelector('.greeting-strapline');

    expect(cell?.closest('[aria-live]')).toBeNull();
    expect(cell?.querySelector('[aria-live]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The hub at the centre of the graphic
// ---------------------------------------------------------------------------

describe('the core of the orchestration hub', () => {
  it('is the product, drawn once', () => {
    const { container } = renderWithProviders(<HomePage />, {
      config: makeConfig(),
      session: GUEST,
    });

    const core = container.querySelector('.orch-hub-label');

    expect(core).not.toBeNull();
    expect(within(core as HTMLElement).getByText(PRODUCT_BRAND)).toBeInTheDocument();

    // One element, whether or not WebGL is available. The 3D stage replaces
    // the sphere behind this label and never the label, so there is no second
    // copy that could be left saying something else — which is exactly what
    // happened when the fallback carried its own wording.
    expect(container.querySelectorAll('.orch-hub-label').length).toBe(1);
  });

  it('does not say what it used to say', () => {
    const { container } = renderWithProviders(<HomePage />, {
      config: makeConfig(),
      session: GUEST,
    });

    const core = container.querySelector('.orch-hub-label');

    expect(core?.textContent).not.toContain('Sourcing');
  });
});
