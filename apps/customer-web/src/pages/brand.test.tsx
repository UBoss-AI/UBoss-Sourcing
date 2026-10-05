/**
 * What the storefront calls itself, and who it says stands behind it.
 *
 * The product used to be called UBOSS Sourcing, and the greeting page used to
 * make the name move: a shop's name with one word cycling after it — Sourcing,
 * Intelligence, Optimism, Innovation — so the headline read "UBOSS Sourcing",
 * then "UBOSS Intelligence", then "UBOSS Optimism". The product is Gloviaa Mart now
 * and nothing on the hero rotates any more. The line under the name is the
 * approved strapline, "Source with Intelligence | Deliver with Confidence", in
 * one piece; its two halves used to alternate on the line below it, which is
 * now the static "Your Integrated B2B B2C Platform".
 *
 * Three things here are worth more than the rest, because all three are the
 * kind of thing that comes back:
 *
 *   - **The header names the SHOP, not the product.** Every buyer runs their
 *     own deployment. A test that only ever saw the fallback configuration
 *     would pass just as happily against a header with `Gloviaa Mart` hard-coded in
 *     it, so one of these hands it somebody else's name and insists on seeing
 *     that instead.
 *   - **The old rotation cannot come back by accident.** Nothing in the
 *     headline may ever read `UBOSS Sourcing`, `UBOSS Innovation` or `UBOSS
 *     Intelligence` again, and that is asserted against the rendered text
 *     rather than against a list of words that no longer exists.
 *   - **Nothing under the name moves.** No timer is armed, no measuring
 *     copies are left in the flow, and the platform line is one plain
 *     paragraph — asserted with fake timers rather than by eye.
 */
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomePage } from './HomePage';
import { Header } from '@/layout/Header';
import { Footer } from '@/layout/Footer';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import {
  PARENT_ATTRIBUTION,
  PRODUCT_BRAND,
  PRODUCT_SHORT_NAME,
  PRODUCT_TAGLINE,
} from '@/lib/brand';
import { jsonResponse, makeSession, renderWithProviders } from '@/test/harness';
import type { StorefrontConfig } from '@/lib/types';

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(business: Partial<StorefrontConfig['business']> = {}): StorefrontConfig {
  return {
    ...FALLBACK_CONFIG,
    business: { ...FALLBACK_CONFIG.business, ...business },
  };
}

const GUEST = makeSession({ user: null, isCustomer: false });

/** The approved strapline, spelled out so a change to the constant is caught. */
const STRAPLINE = 'Source with Intelligence | Deliver with Confidence';
/** The static line under it, in English. */
const PLATFORM_LINE = 'Your Integrated B2B B2C Platform';

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
    expect(screen.getByText(whole(PRODUCT_BRAND))).toBeInTheDocument();
  });

  it('says the one-word name on a phone and the full name from sm up', () => {
    renderWithProviders(<Header />, { config: makeConfig(), session: GUEST });

    // Both are in the markup and CSS shows one. jsdom has no stylesheet, so
    // the classes are what can be asserted.
    expect(PRODUCT_BRAND).toBe('Gloviaa Mart');
    expect(PRODUCT_SHORT_NAME).toBe('Gloviaa');
    const phoneName = screen
      .getAllByText(PRODUCT_SHORT_NAME)
      .find((element) => element.classList.contains('sm:hidden'));
    expect(phoneName).toBeDefined();
    expect(screen.getByText(whole(PRODUCT_BRAND)).className).toContain('max-sm:hidden');
  });

  it('carries the tagline on the second', () => {
    renderWithProviders(<Header />, { config: makeConfig(), session: GUEST });

    const tagline = screen.getByText(PRODUCT_TAGLINE);

    expect(tagline).toBeInTheDocument();
    // Written as a sentence, not in capitals.
    // A reader with a stylesheet that does not load, and anything reading the
    // markup, gets the approved line exactly, capitals and bar included.
    expect(tagline.textContent).toBe('Source with Intelligence | Deliver with Confidence');

    // The attribution moved to the footer; the header does not repeat it.
    expect(screen.queryByText(PARENT_ATTRIBUTION)).toBeNull();
  });

  it('sets the product name and the tagline in the one wordmark face', () => {
    renderWithProviders(<Header />, { config: makeConfig(), session: GUEST });

    expect(screen.getByText(whole(PRODUCT_BRAND)).closest('.font-brand')).not.toBeNull();
    expect(screen.getAllByText(PRODUCT_SHORT_NAME)[0]?.closest('.font-brand')).not.toBeNull();
    // Only "Mart" leaves the script, for the interface face.
    const service = document.querySelector('.brand-wordmark .brand-name-service');
    expect(service?.textContent).toBe('Mart');
    expect(service?.className).toContain('font-sans');
    // A light, lowercase "mart" under the parent brand; the text stays "Mart".
    expect(service?.className).toMatch(/font-light.*lowercase/);
    expect(screen.getByText(PRODUCT_TAGLINE).className).toContain('font-brand');
  });

  it('shows the operator their own name and not the product name', () => {
    // The whole point of the product being a thing other companies buy: a
    // deployment that has filled in its business profile is Northwind's shop,
    // and Northwind's customers read Northwind on it.
    renderWithProviders(<Header />, {
      config: makeConfig({ displayName: 'Northwind Industrial' }),
      session: GUEST,
    });

    const name = screen.getByText('Northwind Industrial');
    expect(name).toBeInTheDocument();
    expect(screen.queryByText(whole(PRODUCT_BRAND))).toBeNull();

    // Gloviaa Mart's face and Gloviaa Mart's slogan belong to Gloviaa Mart. Under somebody
    // else's name they would be the software claiming that company's shop.
    expect(name.className).not.toContain('font-brand');
    expect(screen.queryByText(PRODUCT_TAGLINE)).toBeNull();
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

  it('says it exactly once', () => {
    renderWithProviders(<Footer />, { config: makeConfig(), session: GUEST });

    expect(screen.getAllByText(PARENT_ATTRIBUTION, { exact: false })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The greeting
// ---------------------------------------------------------------------------

/** The `h1`, which is the one thing on the page that is the brand. */
function headline(): HTMLElement {
  return screen.getByRole('heading', { level: 1 });
}

describe('the greeting headline', () => {
  it('is the shop’s name, and only the shop’s name', () => {
    renderWithProviders(<HomePage />, { config: makeConfig(), session: GUEST });

    expect(headline().textContent).toBe(PRODUCT_BRAND);
  });

  it('sets "Gloviaa" in the script and only "Mart" in the interface face', () => {
    renderWithProviders(<HomePage />, { config: makeConfig(), session: GUEST });

    const parent = headline().querySelector('.brand-name-parent');
    const service = headline().querySelector('.brand-name-service');

    expect(parent?.textContent).toBe(PRODUCT_SHORT_NAME);
    // The script comes from the heading; the parent word adds no face of its own.
    expect(parent?.className).not.toContain('font-sans');
    expect(service?.textContent).toBe('Mart');
    expect(service?.className).toContain('font-sans');
    // A light, lowercase "mart" under the parent brand; the text stays "Mart".
    expect(service?.className).toMatch(/font-light.*lowercase/);
    // Text, on the same line: one heading that reads "Gloviaa Mart".
    expect(headline().querySelector('img, svg')).toBeNull();
    expect(headline().querySelector('br')).toBeNull();
  });

  it('leaves another company’s name in one face', () => {
    renderWithProviders(<HomePage />, {
      config: makeConfig({ displayName: 'Northwind Industrial' }),
      session: GUEST,
    });

    expect(headline().querySelector('.brand-name-service')).toBeNull();
  });

  it('is the wordmark when it is the product’s name, and a heading when it is not', () => {
    const { unmount } = renderWithProviders(<HomePage />, { config: makeConfig(), session: GUEST });
    expect(headline().className).toContain('font-brand');
    unmount();

    renderWithProviders(<HomePage />, {
      config: makeConfig({ displayName: 'Northwind Industrial' }),
      session: GUEST,
    });
    expect(headline().className).not.toContain('font-brand');
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

describe('the tagline under the headline', () => {
  it('is the approved strapline, exactly, and it does not move', () => {
    const { container } = renderWithProviders(<HomePage />, {
      config: makeConfig(),
      session: GUEST,
    });

    const tagline = container.querySelector('.greeting-tagline');

    expect(PRODUCT_TAGLINE).toBe(STRAPLINE);
    expect(tagline?.textContent).toBe(STRAPLINE);
    // The old sentence is gone, here and everywhere else.
    expect(container.textContent).not.toContain('The Way to the Global Sourcing');
  });

  it('belongs to Gloviaa Mart, so another company’s greeting does not carry it', () => {
    const { container } = renderWithProviders(<HomePage />, {
      config: makeConfig({ displayName: 'Northwind Industrial' }),
      session: GUEST,
    });

    expect(container.querySelector('.greeting-tagline')).toBeNull();
  });
});

describe('the line under the tagline', () => {
  it('is the platform line, as plain text', () => {
    const { container } = renderWithProviders(<HomePage />, {
      config: makeConfig(),
      session: GUEST,
    });

    const line = container.querySelector('.greeting-platform');

    expect(line?.textContent).toBe(PLATFORM_LINE);
    // One paragraph of text: no measuring copies, no per-letter spans.
    expect(line?.children.length).toBe(0);
    expect(line?.closest('[aria-live]')).toBeNull();
    expect(line?.textContent).not.toContain(PARENT_ATTRIBUTION);
  });

  it('never flips, however long the page is open', () => {
    vi.useFakeTimers();
    try {
      const { container } = renderWithProviders(<HomePage />, {
        config: makeConfig(),
        session: GUEST,
      });

      vi.advanceTimersByTime(20_000);

      expect(container.querySelector('.greeting-platform')?.textContent).toBe(PLATFORM_LINE);
      expect(container.querySelector('.greeting-tagline')?.textContent).toBe(STRAPLINE);
      expect(container.querySelector('.greeting-strapline')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
    // `Gloviaa` and nothing more: the globe stands for the rest of the name,
    // and the endorsement and the tagline live elsewhere on the page.
    expect(within(core as HTMLElement).getByText(PRODUCT_SHORT_NAME)).toBeInTheDocument();
    expect(core?.textContent).toBe(PRODUCT_SHORT_NAME);

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
