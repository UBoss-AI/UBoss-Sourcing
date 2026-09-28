/**
 * The About page.
 *
 * It was built from two approved visual references that arrived as demo code:
 * a font import, remote icons, a stock photograph, a play button with nothing
 * behind it, a "Read more" that went nowhere and somebody else's product copy.
 * These hold down that none of that came through, and the three things the
 * page has to get right on its own:
 *
 *   - **It only describes what this deployment does.** A card whose feature is
 *     switched off is not shown, and the grid refills from what is on.
 *   - **It names the operator, not the vendor.** The product's own name and
 *     tagline on a fresh deployment; somebody else's name, and no Gloviaa
 *     slogan, on theirs.
 *   - **It is the one About page, and it has no FAQ.** Those belong to Support.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { FALLBACK_CONFIG } from '@/app/storefront-context';
import { aboutCapabilities, orbitPosition } from '@/components/about/about-content';
import { Footer } from '@/layout/Footer';
import { Header } from '@/layout/Header';
import { PARENT_ATTRIBUTION, PRODUCT_BRAND, PRODUCT_TAGLINE } from '@/lib/brand';
import { renderWithProviders } from '@/test/harness';
import type { StorefrontConfig } from '@/lib/types';
import { AboutPage } from './AboutPage';

const here = dirname(fileURLToPath(import.meta.url));
const ABOUT_DIR = join(here, '..', 'components', 'about');
const LOCALES_DIR = join(here, '..', 'i18n', 'locales');

type Features = StorefrontConfig['features'];

function config(
  features: Partial<Features> = {},
  business: Partial<StorefrontConfig['business']> = {},
): StorefrontConfig {
  return {
    ...FALLBACK_CONFIG,
    business: { ...FALLBACK_CONFIG.business, ...business },
    features: { ...FALLBACK_CONFIG.features, ...features },
  };
}

const ALL_ON = config({ assistant: true, buyerCompanies: true, recurringOrders: true });

function renderAbout(storefront: StorefrontConfig = ALL_ON): void {
  renderWithProviders(<AboutPage />, { config: storefront, route: '/about' });
}

function shownCapabilities(): (string | null)[] {
  return Array.from(document.querySelectorAll('[data-capability]')).map((card) =>
    card.getAttribute('data-capability'),
  );
}

describe('the About page', () => {
  it('has exactly one page heading: the tagline, on the product’s own storefront', () => {
    renderAbout();
    const headings = screen.getAllByRole('heading', { level: 1 });
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent(PRODUCT_TAGLINE);
    // The heading is where focus lands when the page is navigated to.
    expect(headings[0]).toHaveAttribute('data-route-focus');
  });

  it('spells the product Gloviaa Mart and carries the attribution', () => {
    renderAbout();
    expect(PRODUCT_BRAND).toBe('Gloviaa Mart');
    expect(screen.getByText('About Gloviaa Mart')).toBeInTheDocument();
    expect(screen.getByText(PARENT_ATTRIBUTION)).toBeInTheDocument();
  });

  it('names another operator, and drops the product’s slogan, on their deployment', () => {
    renderAbout(config({}, { displayName: 'Northwind Supply' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'One marketplace for sourcing, selling and delivery',
    );
    expect(screen.queryByText(PRODUCT_TAGLINE)).not.toBeInTheDocument();
  });

  it('uses the section structure the references were built around', () => {
    renderAbout();
    expect(screen.getByRole('heading', { level: 2, name: 'What we do' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'What you can do here' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(6);
  });
});

describe('the capability cards', () => {
  it('are the six the page was designed around when every switch is on', () => {
    renderAbout();
    expect(shownCapabilities()).toEqual([
      'assistant',
      'companies',
      'sellers',
      'bulk',
      'logistics',
      'secure',
    ]);
    expect(screen.getByRole('heading', { name: 'AI-assisted sourcing' })).toBeInTheDocument();
  });

  it('never promise a feature that is switched off here', () => {
    renderAbout(config());
    const shown = shownCapabilities();
    expect(shown).not.toContain('assistant');
    expect(shown).not.toContain('companies');
    expect(shown).not.toContain('schedules');
    expect(screen.queryByText(/AI assistant/)).not.toBeInTheDocument();
    expect(screen.queryByText(/company account/)).not.toBeInTheDocument();
  });

  it('refill the grid from what is on, never past six', () => {
    expect(aboutCapabilities(config({ recurringOrders: true }).features).map((c) => c.key)).toEqual([
      'sellers',
      'bulk',
      'logistics',
      'secure',
      'schedules',
      'markets',
    ]);
    expect(aboutCapabilities(ALL_ON.features)).toHaveLength(6);
  });

  it('draw every icon as decoration beside a real heading', () => {
    renderAbout();
    for (const card of document.querySelectorAll('[data-capability]')) {
      expect(card.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
      expect(card.querySelector('img')).toBeNull();
      expect(within(card as HTMLElement).getByRole('heading', { level: 3 })).toBeInTheDocument();
    }
  });
});

describe('the "What we do" picture', () => {
  it('is a list of who takes part, with no play button on it', () => {
    renderAbout();
    const figure = document.querySelector('figure');
    expect(figure).not.toBeNull();
    expect(within(figure as HTMLElement).queryByRole('button')).toBeNull();
    const roles = screen.getByRole('list', { name: 'Who takes part' });
    expect(within(roles).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Buyers',
      'Company buyers',
      'Sellers',
      'Warehouses',
      'Logistics partners',
      'Marketplace team',
    ]);
  });

  it('leaves company buyers off where company accounts are off', () => {
    renderAbout(config());
    const roles = screen.getByRole('list', { name: 'Who takes part' });
    expect(within(roles).queryByText('Company buyers')).toBeNull();
  });

  it('uses the local earth, lazily, with its size declared', () => {
    renderAbout();
    const images = document.querySelectorAll('figure img');
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image.getAttribute('src')).not.toMatch(/^https?:/);
      expect(image).toHaveAttribute('loading', 'lazy');
      expect(image).toHaveAttribute('width');
      expect(image).toHaveAttribute('height');
      expect(image).toHaveAttribute('alt', '');
    }
  });

  it('places the first group at twelve o’clock and keeps every group on the stage', () => {
    expect(orbitPosition(0, 6)).toEqual({ x: 50, y: 12 });
    for (let index = 0; index < 6; index += 1) {
      const { x, y } = orbitPosition(index, 6);
      expect(x).toBeGreaterThanOrEqual(20);
      expect(x).toBeLessThanOrEqual(80);
      expect(y).toBeGreaterThanOrEqual(12);
      expect(y).toBeLessThanOrEqual(88);
    }
  });
});

describe('"Explore what you can do"', () => {
  it('goes to the capabilities on this page, and moves focus there', () => {
    renderAbout();
    const link = screen.getByRole('link', { name: /Explore what you can do/ });
    expect(link).toHaveAttribute('href', '#about-capabilities');

    const target = document.getElementById('about-capabilities');
    expect(target).not.toBeNull();
    // jsdom has no layout, so there is nothing to scroll; the call is the contract.
    const scrolled: ScrollIntoViewOptions[] = [];
    (target as HTMLElement).scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => {
      scrolled.push(options as ScrollIntoViewOptions);
    };

    fireEvent.click(link);
    expect(scrolled).toEqual([{ block: 'start' }]);
    expect(document.activeElement).toBe(target);
  });
});

describe('where to go next', () => {
  it('offers three real destinations', () => {
    renderAbout();
    expect(screen.getByRole('link', { name: 'Browse products' })).toHaveAttribute('href', '/products');
    expect(screen.getByRole('link', { name: 'Sell with us' })).toHaveAttribute('href', '/sell');
    expect(screen.getByRole('link', { name: 'Contact support' })).toHaveAttribute('href', '/support');
  });
});

describe('no questions and answers on About', () => {
  it('renders no FAQ: that is the Support page’s', () => {
    renderAbout();
    expect(screen.queryByRole('region', { name: 'Frequently asked questions' })).toBeNull();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(document.getElementById('support-faq')).toBeNull();
  });

  it('does not import the Support FAQ anywhere in its source', () => {
    const sources = [
      readFileSync(join(here, 'AboutPage.tsx'), 'utf8'),
      ...readdirSync(ABOUT_DIR)
        .filter((name) => !name.endsWith('.test.tsx'))
        .map((name) => readFileSync(join(ABOUT_DIR, name), 'utf8')),
    ];
    for (const source of sources) {
      expect(source).not.toMatch(/SupportFaq|FaqCategorized|support-faq/);
    }
  });
});

describe('nothing from the demo references survived', () => {
  const files = [
    join(here, 'AboutPage.tsx'),
    ...readdirSync(ABOUT_DIR).map((name) => join(ABOUT_DIR, name)),
  ];

  it.each(files.map((file) => [file.split(/[\\/]/).pop() ?? file, file]))(
    '%s carries no demo copy, remote asset, font override or duplicate export',
    (_name, file) => {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/cdn\.21st\.dev/);
      expect(source).not.toMatch(/fonts\.googleapis\.com|Poppins|font-family/);
      expect(source).not.toMatch(/PrebuiltUI|About our apps/);
      expect(source).not.toMatch(/['"]use client['"]/);
      expect(source).not.toMatch(/export default/);
      expect(source).not.toMatch(/function Example\b/);
    },
  );

  it('and none of it is in any language', () => {
    for (const name of readdirSync(LOCALES_DIR)) {
      const catalogue = readFileSync(join(LOCALES_DIR, name), 'utf8');
      expect(catalogue).not.toMatch(/PrebuiltUI|About our apps|Tailwind|Next\.js/);
    }
  });

  it('shows no library or template language on the page', () => {
    renderAbout();
    const text = document.body.textContent;
    expect(text).not.toMatch(/PrebuiltUI|components|Tailwind|Next\.js|pixel-perfect/i);
  });
});

describe('the one About page', () => {
  it('is registered once, as a public route', () => {
    const router = readFileSync(join(here, '..', 'app', 'router.tsx'), 'utf8');
    expect(router.match(/path: 'about'/g)).toHaveLength(1);
    expect(router).toMatch(/path: 'about', \.\.\.publicRoute\(/);
  });

  it('is linked from the footer, and the footer link opens it', () => {
    renderWithProviders(
      <>
        <Routes>
          <Route path="/" element={<p>Home page</p>} />
          <Route path="/about" element={<AboutPage />} />
        </Routes>
        <Footer />
      </>,
      { config: ALL_ON },
    );
    const link = within(screen.getByRole('contentinfo')).getByRole('link', {
      name: 'About Gloviaa Mart',
    });
    expect(link).toHaveAttribute('href', '/about');
    fireEvent.click(link);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(PRODUCT_TAGLINE);
  });

  it('is linked from the header', () => {
    renderWithProviders(<Header />, { config: ALL_ON });
    expect(screen.getByRole('link', { name: 'About Gloviaa Mart' })).toHaveAttribute(
      'href',
      '/about',
    );
  });
});
